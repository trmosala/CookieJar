import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeBundledPlugins } from "./config.mjs";
import { checkPermissionConfig } from "./plugin.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async file => { try { return await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

export function installationDirectory(version, platform = process.platform, home = os.homedir(), local = process.env.LOCALAPPDATA) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "Invalid release version");
  if (platform === "win32") {
    assert.ok(local && path.win32.isAbsolute(local), "LOCALAPPDATA must be an absolute path");
    return path.win32.join(local, "CookieMonster", "plugins", "cookiejar-ae", version);
  }
  assert.equal(platform, "darwin", "Installer supports Windows and macOS");
  return path.posix.join(home, "Library", "Application Support", "CookieMonster", "plugins", "cookiejar-ae", version);
}

async function regularTree(directory, prefix = "") {
  assert.ok((await lstat(directory)).isDirectory(), `Expected real directory: ${directory}`);
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), info = await lstat(file);
    assert.ok(!info.isSymbolicLink(), `Symlink in installation input: ${name}`);
    // Finder may add this metadata after extraction or when viewing an installed version.
    if (name === ".DS_Store") { assert.ok(info.isFile(), "Expected regular file"); continue; }
    if (info.isDirectory()) entries.push(...await regularTree(file, prefix + name + "/"));
    else { assert.ok(info.isFile(), "Expected regular file"); entries.push(prefix + name); }
  }
  return entries;
}

async function realParents(file) {
  let current = path.resolve(file);
  while (true) {
    const info = await exists(current);
    if (info) assert.ok(!info.isSymbolicLink(), `Refusing redirected path: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function install({ release, config, apply = false, platform = process.platform, home = os.homedir(), local = process.env.LOCALAPPDATA }) {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+ is required");
  assert.ok(path.isAbsolute(config), "Pass the absolute configuration path actually loaded by OpenCode");
  release = path.resolve(release);
  const inventory = await regularTree(release);
  const sums = new Map();
  for (const line of (await readFile(path.join(release, "SHA256SUMS.txt"), "utf8")).split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/i.exec(line);
    assert.ok(match && inventory.includes(match[2]) && !sums.has(match[2]), "Invalid or duplicate release checksum entry");
    sums.set(match[2], match[1].toLowerCase());
  }
  assert.deepEqual([...sums.keys()].sort(), inventory.filter(file => file !== "SHA256SUMS.txt").sort(), "Incomplete release checksum inventory");
  const bytes = new Map();
  for (const [file, digest] of sums) {
    const data = await readFile(path.join(release, file));
    assert.equal(hash(data), digest, `Release hash mismatch: ${file}`);
    bytes.set(file, data);
  }
  const manifest = JSON.parse(bytes.get("build-manifest.json")?.toString() || "null");
  assert.equal(manifest?.schemaVersion, 1, "Missing build manifest");
  assert.equal(manifest.profile, "client", "Internal installer requires a client build");
  const target = installationDirectory(manifest.version, platform, home, local);
  const backend = manifest.artifacts.filter(item => item.path.startsWith("cm-ae/"));
  assert.deepEqual(backend.map(item => item.path).sort(), inventory.filter(file => file.startsWith("cm-ae/")).sort(), "Backend inventory mismatch");
  for (const file of ["plugin.mjs", "render-worker.mjs", "permissions.json"]) assert.ok(bytes.has("cm-ae/" + file), `Missing ${file}`);
  for (const item of backend) {
    assert.equal(hash(bytes.get(item.path)), item.sha256, `Build hash mismatch: ${item.path}`);
    assert.equal(bytes.get(item.path).length, item.bytes, `Build size mismatch: ${item.path}`);
  }
  await realParents(target);
  await realParents(config);
  const original = await readFile(config, "utf8");
  let parsed;
  try { parsed = JSON.parse(original); } catch { throw new Error("Configuration is not strict JSON. Preserve it and use the application's JSONC-aware configuration mechanism."); }
  const permissions = JSON.parse(bytes.get("cm-ae/permissions.json"));
  assert.equal(permissions.ae_execute, "ask", "Client policy must require script review");
  // Validate using the verified source package before creating the destination.
  const merged = await mergeBundledPlugins(parsed, [{ id: "cm-ae", path: path.join(release, "cm-ae", "plugin.mjs"), permissions }]);
  assert.ok(!merged.diagnostics.some(item => item.severity === "error"), "Plugin syntax or policy validation failed");
  const sourceUrl = pathToFileURL(await realpath(path.join(release, "cm-ae", "plugin.mjs"))).href;
  const targetUrl = pathToFileURL(path.join(target, "plugin.mjs")).href;
  const ownedRoot = path.dirname(target);
  const isOwned = value => {
    try {
      const candidate = value.startsWith("file:") ? fileURLToPath(value) : value;
      const relative = path.relative(ownedRoot, candidate).split(path.sep);
      return path.isAbsolute(candidate) && relative.length === 2 && relative[0] !== ".." && relative[1] === "plugin.mjs";
    } catch { return false; }
  };
  const hasInstalled = (parsed.plugin || []).some(entry => isOwned(Array.isArray(entry) ? entry[0] : entry));
  const plugin = [];
  let installed = false;
  for (const entry of merged.config.plugin) {
    const value = Array.isArray(entry) ? entry[0] : entry;
    let source = value === sourceUrl;
    try {
      const candidate = value.startsWith("file:") ? fileURLToPath(value) : value;
      if (path.isAbsolute(candidate)) source ||= pathToFileURL(await realpath(candidate)).href === sourceUrl;
    } catch { /* Preserve unrelated or unavailable plugin specifiers. */ }
    if (source && hasInstalled) continue;
    if (!source && !isOwned(value)) plugin.push(entry);
    else {
      assert.ok(!installed, "Multiple CookieJar registrations found; resolve them before installation");
      plugin.push(Array.isArray(entry) ? [targetUrl, entry[1]] : targetUrl);
      installed = true;
    }
  }
  merged.config.plugin = plugin;
  checkPermissionConfig(merged.config, undefined, { configure: true, requireReview: true });
  const output = JSON.stringify(merged.config, null, 2) + "\n";
  const changed = JSON.stringify(parsed) !== JSON.stringify(merged.config);
  const existing = await exists(target);
  if (existing) {
    assert.deepEqual(await regularTree(target), backend.map(item => item.path.slice(6)).sort(), "Existing version has different files; use a new release version");
    for (const item of backend) assert.equal(hash(await readFile(path.join(target, item.path.slice(6)))), item.sha256, "Existing version differs; use a new release version");
  }
  const result = { mode: apply ? "installed" : "preview", version: manifest.version, target, config, configChanged: changed, backendFilesVerified: backend.length, runtimeDirectory: process.env.CM_AE_DATA_DIR || path.join(home, ".cookiemonster-ae"), backendActivation: "pending application reload and live verification", panelConnection: "pending", pairingAndBinding: "pending", panelInstallation: "Install matching signed ZXP with the qualified extension manager" };
  if (!apply) return result;
  await mkdir(path.dirname(target), { recursive: true });
  const lock = path.join(path.dirname(target), ".install-lock");
  await mkdir(lock);
  let stage, temporary;
  try {
    if (!existing) {
      stage = path.join(path.dirname(target), ".install-" + randomUUID());
      await mkdir(stage);
      for (const item of backend) {
        const destination = path.join(stage, item.path.slice(6));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes.get(item.path), { flag: "wx" });
        assert.equal(hash(await readFile(destination)), item.sha256, "Installed file verification failed");
      }
      assert.equal(await exists(target), null, "Installation destination appeared concurrently");
      await rename(stage, target); stage = null;
    }
    if (changed) {
      assert.equal(await readFile(config, "utf8"), original, "Configuration changed during installation; retry after reviewing it");
      result.backup = config + ".before-cookiejar-" + randomUUID() + ".bak";
      await writeFile(result.backup, original, { flag: "wx", mode: 0o600 });
      temporary = config + ".cookiejar-" + randomUUID() + ".tmp";
      await writeFile(temporary, output, { flag: "wx", mode: 0o600 });
      assert.equal(await readFile(config, "utf8"), original, "Configuration changed before publication");
      await rename(temporary, config); temporary = null;
    }
    return result;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (temporary) await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args[0] === "--config" && args[1] && (args.length === 2 || args.length === 3 && args[2] === "--apply"), "Usage: node install.mjs --config ABSOLUTE_CONFIG.json [--apply]");
    console.log(JSON.stringify(await install({ release: path.dirname(fileURLToPath(import.meta.url)), config: args[1], apply: args[2] === "--apply" }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
