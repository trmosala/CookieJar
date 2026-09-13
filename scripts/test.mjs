import { spawnSync } from "node:child_process"
import { readdir, realpath } from "node:fs/promises"
import os from "node:os"
import { fileURLToPath } from "node:url"

// Windows may supply an 8.3 TEMP alias. Production storage correctly refuses
// aliases; resolve the test workspace before any fixture creates protected data.
const root = fileURLToPath(new URL("../", import.meta.url))
const temporary = await realpath(os.tmpdir())
const files = (await readdir(new URL("../test/", import.meta.url)))
  .filter(name => name.endsWith(".test.mjs")).sort().map(name => "test/" + name)
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...process.argv.slice(2), ...files], {
  cwd: root, env: { ...process.env, TEMP: temporary, TMP: temporary }, stdio: "inherit",
})
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
