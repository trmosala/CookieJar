import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { files } from "./build.mjs";
import { archiveFiles } from "./release-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (data) => createHash("sha256").update(data).digest("hex");

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    assert.ok(match, `Invalid SHA256SUMS entry: ${line}`);
    const path = match[2].replaceAll("\\", "/");
    assert.ok(!isAbsolute(path) && !path.split("/").includes(".."), `Unsafe SHA256SUMS path: ${path}`);
    assert.ok(!checksums.has(path), `Duplicate SHA256SUMS entry: ${path}`);
    checksums.set(path, match[1].toLowerCase());
  }
  return checksums;
}

export async function verifyTeamRelease(directory) {
  const inventory = (await files(directory)).filter((path) => path !== "SHA256SUMS.txt");
  const checksums = parseChecksums(await readFile(join(directory, "SHA256SUMS.txt"), "utf8"));
  assert.deepEqual([...checksums.keys()].sort(), inventory, "Team release checksum inventory is incomplete or contains unexpected files");
  assert.ok(checksums.has("AGENTS.md"), "Team release must checksum AGENTS.md");
  for (const [path, expected] of checksums) {
    assert.equal(digest(await readFile(join(directory, path))), expected, `Team release hash mismatch: ${path}`);
  }

  const manifest = JSON.parse(await readFile(join(directory, "build-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profile, "client", "Team release must use a client build");
  assert.equal(manifest.signed, false, "Build manifest must describe the unsigned signing input");
  const built = new Map(manifest.artifacts.map((item) => [item.path, item]));
  assert.equal(built.size, manifest.artifacts.length, "Duplicate build artifact");
  assert.deepEqual(inventory.filter(path => path.startsWith("cm-ae/")).sort(), [...built.keys()].filter(path => path.startsWith("cm-ae/")).sort(), "Backend inventory differs from build manifest");
  for (const required of ["cm-ae/plugin.mjs", "cm-ae/render-worker.mjs", "cm-ae/permissions.json", "panel/CSXS/manifest.xml"]) assert.ok(built.has(required), `Missing build artifact: ${required}`);
  for (const path of ["AGENTS.md", "compatibility.json", ...manifest.artifacts.map((item) => item.path).filter((path) => path.startsWith("cm-ae/"))]) {
    const item = built.get(path);
    assert.ok(item, `Build manifest is missing ${path}`);
    const data = await readFile(join(directory, path));
    assert.equal(data.length, item.bytes, `Build size mismatch: ${path}`);
    assert.equal(digest(data), item.sha256, `Build hash mismatch: ${path}`);
  }

  for (const path of ["README.md", "signing-receipt.json", "signature-verification.txt"]) {
    assert.ok(inventory.includes(path), `Team release is missing ${path}`);
  }
  const zxp = inventory.filter((path) => path.toLowerCase().endsWith(".zxp"));
  assert.equal(zxp.length, 1, "Team release must contain exactly one signed ZXP");
  const receipt = JSON.parse(await readFile(join(directory, "signing-receipt.json"), "utf8"));
  assert.equal(receipt.zxpSha256?.toLowerCase(), digest(await readFile(join(directory, zxp[0]))), "Signed ZXP does not match signing receipt");
  const panel = archiveFiles(join(directory, zxp[0]));
  const panelPaths = [...built.keys()].filter(path => path.startsWith("panel/"));
  assert.deepEqual([...panel.keys()].filter(path => path !== "META-INF/signatures.xml").sort(), panelPaths.map(path => path.slice(6)).sort(), "ZXP panel inventory differs from build manifest");
  for (const path of panelPaths) assert.equal(digest(panel.get(path.slice(6))), built.get(path).sha256, `ZXP build hash mismatch: ${path}`);
  const xml = panel.get("CSXS/manifest.xml").toString("utf8");
  const version = /\bExtensionBundleVersion\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
  assert.equal(version, manifest.version.split("-")[0], "ZXP panel version differs from backend build");
  return { version: manifest.version, files: inventory.length, zxp: basename(zxp[0]) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-team-release.mjs RELEASE_DIRECTORY");
    const result = await verifyTeamRelease(resolve(root, process.argv[2]));
    console.log(`Checksums, build contents and ZXP receipt match for ${result.version}. Signature authenticity and publisher trust require scripts/sign-zxp.mjs verify and release-owner review.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
