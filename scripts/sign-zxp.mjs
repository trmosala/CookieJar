import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuild } from "./verify-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [action, output, ...extra] = process.argv.slice(2);
let reserved = false;
let destination;
let staging;
let published;
try {
  if (!["sign", "verify"].includes(action) || !output || extra.length || !output.toLowerCase().endsWith(".zxp")) {
    throw new Error("Usage: node scripts/sign-zxp.mjs sign|verify OUTPUT.zxp");
  }
  const tool = process.env.ZXPSIGNCMD;
  if (!tool || !isAbsolute(tool) || !(await lstat(tool)).isFile()) {
    throw new Error("ZXPSIGNCMD must name an absolute path to an approved ZXPSignCmd executable");
  }
  destination = resolve(await realpath(dirname(resolve(output))), basename(output));
  if (action === "sign") {
    const within = relative(resolve(root, "dist"), destination);
    if (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)) {
      throw new Error("ZXP output must be outside dist to keep signing inputs immutable");
    }
    const cert = process.env.ZXP_CERTIFICATE;
    if (!cert || !isAbsolute(cert) || !process.env.ZXP_CERT_PASSWORD || !(await lstat(cert)).isFile()) {
      throw new Error("Signing requires ZXP_CERTIFICATE (absolute path) and ZXP_CERT_PASSWORD; no development certificate fallback");
    }
  }
  // Require an archive tester before any signing side effect.
  const zipTool = ["7z", "unzip"].find((tool) => {
    const result = spawnSync(tool, tool === "7z" ? ["i"] : ["-v"], { stdio: "ignore", timeout: 10_000 });
    return !result.error && result.status === 0;
  });
  if (!zipTool) throw new Error("Install 7z or unzip for ZIP integrity verification before signing");
  if (action === "sign") {
    await verifyBuild();
    published = destination;
    staging = await mkdtemp(resolve(dirname(destination), ".zxp-sign-"));
    destination = resolve(staging, basename(destination));
    reserved = true;
    // ZXPSignCmd requires the password as argv. Use only on an isolated signing runner.
    const result = spawnSync(tool, [
      "-sign", resolve(root, "dist/panel"), destination,
      process.env.ZXP_CERTIFICATE, process.env.ZXP_CERT_PASSWORD,
      ...(process.env.ZXP_TIMESTAMP_URL ? ["-tsa", process.env.ZXP_TIMESTAMP_URL] : []),
    ], { stdio: "pipe", timeout: 120_000 });
    if (result.error || result.status !== 0) throw new Error("ZXP signing failed; tool output suppressed to protect signing credentials");
  }
  const archive = spawnSync(zipTool, zipTool === "7z" ? ["t", destination] : ["-t", destination], {
    stdio: "pipe", timeout: 120_000,
  });
  if (archive.error || archive.status !== 0) throw new Error("ZXP archive integrity verification failed");
  const signature = spawnSync(tool, ["-verify", destination, "-certinfo"], { stdio: "pipe", timeout: 120_000 });
  if (signature.error || signature.status !== 0) throw new Error("ZXP signature verification failed");
  if (published) await copyFile(destination, published, constants.COPYFILE_EXCL);
  reserved = false;
  console.log("ZIP integrity and signature tool verification passed. Release owner must validate publisher trust and record the signed artifact hash.");
} catch (error) {
  if (reserved) await rm(destination, { force: true });
  console.error(error.code === "EEXIST" ? "Output exists; refusing to overwrite." : error.message);
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
