import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AE_PERMISSIONS } from "../src/config.mjs";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowedPanelTypes = new Set([".html", ".css", ".js", ".cjs", ".mjs", ".jsx", ".xml", ".json", ".png", ".jpg", ".svg", ".woff", ".woff2", ".txt"]);
const unsafeName = /(^\.|^(node_modules|temp|tmp|cache|logs|credentials|pairing|checkpoints)$|\.(p12|pfx|pem|key|log|tmp|bak)$)/i;

export async function files(dir, prefix = "") {
  if (!(await lstat(dir)).isDirectory()) throw new Error(`Expected real directory: ${dir}`);
  const found = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (unsafeName.test(name) || info.isSymbolicLink()) throw new Error(`Unsafe packaging input: ${prefix}${name}`);
    if (info.isDirectory()) found.push(...await files(path, `${prefix}${name}/`));
    else if (info.isFile()) found.push(`${prefix}${name}`);
    else throw new Error(`Not a regular packaging input: ${prefix}${name}`);
  }
  return found;
}

export async function build(directory = root) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22+ required");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || typeof pkg.version !== "string") {
    throw new Error("package.json must be a JSON object with a version; ask its owner to repair metadata");
  }
  let bun;
  try {
    bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Bun is required to bundle dependencies. Install Bun 1.3.14; no incomplete source-only fallback is emitted.");
  }
  const require = createRequire(join(directory, "package.json"));
  const zodPackage = require.resolve("zod/package.json");
  const zod = JSON.parse(await readFile(zodPackage, "utf8"));
  if (zod.version !== "4.1.8") throw new Error("Install the root dependency zod@4.1.8 before building");
  const sourceFiles = await files(join(directory, "src"));
  if (!sourceFiles.includes("plugin.mjs")) throw new Error("Missing src/plugin.mjs");
  const panel = await files(join(directory, "panel"));
  if (!panel.includes("CSXS/manifest.xml") || !panel.includes("index.html")) throw new Error("Incomplete CEP panel");
  for (const path of panel) {
    if (!allowedPanelTypes.has(extname(path).toLowerCase())) throw new Error(`Unapproved panel asset: ${path}`);
    if (extname(path) === ".jsx") new Script(await readFile(join(directory, "panel", path), "utf8"), { filename: path });
    else if ([".mjs", ".cjs", ".js"].includes(extname(path))) {
      execFileSync(process.execPath, ["--check", join(directory, "panel", path)], { stdio: "pipe" });
    }
  }

  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  if (!(await lstat(dist)).isDirectory()) throw new Error("dist must be a real directory, not a symlink");
  const stage = await mkdtemp(join(dist, "build-"));
  try {
    await mkdir(join(stage, "cm-ae"));
    // The supervisor must retain its own import.meta.url for detached process launch.
    for (const entry of ["plugin.mjs", "render-worker.mjs"]) {
      execFileSync("bun", [
        "build", `./src/${entry}`, "--target=node", "--format=esm", "--packages=bundle",
        "--env=disable", "--reject-unresolved",
        ...(entry === "plugin.mjs" ? ["--external=./render-worker.mjs"] : []),
        "--outfile", join(stage, "cm-ae", entry),
      ], { cwd: directory, stdio: "pipe" });
      execFileSync(process.execPath, ["--check", join(stage, "cm-ae", entry)], { stdio: "pipe" });
    }
    for (const path of panel) {
      const dest = join(stage, "panel", path);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(directory, "panel", path), dest);
    }
    await copyFile(join(directory, "compatibility.json"), join(stage, "compatibility.json"));
    await copyFile(join(dirname(zodPackage), "LICENSE"), join(stage, "cm-ae", "ZOD-LICENSE.txt"));
    await writeFile(join(stage, "cm-ae", "permissions.json"), JSON.stringify(AE_PERMISSIONS, null, 2) + "\n");
    const artifacts = [];
    for (const path of await files(stage)) {
      const data = await readFile(join(stage, path));
      artifacts.push({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    await writeFile(join(stage, "manifest.json"), JSON.stringify({
      schemaVersion: 1, version: pkg.version, signed: false,
      build: { bun, target: "node", format: "esm", zod: zod.version },
      artifacts,
    }, null, 2) + "\n");
    // ponytail: single-writer build; CI uses isolated workspaces, not concurrent builds.
    for (const name of ["cm-ae", "panel", "compatibility.json", "manifest.json"]) {
      await rm(join(dist, name), { force: true, recursive: true });
      await rename(join(stage, name), join(dist, name));
    }
    console.log(`Built ${artifacts.length} hashed files in dist (unsigned, not certified).`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await build(); }
  catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  }
}
