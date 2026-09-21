import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install, installationDirectory } from "../src/install.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");
test("installation paths use the full release version on Windows and macOS", () => {
  assert.equal(installationDirectory("1.2.3-beta.1", "win32", "C:\\Users\\Test", "C:\\Users\\Test\\AppData\\Local"), "C:\\Users\\Test\\AppData\\Local\\CookieMonster\\plugins\\cookiejar-ae\\1.2.3-beta.1");
  assert.equal(installationDirectory("1.2.3", "darwin", "/Users/test"), "/Users/test/Library/Application Support/CookieMonster/plugins/cookiejar-ae/1.2.3");
  assert.throws(() => installationDirectory("../../bad"));
});

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "cookiejar-installer-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const release = path.join(base, "release"), config = path.join(base, "opencode.json"), local = path.join(base, "local");
  await mkdir(path.join(release, "cm-ae"), { recursive: true });
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync("bun", ["build", "./src/install.mjs", "--target=node", "--format=esm", "--packages=bundle", "--env=disable", "--define", "COOKIEJAR_CLIENT_BUILD=true", "--outfile", path.join(release, "install.mjs")], { cwd: root });
  const data = new Map([
    ["install.mjs", await readFile(path.join(release, "install.mjs"))],
    ["cm-ae/plugin.mjs", Buffer.from("export default {};\n")],
    ["cm-ae/render-worker.mjs", Buffer.from("export {};\n")],
    ["cm-ae/permissions.json", Buffer.from('{"ae_execute":"ask","ae_inspect":"allow"}')],
    ["cm-ae/LICENSE.txt", Buffer.from("fixture license")],
  ]);
  const manifest = { schemaVersion: 1, version: "1.2.3", profile: "client", artifacts: [...data].filter(([name]) => name.startsWith("cm-ae/")).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })) };
  data.set("build-manifest.json", Buffer.from(JSON.stringify(manifest)));
  for (const [name, bytes] of data) await writeFile(path.join(release, name), bytes);
  await writeFile(path.join(release, "SHA256SUMS.txt"), [...data].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join("\r\n") + "\r\n");
  const original = JSON.stringify({ plugin: [["other-plugin", { option: true }]], permission: { ae_execute: "deny", unrelated: "ask" }, mcp: { other: { enabled: true } } });
  await writeFile(config, original);
  const options = { release, config, local, home: base, platform: process.platform === "win32" ? "win32" : "darwin" };
  return { base, release, config, local, original, options };
}

test("extracted installer previews, applies, preserves config and verifies repeat runs", async t => {
  const { base, release, config, local, original, options } = await fixture(t);
  const preview = await install(options);
  assert.equal(preview.mode, "preview");
  await assert.rejects(access(preview.target));
  assert.equal(await readFile(config, "utf8"), original);
  const applied = await install({ ...options, apply: true });
  assert.equal(await readFile(applied.backup, "utf8"), original);
  const merged = JSON.parse(await readFile(config));
  assert.deepEqual(merged.mcp, JSON.parse(original).mcp);
  assert.deepEqual(merged.plugin[0], ["other-plugin", { option: true }]);
  assert.equal(merged.permission.ae_execute, "deny");
  assert.equal(merged.permission.ae_inspect, "allow");
  assert.equal((await install({ ...options, apply: true })).configChanged, false);
  if (process.platform === "win32") {
    const result = JSON.parse(execFileSync(process.execPath, [path.join(release, "install.mjs"), "--config", config, "--apply"], { cwd: base, env: { ...process.env, LOCALAPPDATA: local }, encoding: "utf8" }));
    assert.equal(result.configChanged, false);
    assert.equal(result.mode, "installed");
  }
  const prior = path.join(path.dirname(applied.target), "1.2.2", "plugin.mjs");
  merged.plugin[1] = [pathToFileURL(prior).href, { keep: true }];
  await writeFile(config, JSON.stringify(merged));
  await install({ ...options, apply: true });
  assert.deepEqual(JSON.parse(await readFile(config)).plugin[1], [pathToFileURL(path.join(applied.target, "plugin.mjs")).href, { keep: true }]);
  await writeFile(config, JSON.stringify({ ...JSON.parse(original), permission: { ae_execute: "ask", ae_restore: "allow" } }));
  await assert.rejects(install({ ...options, apply: true }), /requires ask or deny/);
  await writeFile(config, original);
  await writeFile(path.join(applied.target, "plugin.mjs"), "changed");
  await assert.rejects(install({ ...options, apply: true }), /Existing version differs/);
  await writeFile(config, '{ // JSONC\n}');
  await assert.rejects(install(options), /not strict JSON/);
  await writeFile(config, original);
  await writeFile(path.join(release, "cm-ae", "plugin.mjs"), "tampered");
  await assert.rejects(install(options), /Release hash mismatch/);
});

test("Finder metadata is ignored without relaxing package verification", async t => {
  const { release, config, original, options } = await fixture(t);
  for (const directory of [release, path.join(release, "cm-ae")])
    await writeFile(path.join(directory, ".DS_Store"), "Finder metadata");
  const preview = await install(options);
  assert.equal(preview.mode, "preview");
  assert.equal(await readFile(config, "utf8"), original);
  await assert.rejects(access(preview.target));
  const applied = await install({ ...options, apply: true });
  await assert.rejects(access(path.join(applied.target, ".DS_Store")));
  await writeFile(path.join(applied.target, ".DS_Store"), "Finder metadata");
  assert.equal((await install({ ...options, apply: true })).configChanged, false);
  for (const name of [".unexpected", ".DS_Store.js", "cm-ae/extra.mjs", "__MACOSX/extra"]) {
    const file = path.join(release, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "unexpected");
    await assert.rejects(install(options), /Incomplete release checksum inventory/);
    await rm(file);
  }
  await writeFile(path.join(release, "cm-ae", "plugin.mjs"), "tampered");
  await assert.rejects(install(options), /Release hash mismatch/);
});

test("metadata names cannot hide directories or symlinks", async t => {
  const { base, release, options } = await fixture(t);
  const metadata = path.join(release, ".DS_Store");
  await mkdir(metadata);
  await assert.rejects(install(options), /Expected regular file/);
  await rm(metadata, { recursive: true });
  if (process.platform !== "win32") {
    await symlink(path.join(release, "cm-ae", "plugin.mjs"), metadata);
    await assert.rejects(install(options), /Symlink in installation input/);
    await rm(metadata);
    const redirectedConfig = path.join(base, "linked-config.json");
    await symlink(options.config, redirectedConfig);
    await assert.rejects(install({ ...options, config: redirectedConfig }), /Refusing redirected path/);
    const redirectedRelease = path.join(base, "linked-release");
    await symlink(release, redirectedRelease);
    await assert.rejects(install({ ...options, release: redirectedRelease }), /Expected real directory/);
  }
});

test("aliased release parents always register the installed backend", async t => {
  const { base, release, config, original, options } = await fixture(t);
  const alias = path.join(base, "parent alias");
  await symlink(base, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasedRelease = path.join(alias, path.basename(release));
  const target = installationDirectory("1.2.3", options.platform, base, options.local);
  const targetUrl = pathToFileURL(path.join(target, "plugin.mjs")).href;
  const source = path.join(aliasedRelease, "cm-ae", "plugin.mjs");
  const prior = path.join(path.dirname(target), "1.2.2", "plugin.mjs");
  for (const [name, entry] of [
    ["fresh", null],
    ["upgrade", [pathToFileURL(prior).href, { keep: true }]],
    ["extracted path", [source, { keep: true }]],
    ["extracted URL", [pathToFileURL(source).href, { keep: true }]],
  ]) {
    await t.test(name, async () => {
      const input = JSON.parse(original);
      if (entry) input.plugin.push(entry);
      await writeFile(config, JSON.stringify(input));
      const result = await install({ ...options, release: aliasedRelease, apply: true });
      const installed = JSON.parse(await readFile(config));
      assert.equal(result.target, target);
      assert.deepEqual(installed.plugin, [input.plugin[0], entry ? [targetUrl, { keep: true }] : targetUrl]);
      assert.equal((await install({ ...options, release: aliasedRelease, apply: true })).configChanged, false);
    });
  }
});

test("macOS bundled installer CLI runs through a symlinked parent", { skip: process.platform !== "darwin" }, async t => {
  const { base, release, config, options } = await fixture(t);
  const alias = path.join(base, "CLI alias");
  await symlink(base, alias, "dir");
  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(alias, path.basename(release), "install.mjs"), "--config", config,
  ], { env: { ...process.env, HOME: base }, encoding: "utf8" }));
  assert.equal(result.mode, "preview");
  assert.equal(result.target, installationDirectory("1.2.3", "darwin", base));
  await assert.rejects(access(result.target));
  assert.equal(result.configChanged, true);
});
