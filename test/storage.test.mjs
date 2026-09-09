import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createGrants, createCheckpoints, secureDirectory, secureWrite } from "../src/storage.mjs"
import { MAX_BYTES, retention } from "../src/storage-retention.mjs"
import { AEError, hash } from "../src/protocol.mjs"

const windows = process.platform === "win32"
const exec = promisify(execFile)
const binding = { sessionID: "session", bindingID: "binding" }
const typed = code => error => error instanceof AEError && error.code === code

async function fixture(t) {
  const base = windows ? path.join(os.tmpdir(), "opencode") : os.tmpdir()
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, "cm-storage-test-")))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projects = path.join(root, "projects")
  const dataDir = path.join(root, "data")
  await fs.mkdir(projects)
  await fs.mkdir(dataDir)
  const projectPath = path.join(projects, "Example.aep")
  await fs.writeFile(projectPath, Buffer.from("original project bytes\0\n"))
  const args = { projectPath, projectId: "project", planHash: "plan" }
  return { root, projects, dataDir, projectPath, args, store: createCheckpoints({ dataDir }) }
}

async function acl(file) {
  if (!windows) {
    const stat = await fs.stat(file)
    return { uid: stat.uid, mode: stat.mode & 0o777 }
  }
  const result = await exec(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command",
      "$a=Get-Acl -LiteralPath $env:CM_TEST_PATH;" +
      "@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;" +
      "sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
      "rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object {" +
      "@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow')}})}|ConvertTo-Json -Depth 4 -Compress"],
    { env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"), CM_TEST_PATH: file } })
  return JSON.parse(result.stdout)
}

async function rewriteManifest(file, changes) {
  const { manifestHash, ...manifest } = JSON.parse(await fs.readFile(file, "utf8"))
  Object.assign(manifest, changes)
  await fs.writeFile(file, JSON.stringify({ ...manifest, manifestHash: hash(manifest) }))
}

test("exact and recursive grants, read/write distinction, missing leaf and source immutability", async t => {
  const f = await fixture(t)
  const asset = path.join(f.projects, "asset.png")
  const nested = path.join(f.projects, "nested")
  const sibling = path.join(f.root, "projects-other")
  await fs.mkdir(nested)
  await fs.mkdir(sibling)
  const child = path.join(nested, "child.png")
  const outside = path.join(sibling, "outside.png")
  await fs.writeFile(asset, "asset")
  await fs.writeFile(child, "child")
  await fs.writeFile(outside, "outside")
  const before = await fs.readFile(asset)
  const grants = createGrants()
  await grants.grant({ ...binding, path: asset })
  assert.equal(await grants.check({ ...binding, path: asset }), await fs.realpath(asset))
  await assert.rejects(grants.check({ ...binding, path: child }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: asset, write: true }), typed("path_denied"))
  await grants.grant({ ...binding, path: f.projects })
  await assert.rejects(grants.check({ ...binding, path: child }), typed("path_denied"))
  await grants.grant({ ...binding, path: f.projects, recursive: true })
  assert.equal(await grants.check({ ...binding, path: child }), await fs.realpath(child))
  await assert.rejects(grants.check({ ...binding, path: outside }), typed("path_denied"))
  const output = path.join(nested, "new.aep")
  await assert.rejects(grants.check({ ...binding, path: output, write: true }), typed("path_denied"))
  await grants.grant({ ...binding, path: output, write: true })
  assert.equal(await grants.check({ ...binding, path: output, write: true }), output)
  await assert.rejects(fs.stat(output), { code: "ENOENT" })
  await assert.rejects(grants.check({ ...binding, path: output }), typed("path_unavailable"))
  await grants.grant({ ...binding, path: nested, recursive: true, write: true })
  assert.equal(await grants.check({ ...binding, path: path.join(nested, "second.aep"), write: true }), path.join(nested, "second.aep"))
  await assert.rejects(grants.check({ ...binding, path: path.join(nested, "absent", "x"), write: true }), typed("path_unavailable"))
  assert.deepEqual(await fs.readFile(asset), before)
})

test("nonrecursive directory grants allow only the folder and direct child files", async t => {
  const f = await fixture(t)
  const nested = path.join(f.projects, "nested")
  const sibling = path.join(f.root, "projects-other")
  await fs.mkdir(nested)
  await fs.mkdir(sibling)
  const child = path.join(f.projects, "asset.png")
  const grandchild = path.join(nested, "asset.png")
  const outside = path.join(sibling, "asset.png")
  for (const file of [child, grandchild, outside]) await fs.writeFile(file, "source asset")
  const before = await fs.readFile(child)
  const names = await fs.readdir(f.projects)
  const output = path.join(f.projects, "output.mov")
  const grants = createGrants()
  const readGrant = await grants.grant({ ...binding, path: f.projects })
  assert.equal(await grants.check({ ...binding, path: child }), child)
  assert.equal(readGrant.kind, "directory")
  assert.equal(readGrant.recursive, false)
  assert.equal(await grants.check({ ...binding, path: f.projects }), f.projects)
  await assert.rejects(grants.check({ ...binding, path: child, write: true }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: output, write: true }), typed("path_denied"))

  await grants.grant({ ...binding, path: f.projects, write: true })
  assert.equal(await grants.check({ ...binding, path: f.projects, write: true }), f.projects)
  assert.equal(await grants.check({ ...binding, path: child, write: true }), child)
  assert.equal(await grants.check({ ...binding, path: output, write: true }), output)
  await assert.rejects(grants.check({ ...binding, path: output }), typed("path_unavailable"))
  for (const write of [false, true]) {
    for (const file of [nested, grandchild, sibling, outside]) {
      await assert.rejects(grants.check({ ...binding, path: file, write }), typed("path_denied"))
    }
  }
  await assert.rejects(grants.check({ ...binding, path: path.join(nested, "new.mov"), write: true }), typed("path_denied"))
  assert.deepEqual(await fs.readFile(child), before)
  assert.deepEqual(await fs.readdir(f.projects), names)
  await assert.rejects(fs.stat(output), { code: "ENOENT" })

  // Private staging is the renderer's responsibility, not an implicit subtree grant.
  const stage = path.join(f.projects, ".cm-ae-stage-test")
  await fs.mkdir(stage)
  await assert.rejects(grants.check({ ...binding, path: stage, write: true }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: path.join(stage, "frame.png"), write: true }), typed("path_denied"))
  await grants.grant({ ...binding, path: f.projects, recursive: true, write: true })
  assert.equal(await grants.check({ ...binding, path: nested, write: true }), nested)
  assert.equal(await grants.check({ ...binding, path: grandchild }), grandchild)
})

test("exact-file grants capture kind and never authorize a parent, sibling or replacement directory", async t => {
  const f = await fixture(t)
  const grants = createGrants()
  const before = await fs.readFile(f.projectPath)
  const entry = await grants.grant({ ...binding, path: f.projectPath, write: true })
  assert.equal(entry.kind, "file")
  assert.equal(await grants.check({ ...binding, path: f.projectPath, write: true }), f.projectPath)
  await assert.rejects(grants.check({ ...binding, path: f.projects, write: true }), typed("path_denied"))
  const sibling = path.join(f.projects, "sibling.mov")
  await fs.writeFile(sibling, "keep")
  await assert.rejects(grants.check({ ...binding, path: sibling }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: sibling, write: true }), typed("path_denied"))
  await assert.rejects(grants.grant({ ...binding, path: f.projectPath, recursive: true }), typed("invalid_path"))
  const output = path.join(f.projects, "future.mov")
  assert.equal((await grants.grant({ ...binding, path: output, write: true })).kind, "file")
  assert.equal(await grants.check({ ...binding, path: output, write: true }), output)
  await fs.mkdir(output)
  await assert.rejects(grants.check({ ...binding, path: output, write: true }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: path.join(output, "child.mov"), write: true }), typed("path_denied"))

  const directory = path.join(f.projects, "was-directory")
  await fs.mkdir(directory)
  assert.equal((await grants.grant({ ...binding, path: directory, write: true })).kind, "directory")
  await fs.rmdir(directory)
  await fs.writeFile(directory, "replacement")
  await assert.rejects(grants.check({ ...binding, path: directory, write: true }), typed("path_denied"))
  assert.deepEqual(await fs.readFile(f.projectPath), before)
  assert.equal(await fs.readFile(sibling, "utf8"), "keep")
})

test("nonrecursive directory grants reject junction escapes and redirected granted roots", async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, "outside")
  const nested = path.join(f.projects, "nested")
  await fs.mkdir(outside)
  await fs.mkdir(nested)
  for (const directory of [outside, nested]) {
    await fs.writeFile(path.join(directory, "asset.png"), "keep")
  }
  const grants = createGrants()
  await grants.grant({ ...binding, path: f.projects, write: true })
  for (const [name, target] of [["escape", outside], ["deeper", nested]]) {
    const link = path.join(f.projects, name)
    await fs.symlink(target, link, windows ? "junction" : "dir")
    for (const write of [false, true]) {
      await assert.rejects(grants.check({ ...binding, path: link, write }), typed("path_denied"))
      await assert.rejects(grants.check({ ...binding, path: path.join(link, "asset.png"), write }), typed("path_denied"))
    }
    await assert.rejects(grants.check({ ...binding, path: path.join(link, "new.mov"), write: true }), typed("path_denied"))
  }
  const approved = path.join(f.root, "approved")
  await fs.mkdir(approved)
  await grants.grant({ ...binding, path: approved, write: true })
  await fs.rmdir(approved)
  await fs.symlink(outside, approved, windows ? "junction" : "dir")
  await assert.rejects(grants.check({ ...binding, path: approved, write: true }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: path.join(approved, "asset.png") }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: path.join(approved, "new.mov"), write: true }), typed("path_denied"))
  assert.equal(await fs.readFile(path.join(outside, "asset.png"), "utf8"), "keep")
})

test("nonrecursive directory grants canonicalize final symlinks without allowing outside or deeper files", async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, "outside.png")
  const nested = path.join(f.projects, "nested")
  await fs.mkdir(nested)
  const deeper = path.join(nested, "asset.png")
  await fs.writeFile(outside, "outside")
  await fs.writeFile(deeper, "deeper")
  const escape = path.join(f.projects, "escape.png")
  try { await fs.symlink(outside, escape, "file") } catch (error) {
    if (windows && error.code === "EPERM") return t.skip("File symlink creation requires Developer Mode or privilege")
    throw error
  }
  const deepLink = path.join(f.projects, "deeper.png")
  await fs.symlink(deeper, deepLink, "file")
  const grants = createGrants()
  await grants.grant({ ...binding, path: f.projects, write: true })
  for (const write of [false, true]) {
    for (const file of [escape, deepLink]) {
      await assert.rejects(grants.check({ ...binding, path: file, write }), typed("path_denied"))
    }
  }
  const safe = path.join(f.projects, "safe.aep")
  await fs.symlink(f.projectPath, safe, "file")
  assert.equal(await grants.check({ ...binding, path: safe }), f.projectPath)
  const dangling = path.join(f.projects, "dangling.png")
  await fs.symlink(path.join(f.root, "missing.png"), dangling, "file")
  await assert.rejects(grants.check({ ...binding, path: dangling, write: true }), typed("path_unavailable"))
  assert.equal(await fs.readFile(outside, "utf8"), "outside")
  assert.equal(await fs.readFile(deeper, "utf8"), "deeper")
})

test("nonrecursive directory grants revoked during child kind inspection stay denied", async t => {
  const f = await fixture(t)
  for (const sessionRelease of [false, true]) {
    for (const write of [false, true]) {
      const grants = createGrants()
      await grants.grant({ ...binding, path: f.projects, write: true })
      const entered = Promise.withResolvers()
      const resume = Promise.withResolvers()
      const lstat = fs.lstat.bind(fs)
      let calls = 0
      const mock = t.mock.method(fs, "lstat", async (file, ...args) => {
        const stat = await lstat(file, ...args)
        if (file === f.projectPath && ++calls === 2) {
          entered.resolve()
          await resume.promise
        }
        return stat
      })
      const check = grants.check({ ...binding, path: f.projectPath, write })
      const rejected = assert.rejects(check, typed("binding_expired"))
      await entered.promise
      grants.release(binding.sessionID, sessionRelease ? undefined : binding.bindingID)
      resume.resolve()
      await rejected
      mock.mock.restore()
    }
  }
})

test("project-parent reads, binding/session isolation and release, including release during grant", async t => {
  const f = await fixture(t)
  const grants = createGrants()
  assert.equal(await grants.check({ ...binding, path: f.projectPath, projectPath: f.projectPath }), f.projectPath)
  await assert.rejects(grants.check({ ...binding, path: f.root, projectPath: f.projectPath }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: f.projectPath, projectPath: f.projectPath, write: true }), typed("path_denied"))
  await grants.grant({ ...binding, path: f.projectPath })
  await assert.rejects(grants.check({ ...binding, sessionID: "other", path: f.projectPath }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, bindingID: "other", path: f.projectPath }), typed("path_denied"))
  grants.release(binding.sessionID, binding.bindingID)
  await assert.rejects(grants.check({ ...binding, path: f.projectPath, projectPath: f.projectPath }), typed("binding_expired"))
  await assert.rejects(grants.grant({ ...binding, path: f.projectPath }), typed("binding_expired"))
  const another = { sessionID: binding.sessionID, bindingID: "new" }
  await grants.grant({ ...another, path: f.projectPath })
  grants.release(binding.sessionID)
  await assert.rejects(grants.check({ ...another, path: f.projectPath }), typed("binding_expired"))
  const racing = createGrants()
  const pending = racing.grant({ ...binding, path: f.projectPath })
  racing.release(binding.sessionID, binding.bindingID)
  await assert.rejects(pending, typed("binding_expired"))
})

test("traversal, unavailable paths, UNC and Windows streams/device aliases fail with typed errors", async t => {
  const f = await fixture(t)
  const grants = createGrants()
  for (const input of ["relative.png", f.projects + path.sep + ".." + path.sep + "asset", f.projectPath + "\0"]) {
    await assert.rejects(grants.grant({ ...binding, path: input }), typed("invalid_path"))
  }
  for (const input of ["\\\\missing.invalid\\share\\asset.png", "//missing.invalid/share/asset.png", "\\\\?\\C:\\secret", "\\\\.\\NUL"]) {
    await assert.rejects(grants.check({ ...binding, path: input }), typed("path_unsupported"))
  }
  await assert.rejects(grants.grant({ ...binding, path: path.join(f.root, "absent") }), typed("path_unavailable"))
  await assert.rejects(grants.grant({ ...binding, path: f.projectPath, recursive: "yes" }), typed("invalid_payload"))
  if (windows) {
    for (const name of ["CON", "nul.txt", "COM1.aep", "LPT9", "asset.png:secret", "trailing.", "trailing ", "conout$", "bad?"]) {
      await assert.rejects(grants.check({ ...binding, path: path.join(f.projects, name), write: true }), typed("invalid_path"))
    }
  }
})

test("filesystem case rules use real paths rather than blanket lowercase", async t => {
  const f = await fixture(t)
  const file = path.join(f.projects, "MixedCase.png")
  await fs.writeFile(file, "one")
  const alternate = path.join(f.projects, "mixedcase.png")
  const grants = createGrants()
  await grants.grant({ ...binding, path: file })
  let alternateReal
  try { alternateReal = await fs.realpath(alternate) } catch (error) { if (error.code !== "ENOENT") throw error }
  if (alternateReal) {
    assert.equal(await grants.check({ ...binding, path: alternate }), await fs.realpath(file))
  } else {
    await fs.writeFile(alternate, "two")
    await assert.rejects(grants.check({ ...binding, path: alternate }), typed("path_denied"))
  }
})

test("junctions and parent symlinks cannot escape recursive grants or implicit project reads", async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, "outside")
  const link = path.join(f.projects, "escape")
  await fs.mkdir(outside)
  const secret = path.join(outside, "secret.aep")
  await fs.writeFile(secret, "outside")
  await fs.symlink(outside, link, windows ? "junction" : "dir")
  const grants = createGrants()
  await grants.grant({ ...binding, path: f.projects, recursive: true, write: true })
  await assert.rejects(grants.check({ ...binding, path: path.join(link, "secret.aep") }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: path.join(link, "new.aep"), write: true }), typed("path_denied"))
  const implicit = createGrants()
  await assert.rejects(implicit.check({ ...binding, path: path.join(link, "secret.aep"), projectPath: f.projectPath }), typed("path_denied"))
  const approved = path.join(f.projects, "approved")
  await fs.mkdir(approved)
  await grants.grant({ ...binding, path: approved, recursive: true })
  await fs.rmdir(approved)
  await fs.symlink(outside, approved, windows ? "junction" : "dir")
  await assert.rejects(grants.check({ ...binding, path: path.join(approved, "secret.aep") }), typed("path_denied"))
  assert.equal(await fs.readFile(secret, "utf8"), "outside")
})

test("final symlinks, including dangling output links, cannot escape a grant", async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, "outside.aep")
  const link = path.join(f.projects, "link.aep")
  await fs.writeFile(outside, "outside")
  try { await fs.symlink(outside, link, "file") } catch (error) {
    if (windows && error.code === "EPERM") return t.skip("File symlink creation requires Developer Mode or privilege")
    throw error
  }
  const grants = createGrants()
  await grants.grant({ ...binding, path: f.projects, recursive: true, write: true })
  await assert.rejects(grants.check({ ...binding, path: link }), typed("path_denied"))
  await assert.rejects(grants.check({ ...binding, path: link, write: true }), typed("path_denied"))
  await fs.unlink(outside)
  await assert.rejects(grants.check({ ...binding, path: link, write: true }), typed("path_unavailable"))
})

test("private storage verifies ownership and ACLs without altering unrelated parents", async t => {
  const f = await fixture(t)
  const before = await acl(f.root)
  const directory = path.join(f.root, "private")
  assert.equal(await secureDirectory(directory), directory)
  assert.equal(await secureDirectory(directory), directory)
  const file = path.join(directory, "descriptor.json")
  await secureWrite(file, "first")
  await secureWrite(file, "replacement")
  assert.equal(await fs.readFile(file, "utf8"), "replacement")
  assert.deepEqual(await acl(f.root), before)
  const directoryACL = await acl(directory)
  const fileACL = await acl(file)
  if (windows) {
    assert.equal(directoryACL.owner, directoryACL.sid)
    assert.equal(directoryACL.protected, true)
    assert.ok(directoryACL.rules.length > 0)
    assert.ok(directoryACL.rules.every(rule => rule.allow && rule.sid === directoryACL.sid))
    assert.equal(fileACL.owner, fileACL.sid)
    assert.ok(fileACL.rules.every(rule => rule.allow && rule.sid === fileACL.sid))
  } else {
    assert.deepEqual(directoryACL, { uid: process.getuid(), mode: 0o700 })
    assert.deepEqual(fileACL, { uid: process.getuid(), mode: 0o600 })
  }
  await assert.rejects(secureDirectory(f.projects), typed("storage_unsafe"))
  await assert.rejects(secureWrite(path.join(f.projects, "secret"), "no"), typed("storage_unsafe"))
  await assert.rejects(fs.stat(path.join(f.projects, "secret")), { code: "ENOENT" })
  const alias = path.join(f.root, "alias")
  await fs.symlink(directory, alias, windows ? "junction" : "dir")
  await assert.rejects(secureDirectory(alias), typed("storage_unsafe"))
  await assert.rejects(secureWrite(path.join(directory, ".cookiemonster-storage-owner.json"), "fake"), typed("storage_unsafe"))
  const hardlink = path.join(directory, "hardlink")
  await fs.link(f.projectPath, hardlink)
  await assert.rejects(secureWrite(hardlink, "destroy"), typed("storage_unsafe"))
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
})

test("checkpoints persist beside the project, verify bytes, survive restart, pin and remove", async t => {
  const f = await fixture(t)
  const before = await fs.readFile(f.projectPath)
  const originalStat = await fs.stat(f.projectPath)
  const manifest = await f.store.create(f.args)
  for (const key of ["id", "path", "projectId", "projectPath", "planHash", "createdAt", "size", "hash", "verified", "pinned", "storageMode"]) {
    assert.ok(Object.hasOwn(manifest, key), key)
  }
  assert.equal(path.dirname(manifest.path), path.join(f.projects, "CookieMonster Checkpoints"))
  assert.equal(manifest.storageMode, "project")
  assert.equal(manifest.hash, createHash("sha256").update(before).digest("hex"))
  assert.equal(manifest.size, before.length)
  assert.equal(manifest.verified, true)
  assert.deepEqual(await fs.readFile(f.projectPath), before)
  assert.equal((await fs.stat(f.projectPath)).mtimeMs, originalStat.mtimeMs)
  const restarted = createCheckpoints({ dataDir: f.dataDir })
  assert.deepEqual(await restarted.list("project"), [manifest])
  assert.deepEqual(await restarted.verify(manifest.id), manifest)
  assert.deepEqual(await restarted.list("other"), [])
  await restarted.pin(manifest.id, true)
  assert.equal((await createCheckpoints({ dataDir: f.dataDir }).list("project"))[0].pinned, true)
  await assert.rejects(restarted.remove(manifest.id), typed("checkpoint_in_use"))
  await restarted.pin(manifest.id, false)
  await restarted.remove(manifest.id)
  assert.deepEqual(await restarted.list("project"), [])
  await assert.rejects(fs.stat(manifest.path), { code: "ENOENT" })
  assert.deepEqual(await fs.readFile(f.projectPath), before)
})

test("retention prunes oldest unpinned copies, protects pins and isolates project identities", async t => {
  const f = await fixture(t)
  const pinned = await f.store.create({ ...f.args, pinned: true })
  const other = await f.store.create({ ...f.args, projectId: "other" })
  const created = []
  for (let i = 0; i < 12; i++) created.push(await f.store.create({ ...f.args, planHash: "plan-" + i }))
  const entries = await f.store.list("project")
  assert.equal(entries.filter(entry => !entry.pinned).length, 10)
  assert.ok(entries.some(entry => entry.id === pinned.id))
  assert.deepEqual(entries.filter(entry => !entry.pinned).map(entry => entry.id), created.slice(2).map(entry => entry.id))
  await assert.rejects(fs.stat(created[0].path), { code: "ENOENT" })
  assert.equal((await f.store.verify(other.id)).id, other.id)
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
  const oldest = created[2]
  await f.store.protect(oldest.id, "render-job")
  await f.store.create(f.args)
  assert.equal((await f.store.verify(oldest.id)).inUse, true)
  await assert.rejects(f.store.verify(created[3].id), typed("checkpoint_not_found"))
  await createCheckpoints({ dataDir: f.dataDir }).protect(oldest.id, "render-job", false)
  await f.store.create(f.args)
  await assert.rejects(f.store.verify(oldest.id), typed("checkpoint_not_found"))
  assert.equal((await f.store.verify(pinned.id)).pinned, true)
})

test("retention byte cap, exact boundary and pinned/in-use saturation", () => {
  const entry = (id, size, flags = {}) => ({ id, size, createdAt: id, pinned: false, ...flags })
  const entries = [entry("a", MAX_BYTES / 2), entry("b", MAX_BYTES / 2, { pinned: true })]
  assert.deepEqual(retention(entries), [])
  assert.deepEqual(retention(entries, { size: 1, pinned: false }).map(x => x.id), ["a"])
  const frozen = [entry("a", MAX_BYTES / 2, { pinned: true }), entry("b", MAX_BYTES / 2, { inUse: true })]
  assert.throws(() => retention(frozen, { size: 1, pinned: false }), typed("checkpoint_capacity"))
  assert.throws(() => retention([], { size: MAX_BYTES + 1, pinned: true }), typed("checkpoint_capacity"))
  const busy = Array.from({ length: 10 }, (_, i) => entry(String(i), 1, { inUse: true }))
  assert.throws(() => retention(busy, { size: 1, pinned: false }), typed("checkpoint_capacity"))
  assert.deepEqual(retention([entry("b", 5), entry("a", 5)], { size: MAX_BYTES - 5 }).map(x => x.id), ["a"])
})

test("fallback warns, persists and does not adopt or ACL an unrelated visible directory", async t => {
  const f = await fixture(t)
  const directory = path.join(f.projects, "CookieMonster Checkpoints")
  await fs.mkdir(directory)
  const sentinel = path.join(directory, "user-owned.txt")
  await fs.writeFile(sentinel, "keep")
  const before = await acl(directory)
  const manifest = await f.store.create(f.args)
  assert.equal(manifest.storageMode, "fallback")
  assert.match(manifest.warning, /will not travel with the project/)
  assert.equal(path.dirname(manifest.path), path.join(f.dataDir, "checkpoints"))
  assert.deepEqual(await acl(directory), before)
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep")
  assert.equal((await createCheckpoints({ dataDir: f.dataDir }).verify(manifest.id)).hash, manifest.hash)
})

test("corrupt manifest content and forged deletion paths fail closed on restart", async t => {
  const f = await fixture(t)
  const manifest = await f.store.create(f.args)
  const index = path.join(f.dataDir, "checkpoints", manifest.id + ".json")
  const original = await fs.readFile(index)
  await fs.writeFile(index, "{broken")
  const restarted = createCheckpoints({ dataDir: f.dataDir })
  assert.deepEqual(await restarted.list("project"), [])
  await assert.rejects(restarted.verify(manifest.id), typed("checkpoint_corrupt"))
  await assert.rejects(restarted.remove(manifest.id), typed("checkpoint_corrupt"))
  await assert.rejects(restarted.create(f.args), typed("checkpoint_corrupt"))
  await fs.writeFile(index, original)
  await rewriteManifest(index, { path: f.projectPath })
  await assert.rejects(restarted.remove(manifest.id), typed("checkpoint_corrupt"))
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
  await assert.rejects(restarted.remove("../project.aep"), typed("invalid_payload"))
  assert.deepEqual(await fs.readFile(manifest.path), await fs.readFile(f.projectPath))
})

test("checkpoint byte corruption blocks verify and restore without touching canonical source", async t => {
  const f = await fixture(t)
  const manifest = await f.store.create(f.args)
  await fs.writeFile(manifest.path, "corrupt copy")
  await assert.rejects(f.store.verify(manifest.id), typed("checkpoint_corrupt"))
  await assert.rejects(f.store.restore(manifest.id, { canonicalPath: f.projectPath }), typed("checkpoint_corrupt"))
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
})

test("restore exclusively publishes the canonical project and retains original and checkpoint", async t => {
  const f = await fixture(t)
  const manifest = await f.store.create(f.args)
  await fs.writeFile(f.projectPath, "new current project")
  const restored = await f.store.restore(manifest.id, { canonicalPath: f.projectPath })
  assert.equal(restored.path, f.projectPath)
  assert.equal(restored.recoveryCopy, false)
  assert.equal(await fs.readFile(restored.originalPath, "utf8"), "new current project")
  assert.deepEqual(await fs.readFile(f.projectPath), await fs.readFile(manifest.path))
  await f.store.remove(manifest.id)
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
})

test("failed canonical rename keeps current bytes and persists in-use recovery protection", async t => {
  const f = await fixture(t)
  const manifest = await f.store.create(f.args)
  await fs.writeFile(f.projectPath, "keep current bytes")
  const rename = fs.rename.bind(fs)
  const mock = t.mock.method(fs, "rename", async (source, destination) => {
    if (source === f.projectPath) throw Object.assign(new Error("locked"), { code: "EACCES" })
    return rename(source, destination)
  })
  const result = await f.store.restore(manifest.id, { canonicalPath: f.projectPath })
  mock.mock.restore()
  assert.deepEqual(result, { path: manifest.path, recoveryCopy: true, automationSuspended: true })
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "keep current bytes")
  assert.ok(!(await fs.readdir(f.projects)).some(name => name.startsWith(".cookiemonster-restore-")))
  const restarted = createCheckpoints({ dataDir: f.dataDir })
  await assert.rejects(restarted.remove(manifest.id), typed("checkpoint_in_use"))
  await assert.rejects(restarted.pin(manifest.id, false), typed("checkpoint_in_use"))
  assert.equal((await restarted.list("project"))[0].inUse, true)
})

test("failed copy and failed metadata publication preserve originals and leave no published checkpoint", async t => {
  const f = await fixture(t)
  const original = fs.open.bind(fs)
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.projectPath) throw Object.assign(new Error("unavailable"), { code: "EIO" })
    return original(file, ...args)
  })
  await assert.rejects(f.store.create(f.args), typed("storage_unavailable"))
  mock.mock.restore()
  assert.deepEqual(await f.store.list("project"), [])
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes\0\n")
  const rename = fs.rename.bind(fs)
  const publish = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination.endsWith(".json")) throw Object.assign(new Error("full"), { code: "ENOSPC" })
    return rename(source, destination)
  })
  await assert.rejects(f.store.create(f.args), typed("storage_unavailable"))
  publish.mock.restore()
  assert.deepEqual(await f.store.list("project"), [])
  const names = await fs.readdir(path.join(f.projects, "CookieMonster Checkpoints"))
  assert.deepEqual(names, [".cookiemonster-storage-owner.json"])
})

test("source changes during copy are detected without reverting the external edit", async t => {
  const f = await fixture(t)
  const open = fs.open.bind(fs)
  let changed = false
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === f.projectPath && !changed) {
      changed = true
      await fs.writeFile(f.projectPath, "changed by the host")
    }
    return handle
  })
  await assert.rejects(f.store.create(f.args), typed("checkpoint_changed"))
  mock.mock.restore()
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "changed by the host")
  assert.deepEqual(await f.store.list("project"), [])
})

test("restore rejects redirected parents and cannot overwrite another canonical project", async t => {
  const f = await fixture(t)
  const manifest = await f.store.create(f.args)
  const unrelated = path.join(f.root, "other.aep")
  await fs.writeFile(unrelated, "not yours")
  assert.deepEqual(await f.store.restore(manifest.id, { canonicalPath: unrelated }), {
    path: manifest.path, recoveryCopy: true, automationSuspended: true,
  })
  assert.equal(await fs.readFile(unrelated, "utf8"), "not yours")
  const outside = path.join(f.root, "outside")
  await fs.mkdir(outside)
  const redirected = path.join(outside, path.basename(f.projectPath))
  await fs.writeFile(redirected, "outside")
  // Keep the checkpoint in fallback storage so its parent survives the redirect.
  const g = await fixture(t)
  await fs.writeFile(path.join(g.projects, "CookieMonster Checkpoints"), "block visible storage")
  const fallback = await g.store.create(g.args)
  const moved = path.join(g.root, "moved-projects")
  await fs.rename(g.projects, moved)
  await fs.symlink(outside, g.projects, windows ? "junction" : "dir")
  assert.equal((await g.store.restore(fallback.id, { canonicalPath: g.projectPath })).recoveryCopy, true)
  assert.equal(await fs.readFile(redirected, "utf8"), "outside")
})

test("store instances serialize simultaneous creates and remove waits for active verification", async t => {
  const f = await fixture(t)
  const other = createCheckpoints({ dataDir: f.dataDir })
  const [first, second] = await Promise.all([f.store.create(f.args), other.create(f.args)])
  assert.notEqual(first.id, second.id)
  const verified = f.store.verify(first.id)
  const removed = other.remove(first.id)
  assert.equal((await verified).id, first.id)
  await removed
  assert.deepEqual((await other.list("project")).map(entry => entry.id), [second.id])
})

test("manifest queue reserves invocation order before asynchronous path resolution across instances", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const alias = path.join(f.root, "data-alias")
  await fs.symlink(f.dataDir, alias, windows ? "junction" : "dir")
  const other = createCheckpoints({ dataDir: alias })
  const realpath = fs.realpath.bind(fs)
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  let paused = false
  const mock = t.mock.method(fs, "realpath", async (file, ...args) => {
    if (file === f.dataDir && !paused) {
      paused = true
      entered.resolve()
      await resume.promise
    }
    return realpath(file, ...args)
  })
  const pin = f.store.pin(saved.id, true)
  await entered.promise
  let removalSettled = false
  const removal = other.remove(saved.id).then(
    () => ({ removed: true }),
    error => ({ error }),
  ).finally(() => { removalSettled = true })
  // Give a wrongly unqueued call enough time to finish its real Windows ACL checks.
  await new Promise(resolve => setTimeout(resolve, 3000))
  const overtook = removalSettled
  resume.resolve()
  const [pinResult, removalResult] = await Promise.allSettled([pin, removal])
  mock.mock.restore()
  assert.equal(overtook, false, "delete overtook the earlier pin during realpath")
  assert.equal(pinResult.status, "fulfilled")
  assert.equal(removalResult.status, "fulfilled")
  assert.equal(removalResult.value.error?.code, "checkpoint_in_use")
  assert.equal((await other.verify(saved.id)).pinned, true)
  await other.pin(saved.id, false)
  const verified = f.store.verify(saved.id)
  const removed = other.remove(saved.id)
  assert.equal((await verified).id, saved.id)
  await removed
  assert.deepEqual(await f.store.list(f.args.projectId), [])
})

test("snapshot verification rejects a premature EOF even if metadata remains unchanged", async t => {
  const f = await fixture(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 31, 73)
  bytes[bytes.length - 1] = 99
  await fs.writeFile(f.projectPath, bytes)
  const open = fs.open.bind(fs)
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === f.projectPath) {
      const read = handle.read.bind(handle)
      t.mock.method(handle, "read", async (buffer, offset, length, position) => {
        if (position >= 1024 * 1024) return { bytesRead: 0, buffer }
        return read(buffer, offset, length, position)
      })
    }
    return handle
  })
  await assert.rejects(f.store.create(f.args), typed("checkpoint_changed"))
  mock.mock.restore()
  assert.deepEqual(await f.store.list(f.args.projectId), [])
  assert.deepEqual(await fs.readFile(f.projectPath), bytes)
})

test("owner-keyed protection balances concurrent jobs across instances and preserves current user pins", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const other = createCheckpoints({ dataDir: f.dataDir })
  await Promise.all([
    f.store.protect(saved.id, "render-a"),
    other.protect(saved.id, "render-b"),
    other.protect(saved.id, "render-a"),
  ])
  let current = await other.verify(saved.id)
  assert.equal(current.pinned, false)
  assert.equal(current.inUse, true)
  assert.deepEqual(current.protectionOwners, ["render-a", "render-b"])
  await assert.rejects(other.remove(saved.id), typed("checkpoint_in_use"))
  const restarted = createCheckpoints({ dataDir: f.dataDir })
  await restarted.protect(saved.id, "render-a", false)
  await restarted.protect(saved.id, "render-a", false)
  await restarted.protect(saved.id, "unknown-owner", false)
  current = await restarted.verify(saved.id)
  assert.deepEqual(current.protectionOwners, ["render-b"])
  assert.equal(current.inUse, true)
  // A successful restore must release only its own temporary hold.
  await restarted.restore(saved.id, { canonicalPath: f.projectPath })
  assert.deepEqual((await f.store.verify(saved.id)).protectionOwners, ["render-b"])
  // A user pin added during rendering must survive job completion.
  await f.store.pin(saved.id, true)
  current = await restarted.protect(saved.id, "render-b", false)
  assert.equal(current.inUse, false)
  assert.equal(current.pinned, true)
  await assert.rejects(restarted.remove(saved.id), typed("checkpoint_in_use"))
  await f.store.protect(saved.id, "render-c")
  assert.equal((await f.store.protect(saved.id, "render-c", false)).pinned, true)
  await f.store.pin(saved.id, false)
  await f.store.protect(saved.id, "render-d")
  assert.equal((await other.protect(saved.id, "render-d", false)).pinned, false)
  await other.remove(saved.id)
  assert.equal(await other.protect(saved.id, "render-d", false), null)
})

test("failed protection release remains durable and recovery protection can be explicitly balanced", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  await f.store.protect(saved.id, "render-job")
  const rename = fs.rename.bind(fs)
  const mock = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(path.dirname(saved.path), saved.id + ".json")) {
      throw Object.assign(new Error("locked manifest"), { code: "EACCES" })
    }
    return rename(source, destination)
  })
  await assert.rejects(f.store.protect(saved.id, "render-job", false), typed("storage_unavailable"))
  mock.mock.restore()
  const restarted = createCheckpoints({ dataDir: f.dataDir })
  assert.equal((await restarted.verify(saved.id)).inUse, true)
  await restarted.protect(saved.id, "render-job", false)
  await fs.writeFile(f.projectPath, "keep current")
  const failure = t.mock.method(fs, "rename", async (source, destination) => {
    if (source === f.projectPath) throw Object.assign(new Error("locked"), { code: "EACCES" })
    return rename(source, destination)
  })
  assert.equal((await restarted.restore(saved.id, { canonicalPath: f.projectPath })).recoveryCopy, true)
  failure.mock.restore()
  await f.store.protect(saved.id, "render-job")
  await f.store.protect(saved.id, "render-job", false)
  assert.deepEqual((await f.store.verify(saved.id)).protectionOwners, ["recovery"])
  await assert.rejects(f.store.remove(saved.id), typed("checkpoint_in_use"))
  await f.store.protect(saved.id, "recovery", false)
  await f.store.remove(saved.id)
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "keep current")
})

test("corrupt protection metadata cannot authorize deletion and legacy recovery holds stay protected", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const metadata = path.join(path.dirname(saved.path), saved.id + ".json")
  await rewriteManifest(metadata, { inUse: true })
  const other = createCheckpoints({ dataDir: f.dataDir })
  await other.protect(saved.id, "render-job")
  await other.protect(saved.id, "render-job", false)
  assert.deepEqual((await other.verify(saved.id)).protectionOwners, ["recovery"])
  await rewriteManifest(metadata, { inUse: false, protectionOwners: ["recovery"] })
  await assert.rejects(other.remove(saved.id), typed("checkpoint_corrupt"))
  await assert.rejects(other.protect(saved.id, "recovery", false), typed("checkpoint_corrupt"))
  assert.deepEqual(await fs.readFile(saved.path), await fs.readFile(f.projectPath))
  await rewriteManifest(metadata, { inUse: true, protectionOwners: ["recovery", "recovery"] })
  await assert.rejects(other.verify(saved.id), typed("checkpoint_corrupt"))
  await rewriteManifest(metadata, { inUse: true, protectionOwners: ["recovery"] })
  await other.protect(saved.id, "recovery", false)
  await other.remove(saved.id)
})

test("restore verifies the entire staged snapshot and preserves the current original on a corrupt tail", async t => {
  const f = await fixture(t)
  const snapshot = Buffer.alloc(2 * 1024 * 1024 + 31, 17)
  snapshot[snapshot.length - 1] = 99
  await fs.writeFile(f.projectPath, snapshot)
  const saved = await f.store.create(f.args)
  const current = Buffer.from("current project that must survive")
  await fs.writeFile(f.projectPath, current)
  const open = fs.open.bind(fs)
  let corrupted = false
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (!corrupted && path.basename(file).startsWith(".cookiemonster-restore-") && args[0] !== "wx") {
      corrupted = true
      const handle = await open(file, "r+")
      try { await handle.write(Buffer.from([0]), 0, 1, snapshot.length - 1) }
      finally { await handle.close() }
    }
    return open(file, ...args)
  })
  assert.deepEqual(await f.store.restore(saved.id, { canonicalPath: f.projectPath }), {
    path: saved.path, recoveryCopy: true, automationSuspended: true,
  })
  mock.mock.restore()
  assert.equal(corrupted, true)
  assert.deepEqual(await fs.readFile(f.projectPath), current)
  assert.deepEqual(await fs.readFile(saved.path), snapshot)
  assert.ok(!(await fs.readdir(f.projects)).some(name => name.startsWith(".cookiemonster-restore-")))
  const damaged = Buffer.from(snapshot)
  damaged[damaged.length - 1] = 0
  await fs.writeFile(saved.path, damaged)
  await assert.rejects(f.store.verify(saved.id), typed("checkpoint_corrupt"))
  await assert.rejects(f.store.restore(saved.id, { canonicalPath: f.projectPath }), typed("checkpoint_corrupt"))
  assert.deepEqual(await fs.readFile(f.projectPath), current)
  await fs.writeFile(saved.path, snapshot)
  const restored = await f.store.restore(saved.id, { canonicalPath: f.projectPath })
  assert.equal(restored.path, f.projectPath)
  assert.equal(restored.recoveryCopy, false)
  assert.deepEqual(await fs.readFile(restored.originalPath), current)
  assert.deepEqual(await fs.readFile(f.projectPath), snapshot)
})

test("restore retains last-moment original edits and never clobbers a new destination", async t => {
  for (const mode of ["before_move", "before_publish", "publish_failed"]) {
    const f = await fixture(t)
    const saved = await f.store.create(f.args)
    await fs.writeFile(f.projectPath, "approved current")
    const expectedDestination = { ...await fs.stat(f.projectPath),
      hash: createHash("sha256").update("approved current").digest("hex") }
    const rename = fs.rename.bind(fs), link = fs.link.bind(fs)
    const moving = t.mock.method(fs, "rename", async (source, destination) => {
      if (source === f.projectPath && mode === "before_move") await fs.writeFile(source, "last moment edit")
      return rename(source, destination)
    })
    const publishing = t.mock.method(fs, "link", async (source, destination) => {
      if (path.basename(source).startsWith(".cookiemonster-restore-")) {
        if (mode === "before_publish") await fs.writeFile(destination, "new destination")
        if (mode === "publish_failed") throw Object.assign(new Error("publication denied"), { code: "EACCES" })
      }
      return link(source, destination)
    })
    const result = await f.store.restore(saved.id, { canonicalPath: f.projectPath,
      expectedCheckpoint: saved, expectedDestination })
    moving.mock.restore()
    publishing.mock.restore()
    assert.equal(result.recoveryCopy, true, mode)
    assert.equal(await fs.readFile(result.originalPath, "utf8"),
      mode === "before_move" ? "last moment edit" : "approved current")
    assert.equal(await fs.readFile(f.projectPath, "utf8"),
      mode === "before_move" ? "last moment edit" : mode === "before_publish" ? "new destination" : "approved current")
    assert.equal((await f.store.verify(saved.id)).inUse, true)
  }
})

test("restore revalidates exact approved source and destination before changing either", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const before = await fs.readFile(f.projectPath)
  for (const code of ["stale_fingerprint", "outcome_uncertain", "proposal_expired"]) {
    await assert.rejects(f.store.restore(saved.id, { canonicalPath: f.projectPath,
      expectedCheckpoint: saved, beforeReplace: async () => { throw new AEError(code, "Host guard failed") } }), { code })
    assert.deepEqual(await fs.readFile(f.projectPath), before)
    assert.ok(!(await fs.readdir(f.projects)).some(name => name.startsWith(".cookiemonster-original-")))
  }
  await assert.rejects(f.store.restore(saved.id, { canonicalPath: f.projectPath,
    expectedCheckpoint: { ...saved, createdAt: new Date(0).toISOString() } }), { code: "checkpoint_changed" })
  const expectedDestination = { ...await fs.stat(f.projectPath), hash: saved.hash }
  await fs.writeFile(f.projectPath, "external edit before queued restore")
  const result = await f.store.restore(saved.id, { canonicalPath: f.projectPath,
    expectedCheckpoint: saved, expectedDestination })
  assert.equal(result.recoveryCopy, true)
  assert.equal(result.cause, "checkpoint_changed")
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "external edit before queued restore")
  assert.deepEqual(await fs.readFile(saved.path), before)
})

test("restore preserves a concurrent host edit instead of replacing it", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const open = fs.open.bind(fs)
  let changed = false
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (!changed && path.basename(file).startsWith(".cookiemonster-restore-")) {
      changed = true
      await fs.writeFile(f.projectPath, "host edit during restore")
    }
    return open(file, ...args)
  })
  const result = await f.store.restore(saved.id, { canonicalPath: f.projectPath })
  mock.mock.restore()
  assert.equal(changed, true)
  assert.equal(result.recoveryCopy, true)
  assert.equal(result.automationSuspended, true)
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "host edit during restore")
  assert.equal((await f.store.verify(saved.id)).hash, saved.hash)
})

test("failed private-file publication preserves previous credentials and cleans its temporary", async t => {
  const f = await fixture(t)
  const directory = await secureDirectory(path.join(f.root, "private"))
  const file = path.join(directory, "credentials.json")
  await secureWrite(file, "old credential")
  const rename = fs.rename.bind(fs)
  const mock = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === file) throw Object.assign(new Error("locked"), { code: "EACCES" })
    return rename(source, destination)
  })
  await assert.rejects(secureWrite(file, "new credential"), typed("storage_unavailable"))
  mock.mock.restore()
  assert.equal(await fs.readFile(file, "utf8"), "old credential")
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith(".tmp")))
  await assert.rejects(secureWrite(path.join(directory, ".COOKIEMONSTER-STORAGE-OWNER.JSON"), "bad"), typed("storage_unsafe"))
})

test("project-side manifest publication failure falls back with a verified copy", async t => {
  const f = await fixture(t)
  const directory = path.join(f.projects, "CookieMonster Checkpoints")
  const rename = fs.rename.bind(fs)
  const mock = t.mock.method(fs, "rename", async (source, destination) => {
    if (path.dirname(destination) === directory && destination.endsWith(".json")) {
      throw Object.assign(new Error("read-only cloud folder"), { code: "EROFS" })
    }
    return rename(source, destination)
  })
  const manifest = await f.store.create(f.args)
  mock.mock.restore()
  assert.equal(manifest.storageMode, "fallback")
  assert.match(manifest.warning, /will not travel/)
  assert.equal((await f.store.verify(manifest.id)).hash, manifest.hash)
  assert.deepEqual(await fs.readdir(directory), [".cookiemonster-storage-owner.json"])
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes" + String.fromCharCode(0, 10))
})

test("size cap rejects before reading or pruning existing checkpoints", async t => {
  const f = await fixture(t)
  const saved = await f.store.create(f.args)
  const lstat = fs.lstat.bind(fs)
  const mock = t.mock.method(fs, "lstat", async (file, ...args) => {
    const stat = await lstat(file, ...args)
    if (file === f.projectPath) stat.size = MAX_BYTES + 1
    return stat
  })
  await assert.rejects(f.store.create(f.args), typed("checkpoint_capacity"))
  mock.mock.restore()
  assert.equal((await f.store.verify(saved.id)).id, saved.id)
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "original project bytes" + String.fromCharCode(0, 10))
})
