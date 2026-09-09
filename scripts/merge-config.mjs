import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AE_PERMISSIONS, mergeBundledPlugins } from "../src/config.mjs";

const [input, artifact, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !artifact || !output || extra.length) {
    throw new Error("Usage: node scripts/merge-config.mjs INPUT.json PLUGIN.mjs OUTPUT.json (new file only)");
  }
  const config = JSON.parse(await readFile(resolve(input), "utf8"));
  const result = await mergeBundledPlugins(config, [
    { id: "cm-ae", path: resolve(artifact), permissions: AE_PERMISSIONS },
  ]);
  for (const diagnostic of result.diagnostics) console.error(JSON.stringify(diagnostic));
  if (result.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
  else {
    // Exclusive creation prevents clobbering the input, a symlink, or any existing user config.
    await writeFile(resolve(output), JSON.stringify(result.config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Created requested config output; no application or global configuration was changed.");
  }
} catch (error) {
  console.error(error.code === "EEXIST" ? "Output already exists; refusing to overwrite it." : error.message);
  process.exitCode = 1;
}
