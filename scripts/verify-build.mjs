import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, files } from "./build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function verifyBuild(directory = root) {
  const dist = join(directory, "dist");
  const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.signed, false, "Build manifest must not claim signing");
  assert.ok(Array.isArray(manifest.artifacts));
  const inventory = (await files(dist)).filter((path) => path !== "manifest.json");
  assert.deepEqual(manifest.artifacts.map((item) => item.path), inventory, "Unexpected, missing or reordered artifact");
  for (const item of manifest.artifacts) {
    const data = await readFile(join(dist, item.path));
    assert.equal(data.length, item.bytes, `Size mismatch: ${item.path}`);
    assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256, `Hash mismatch: ${item.path}`);
  }
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--rebuild")) throw new Error("Usage: node scripts/verify-build.mjs [--rebuild]");
    const before = await verifyBuild();
    if (process.argv.includes("--rebuild")) {
      await build();
      assert.deepEqual(await verifyBuild(), before, "Rebuild was not byte-for-byte deterministic");
    }
    console.log("Artifact inventory and SHA256 verified. No signature or AE certification implied.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
