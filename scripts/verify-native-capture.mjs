// Run an isolated bridge for a visible CEP capture check. CM sessions are doubles;
// host execution, authenticated transport, PNG normalization and capture guards are real.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createBridge } from "../src/bridge.mjs"
import { createRuntime } from "../src/plugin.mjs"
import { createChat } from "../src/chat.mjs"

if (!process.argv.includes("--run-live")) {
  console.log("Use --run-live to start an isolated CEP qualification bridge. Point a test panel's automaticStore at the printed dataDir; restore the normal panel afterwards.")
  process.exit(0)
}
const root = fileURLToPath(new URL("../", import.meta.url))
const evidence = path.join(root, "coverage", "native-capture")
await fs.mkdir(evidence, { recursive: true })
const dataDir = path.join(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "cm-native-capture-")), "private")
const bridge = await createBridge({ dataDir })
const setHandler = bridge.setPanelHandler.bind(bridge)
bridge.setPanelHandler = handler => setHandler(async input => {
  try {
    const result = await handler(input)
    if (input.body.action === "frame.capture") {
      await fs.writeFile(path.join(evidence, "frame.png"), Buffer.from(result.attachment.url.split(",")[1], "base64"))
      await fs.writeFile(path.join(evidence, "result.json"), JSON.stringify({ compId: result.compId, time: result.time, width: result.width, height: result.height, mime: result.attachment.mime }, null, 2))
    }
    return result
  } catch (e) {
    await fs.writeFile(path.join(evidence, "error.json"), JSON.stringify({ code: e.code, message: e.message }))
    throw e
  }
})
const runtime = await createRuntime({ factories: { bridge: async () => bridge, renderer: async () => ({ list: async () => [], close: async () => {} }) } })
const sessions = new Map()
runtime.chat = await createChat(runtime)
runtime.chat.register({ directory: root, client: {
  provider: { list: async () => ({ data: { all: [], connected: [] } }) },
  session: {
    create: async ({ body }) => { const data = { id: "native-capture-" + sessions.size, title: body.title, directory: root };sessions.set(data.id, data);return { data } },
    get: async ({ path }) => ({ data: sessions.get(path.id) }),
    messages: async () => ({ data: [] }), status: async () => ({ data: {} }), abort: async () => ({ data: true }),
    promptAsync: async () => { throw new Error("This qualification bridge never submits model prompts") },
  },
} })
bridge.setChatHandler(runtime.chat.handle)
await fs.writeFile(path.join(evidence, "server.json"), JSON.stringify({ dataDir, evidence }))
console.log(JSON.stringify({ dataDir, evidence }))
process.on("SIGINT", () => runtime.close().then(() => process.exit(0)))
