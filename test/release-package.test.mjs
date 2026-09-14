import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTeamRelease } from "../scripts/verify-team-release.mjs";
import { packageTeamRelease } from "../scripts/package-team-release.mjs";
import { archiveFiles } from "../scripts/release-archive.mjs";
import { execFileSync } from "node:child_process";

const hash = (data) => createHash("sha256").update(data).digest("hex");

test("team release requires checksummed agent instructions outside the signed ZXP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cookiejar-team-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "cm-ae"));
  const panelDir = await mkdtemp(join(tmpdir(), "cookiejar-panel-"));
  t.after(() => rm(panelDir, { recursive: true, force: true }));
  await mkdir(join(panelDir, "CSXS"));
  const panelXml = Buffer.from('<ExtensionManifest ExtensionBundleVersion="0.2.3"/>');
  await writeFile(join(panelDir, "CSXS", "manifest.xml"), panelXml);
  const zxpPath = join(directory, "CookieJar-AE-0.2.3-team-test.zxp");
  execFileSync("tar", ["--format=zip", "-cf", zxpPath, "-C", panelDir, "CSXS/manifest.xml"]);
  const instructions = await readFile(new URL("../release/AGENTS.md", import.meta.url));
  const content = new Map([
    ["AGENTS.md", instructions],
    ["README.md", Buffer.from("Team test\n")],
    ["compatibility.json", Buffer.from("{}\n")],
    ["cm-ae/plugin.mjs", Buffer.from("export default {};\n")],
    ["cm-ae/render-worker.mjs", Buffer.from("export {};\n")],
    ["cm-ae/permissions.json", Buffer.from('{"ae_execute":"ask"}\n')],
    ["CookieJar-AE-0.2.3-team-test.zxp", await readFile(zxpPath)],
    ["signature-verification.txt", Buffer.from("verified fixture\n")],
  ]);
  const artifacts = ["AGENTS.md", "cm-ae/permissions.json", "cm-ae/plugin.mjs", "cm-ae/render-worker.mjs", "compatibility.json"]
    .map((path) => ({ path, bytes: content.get(path).length, sha256: hash(content.get(path)) }));
  artifacts.push({ path: "panel/CSXS/manifest.xml", bytes: panelXml.length, sha256: hash(panelXml) });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: "0.2.3", signed: false, profile: "client", artifacts }) + "\n");
  content.set("build-manifest.json", manifest);
  const receipt = Buffer.from(JSON.stringify({ zxpSha256: hash(content.get("CookieJar-AE-0.2.3-team-test.zxp")), productionApproved: false }) + "\n");
  content.set("signing-receipt.json", receipt);
  for (const [path, data] of content) await writeFile(join(directory, path), data);
  const sums = [...content].map(([path, data]) => `${hash(data)}  ${path}`).join("\n") + "\n";
  await writeFile(join(directory, "SHA256SUMS.txt"), sums);

  assert.deepEqual(await verifyTeamRelease(directory), { version: "0.2.3", files: content.size, zxp: "CookieJar-AE-0.2.3-team-test.zxp" });
  const output = join(panelDir, "release.zip");
  await packageTeamRelease(directory, output);
  assert.deepEqual(archiveFiles(output).get("AGENTS.md"), instructions);
  await assert.rejects(packageTeamRelease(directory, output), { code: "EEXIST" });
  await writeFile(join(directory, "cm-ae", "extra.mjs"), "extra");
  await writeFile(join(directory, "SHA256SUMS.txt"), sums + `${hash("extra")}  cm-ae/extra.mjs\n`);
  await assert.rejects(verifyTeamRelease(directory), /Backend inventory/);
  await rm(join(directory, "cm-ae", "extra.mjs"));
  await writeFile(join(directory, "SHA256SUMS.txt"), sums.replaceAll("\n", "\r\n"));
  await verifyTeamRelease(directory);
  const wrongManifest = Buffer.from(manifest.toString().replace('"version":"0.2.3"', '"version":"0.2.4"'));
  await writeFile(join(directory, "build-manifest.json"), wrongManifest);
  await writeFile(join(directory, "SHA256SUMS.txt"), sums.replace(hash(manifest), hash(wrongManifest)));
  await assert.rejects(verifyTeamRelease(directory), /panel version differs/);
  await writeFile(join(directory, "build-manifest.json"), manifest);
  await writeFile(join(directory, "SHA256SUMS.txt"), sums);
  await writeFile(join(panelDir, "CSXS", "manifest.xml"), panelXml.toString().replace("/>", ' Changed="yes"/>'));
  execFileSync("tar", ["--format=zip", "-cf", zxpPath, "-C", panelDir, "CSXS/manifest.xml"]);
  const changedZxp = await readFile(zxpPath);
  const changedReceipt = Buffer.from(JSON.stringify({ zxpSha256: hash(changedZxp), productionApproved: false }) + "\n");
  await writeFile(join(directory, "signing-receipt.json"), changedReceipt);
  await writeFile(join(directory, "SHA256SUMS.txt"), sums.replace(hash(content.get("CookieJar-AE-0.2.3-team-test.zxp")), hash(changedZxp)).replace(hash(receipt), hash(changedReceipt)));
  await assert.rejects(verifyTeamRelease(directory), /ZXP build hash mismatch/);
  await writeFile(zxpPath, content.get("CookieJar-AE-0.2.3-team-test.zxp"));
  await writeFile(join(directory, "signing-receipt.json"), receipt);
  await writeFile(join(directory, "SHA256SUMS.txt"), sums);
  await writeFile(join(directory, "AGENTS.md"), Buffer.from("tampered\n"));
  await assert.rejects(verifyTeamRelease(directory), /hash mismatch: AGENTS\.md/i);
});
