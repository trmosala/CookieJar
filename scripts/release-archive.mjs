import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// bsdtar is included with Windows; install libarchive's bsdtar on other hosts.
export function archiveFiles(archive) {
  const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const result = new Map();
  for (const entry of entries) {
    const name = entry.replace(/^\.\//, "");
    assert.ok(!name.startsWith("/") && !name.includes("\\") && !name.includes(":") && !name.split("/").includes(".."), "Unsafe archive path");
    if (name.endsWith("/")) continue;
    assert.ok(!result.has(name), `Duplicate archive entry: ${name}`);
    result.set(name, execFileSync("tar", ["-xOf", archive, entry], { maxBuffer: 128 * 1024 * 1024 }));
  }
  return result;
}
