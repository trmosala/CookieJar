import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { files } from "./build.mjs";
import { archiveFiles } from "./release-archive.mjs";
import { verifyTeamRelease } from "./verify-team-release.mjs";

export async function packageTeamRelease(directory, output) {
  assert.ok(output.toLowerCase().endsWith(".zip"), "Output must end in .zip");
  await verifyTeamRelease(directory);
  const inventory = await files(directory);
  const expected = new Map(await Promise.all(inventory.map(async path => [path, await readFile(join(directory, path))])));
  const staging = await mkdtemp(join(tmpdir(), "cookiejar-archive-"));
  try {
    const snapshot = join(staging, "release");
    for (const [path, bytes] of expected) {
      await mkdir(dirname(join(snapshot, path)), { recursive: true });
      await writeFile(join(snapshot, path), bytes);
    }
    await verifyTeamRelease(snapshot);
    const archive = join(staging, "release.zip");
    execFileSync("tar", ["--format=zip", "-cf", archive, "-C", snapshot, ...inventory]);
    const actual = archiveFiles(archive);
    assert.deepEqual([...actual.keys()].sort(), inventory, "ZIP inventory differs from verified release");
    for (const [path, bytes] of expected) assert.deepEqual(actual.get(path), bytes, `ZIP content changed: ${path}`);
    await copyFile(archive, output, constants.COPYFILE_EXCL);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/package-team-release.mjs RELEASE_DIRECTORY OUTPUT.zip");
    await packageTeamRelease(resolve(process.argv[2]), resolve(process.argv[3]));
    console.log("Created ZIP and verified every archived file against the release directory. Signature trust remains a separate release gate.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
