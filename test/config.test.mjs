import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build, files } from "../scripts/build.mjs";
import { verifyBuild } from "../scripts/verify-build.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AE_PERMISSIONS, mergeBundledPlugins } from "../src/config.mjs";

const exec = promisify(execFile);

test("bundled config preserves browser entries/policy, isolates invalid artifacts, and never executes plugins", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cm-ae-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "plugin with spaces.mjs");
  const invalid = join(dir, "invalid.mjs");
  await writeFile(path, 'throw new Error("MUST NOT RUN"); export default {};\n');
  await writeFile(invalid, "export default (;\n");
  const browser = ["file:///browser.mjs", { enabled: true }];
  const original = {
    plugin: [browser, "@example/other"],
    permission: { browser_click: "ask", ae_execute: "deny", "*": "ask", browser_read_state: "allow" },
    unrelated: { keep: true },
  };
  const before = structuredClone(original);
  const artifact = { id: "ae", path, permissions: AE_PERMISSIONS };
  const result = await mergeBundledPlugins(original, [
    { ...artifact, id: "missing", path: join(dir, "missing.mjs"), optional: true },
    { ...artifact, id: "broken", path: invalid, optional: true },
    { ...artifact, id: "relative", path: "./plugin.mjs", optional: true },
    artifact,
  ]);
  assert.deepEqual(original, before);
  assert.deepEqual(result.config.plugin, [browser, "@example/other", pathToFileURL(await realpath(path)).href]);
  assert.equal(result.config.permission.browser_click, "ask");
  assert.equal(result.config.permission.browser_read_state, "allow");
  assert.equal(result.config.permission.ae_execute, "deny");
  assert.deepEqual(Object.keys(result.config.permission).slice(-4), Object.keys(original.permission));
  assert.deepEqual(result.diagnostics.map(({ severity, code }) => [severity, code]), [
    ["warning", "ARTIFACT_UNAVAILABLE"], ["warning", "ARTIFACT_SYNTAX"], ["warning", "INVALID_ARTIFACT"],
  ]);
  assert.deepEqual((await mergeBundledPlugins(result.config, [artifact])).config, result.config);
  assert.equal((await mergeBundledPlugins({ permission: "deny" }, [artifact])).config.permission, "deny");
  assert.equal((await mergeBundledPlugins({ permission: "ask" }, [artifact])).config.permission, "ask");
  const failed = await mergeBundledPlugins(original, [{ ...artifact, path: invalid }]);
  assert.equal(failed.config, original);
  assert.equal(failed.diagnostics[0].severity, "error");
  await assert.rejects(mergeBundledPlugins({ plugin: {} }, []), TypeError);
  const defaults = (await mergeBundledPlugins({}, [artifact])).config.permission;
  assert.equal(defaults.ae_inspect, "allow");
  assert.equal(defaults.ae_execute, "allow");
  assert.equal(defaults.ae_templates, "ask");
  assert.equal(defaults.ae_render_list, "allow");
  assert.equal(defaults.ae_render_recover, "ask");
  assert.equal(defaults.ae_render_retire, "ask");
  const renderPolicy = { ae_templates: "deny", ae_render_list: "ask", ae_render_recover: "deny", ae_render_retire: "deny" };
  const overridden = await mergeBundledPlugins({ permission: renderPolicy }, [artifact]);
  for (const [name, value] of Object.entries(renderPolicy)) assert.equal(overridden.config.permission[name], value);
  for (const name of ["ae_propose", "ae_raw_enable", "ae_raw_propose", "ae_raw_execute"])
    assert.equal(Object.hasOwn(defaults, name), false);

  const input = join(dir, "input.json");
  const output = join(dir, "output.json");
  await writeFile(input, JSON.stringify(original));
  const cli = fileURLToPath(new URL("../scripts/merge-config.mjs", import.meta.url));
  await exec(process.execPath, [cli, input, path, output]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result.config);
  await assert.rejects(exec(process.execPath, [cli, input, path, output]));
  await assert.rejects(exec(process.execPath, [cli, input, invalid, join(dir, "bad-output.json")]));
  await assert.rejects(readFile(join(dir, "bad-output.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(input, "utf8")), before);
});

test("multiple bundles preserve options through path aliases and omit failed optional defaults", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cm-ae-multiple-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["cm-browser", "cm-ae"]) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, "plugin.mjs"), 'throw new Error("MUST NOT RUN");\n');
  }
  const alias = join(dir, "ae-alias");
  await symlink(join(dir, "cm-ae"), alias, process.platform === "win32" ? "junction" : "dir");
  const artifacts = [
    { id: "browser", path: join(dir, "cm-browser", "plugin.mjs"), permissions: { browser_click: "ask" } },
    { id: "cm-ae", path: join(dir, "cm-ae", "plugin.mjs"), permissions: AE_PERMISSIONS },
    { id: "missing", path: join(dir, "missing.mjs"), permissions: { missing_tool: "allow" }, optional: true },
  ];
  const fresh = await mergeBundledPlugins({}, artifacts);
  assert.equal(fresh.config.plugin.length, 2);
  assert.equal(fresh.config.permission.browser_click, "ask");
  assert.equal(fresh.config.permission.ae_execute, "allow");
  assert.equal(Object.hasOwn(fresh.config.permission, "missing_tool"), false);
  assert.deepEqual(fresh.diagnostics.map(({ id, severity, code }) => [id, severity, code]),
    [["missing", "warning", "ARTIFACT_UNAVAILABLE"]]);

  const entry = [pathToFileURL(join(alias, "plugin.mjs")).href, { enabled: false }];
  const original = { plugin: [entry], permission: { browser_click: "deny" } };
  const before = structuredClone(original);
  const merged = await mergeBundledPlugins(original, artifacts);
  assert.deepEqual(original, before);
  assert.deepEqual(merged.config.plugin, [entry, fresh.config.plugin[0]]);
  assert.equal(merged.config.permission.browser_click, "deny");
  assert.deepEqual((await mergeBundledPlugins(merged.config, artifacts)).config, merged.config);
});

test("packaging verifies inventory and hashes, rejects unsafe inputs, and signing fails without credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cm-ae-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  await mkdir(dist);
  const data = "export default {};\n";
  await writeFile(join(dist, "plugin.mjs"), data);
  await writeFile(join(dist, "manifest.json"), JSON.stringify({
    schemaVersion: 1, signed: false,
    artifacts: [{ path: "plugin.mjs", bytes: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex") }],
  }));
  await verifyBuild(dir);
  await writeFile(join(dist, "plugin.mjs"), data.replace("{}", "[]"));
  await assert.rejects(verifyBuild(dir), /Hash mismatch/);
  await writeFile(join(dist, "plugin.mjs"), data);
  await writeFile(join(dist, "unexpected.txt"), "not in manifest");
  await assert.rejects(verifyBuild(dir), /Unexpected/);
  await writeFile(join(dist, ".env"), "TEST_ONLY=not-a-secret");
  await assert.rejects(files(dist), /Unsafe packaging input/);

  const cli = fileURLToPath(new URL("../scripts/sign-zxp.mjs", import.meta.url));
  const output = join(dir, "never-created.zxp");
  const env = { ...process.env, ZXPSIGNCMD: process.execPath, ZXP_CERTIFICATE: "", ZXP_CERT_PASSWORD: "" };
  await assert.rejects(exec(process.execPath, [cli, "sign", output], { env }), (error) => {
    assert.match(error.stderr, /Signing requires/);
    return true;
  });
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("build bundles dependencies but preserves the real worker URL and reproducible inventory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cm-ae-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, "fixture");
  const isolated = join(dir, "isolated");
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(join(fixture, "src"), { recursive: true });
  await mkdir(join(fixture, "panel", "CSXS"), { recursive: true });
  await mkdir(join(fixture, "node_modules"), { recursive: true });
  const require = createRequire(import.meta.url);
  await cp(dirname(require.resolve("zod/package.json")), join(fixture, "node_modules", "zod"), { recursive: true });
  await cp(dirname(require.resolve("marked/package.json")), join(fixture, "node_modules", "marked"), { recursive: true });
  await copyFile(join(root, "package.json"), join(fixture, "package.json"));
  await copyFile(join(root, "compatibility.json"), join(fixture, "compatibility.json"));
  for (const name of ["render-worker.mjs", "protocol.mjs"]) {
    await copyFile(join(root, "src", name), join(fixture, "src", name));
  }
  // Exercise the transitive worker import used by render.mjs without starting AE.
  await writeFile(join(fixture, "src", "runtime.mjs"), 'export { createProcessAdapter } from "./render-worker.mjs";\n');
  await writeFile(join(fixture, "src", "plugin.mjs"), [
    'export { createProcessAdapter } from "./runtime.mjs";',
    'import { z } from "zod";',
    'export const sample = z.object({ value: z.string() }).parse({ value: "bundled" });',
  ].join("\n"));
  await writeFile(join(fixture, "panel", "index.html"), '<script src="./ui.js"></script>\n');
  await writeFile(join(fixture, "panel", "ui.js"), '"use strict";\n');
  await writeFile(join(fixture, "panel", "host.jsx"), 'var host = {};\n');
  await writeFile(join(fixture, "panel", "CSXS", "manifest.xml"), '<ExtensionManifest />\n');
  await build(fixture);
  const before = await verifyBuild(fixture);
  assert.deepEqual(JSON.parse(await readFile(join(fixture, "dist", "cm-ae", "permissions.json"), "utf8")), AE_PERMISSIONS);
  assert.ok(before.artifacts.some((item) => item.path === "cm-ae/render-worker.mjs"));
  assert.deepEqual(
    before.artifacts.filter((item) => item.path.startsWith("panel/")).map((item) => item.path.slice(6)),
    await files(join(fixture, "panel")),
  );
  await build(fixture);
  assert.deepEqual(await verifyBuild(fixture), before);
  await cp(join(fixture, "dist", "cm-ae"), isolated, { recursive: true });
  const smoke = `
    import assert from "node:assert/strict";
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import { join } from "node:path";
    let observed;
    const stopped = new Error("spawn intercepted");
    cp.spawn = (executable, args, options) => { observed = { executable, args, options }; throw stopped; };
    syncBuiltinESMExports();
    const plugin = await import(pathToFileURL(join(process.cwd(), "plugin.mjs")));
    assert.equal(plugin.sample.value, "bundled");
    await assert.rejects(plugin.createProcessAdapter().launch("test-job"), (error) => error === stopped);
    assert.equal(observed.executable, process.execPath);
    assert.equal(observed.args[0], fileURLToPath(new URL("./render-worker.mjs", pathToFileURL(join(process.cwd(), "plugin.mjs")))));
    assert.equal(observed.args[1], "test-job");
    assert.equal(observed.options.detached, true);
  `;
  await exec(process.execPath, ["--input-type=module", "-e", smoke], { cwd: isolated, timeout: 15000 });
});
