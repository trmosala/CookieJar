import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
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

test("extracted installer previews, applies, preserves config and verifies repeat runs", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "cookiejar-installer-"));
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
  // Native CLI is exercised on Windows; macOS path construction is tested above.
  const options = { release, config, local, home: base, platform: process.platform === "win32" ? "win32" : "darwin" };
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
