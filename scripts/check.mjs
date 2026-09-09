import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22+ required");
let count = 0;
async function check(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) await check(path);
    else if ([".mjs", ".cjs", ".js"].includes(extname(path))) {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
      count++;
    } else if (extname(path) === ".jsx") {
      new Script(await readFile(path, "utf8"), { filename: path });
      count++;
    }
  }
}
try {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) ||
      pkg.type !== "module" || pkg.engines?.node !== ">=22" ||
      pkg.dependencies?.zod !== "4.1.8" ||
      pkg.scripts?.test !== "node --test test/*.test.mjs" ||
      pkg.scripts?.check !== "node scripts/check.mjs" ||
      pkg.scripts?.build !== "node scripts/build.mjs" ||
      lock.packages?.[""]?.name !== pkg.name ||
      lock.packages?.[""]?.version !== pkg.version ||
      lock.packages?.[""]?.dependencies?.zod !== "4.1.8" ||
      lock.packages?.["node_modules/zod"]?.version !== "4.1.8") {
    throw new Error("Package metadata or lockfile does not match the standalone runtime contract");
  }
  await check(root);
  const compatibility = JSON.parse(await readFile(join(root, "compatibility.json"), "utf8"));
  if (!Array.isArray(compatibility.certifiedEntries)) throw new Error("Missing certifiedEntries");
  console.log(`Syntax checked ${count} scripts. JSX parsed by V8 only, not executed or certified in After Effects.`);
} catch (error) {
  console.error(error.stderr?.toString() || error.stack);
  process.exitCode = 1;
}
