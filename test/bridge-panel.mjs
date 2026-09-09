import http from "node:http"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { createBridge } from "../src/bridge.mjs"
import { hash } from "../src/protocol.mjs"
import vm from "node:vm"
import transport from "../panel/transport.cjs"
import { hostDouble } from "./workflow-host.mjs"

// Production HTTP bridge, Client and HostRPC with real host source. Only AE objects are simulated.
export async function restoreFixture(t, options = {}) {
  const p = await panelFixture(t, { timeoutMs: 10000, ...options.bridge })
  const h = hostDouble(p.state.project.path)
  const store = new transport.Store(p.dataDir, "restore-test")
  const host = new transport.HostRPC({ evalScript(code, cb) {
    if (options.evalScript) return options.evalScript(code, cb, h)
    cb(vm.runInContext(code, h.context))
  } }, options.hostTimeout || 5000)
  const client = new transport.Client({ store, host })
  await client.pair(p.bridge.pairingCode("restore-session").code)
  await client.connect()
  const connection = (await p.bridge.connections()).find(c => c.panelId === store.state.panelId)
  await p.bridge.bind("restore-session", connection.id, { expectedProject: connection.project })
  const commands = []
  const command = client.command.bind(client)
  client.command = async cmd => { commands.push(structuredClone(cmd)); return command(cmd) }
  let stopped = false
  const pump = (async () => { while (!stopped) { await client.tick(); await delay(5) } })()
  const stop = async () => { stopped = true; await pump; client.stop() }
  t.after(async () => { await stop(); store.close() })
  return { p, h, store, host, client, commands, stop, sessionID: "restore-session", connectionId: connection.id }
}

export function request(port, endpoint, body, { credential, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const text = raw ?? (body === undefined ? "" : JSON.stringify(body))
    const req = http.request({
      hostname: "127.0.0.1", port, path: endpoint, method: endpoint === "/poll" ? "GET" : "POST",
      agent: false,
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(text ? { "Content-Length": Buffer.byteLength(text) } : {}), ...headers },
    }, res => {
      const chunks = []
      res.on("data", chunk => chunks.push(chunk))
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch (error) { reject(error) }
      })
    })
    req.on("error", reject)
    req.setTimeout(10000, () => req.destroy(new Error("Test request timed out")))
    req.end(text)
  })
}

export async function panelFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cm-ae-bridge-"))
  const dataDir = path.join(root, "private")
  let bridge
  let stop = true
  let pump
  t.after(async () => {
    stop = true
    await pump
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
  })
  bridge = await createBridge({ dataDir, timeoutMs: 2000, heartbeatMs: 60000, ...options })
  let descriptor = JSON.parse(await readFile(path.join(dataDir, "descriptor.json"), "utf8"))
  const panelId = "test-panel"
  const paired = await request(descriptor.port, "/pair", {
    code: bridge.pairingCode("session").code, protocol: 1, version: "0.1.0", panelId,
  })
  if (paired.status !== 200) throw new Error(JSON.stringify(paired))
  let credential = paired.body.credential
  const connectionId = paired.body.connectionId
  const state = {
    project: { id: "project-1", path: path.join(dataDir, "project.aep"), saved: true },
    items: [], activeCompId: null, selection: [], capabilities: { fileNetwork: true }, busy: false, installedEffects: [],
  }
  const log = []
  const api = {
    dataDir, state, log, connectionId,
    get bridge() { return bridge },
    get credential() { return credential },
    get port() { return descriptor.port },
    send(endpoint, body, extra = {}) { return request(descriptor.port, endpoint, body, { credential, ...extra }) },
    async connect() {
      const result = await api.send("/connect", { protocol: 1, version: "0.1.0", panelId,
        project: state.project, aeVersion: "26.0-test", capabilities: state.capabilities })
      if (result.status !== 200) throw new Error(JSON.stringify(result))
    },
    async heartbeat() {
      return api.send("/heartbeat", { project: state.project, capabilities: state.capabilities, busy: state.busy })
    },
    async restart() {
      await bridge.close()
      bridge = await createBridge({ dataDir, timeoutMs: 2000, heartbeatMs: 60000, ...options })
      descriptor = JSON.parse(await readFile(path.join(dataDir, "descriptor.json"), "utf8"))
    },
    setCredential(value) { credential = value },
    async start(handler) {
      stop = false
      pump = (async () => {
        while (!stop) {
          const response = await api.send("/poll")
          if (response.status !== 200) throw new Error(JSON.stringify(response))
          const command = response.body.command
          if (!command) { await delay(2); continue }
          log.push(structuredClone(command))
          await api.send("/heartbeat", { project: state.project, capabilities: state.capabilities, busy: true })
          try {
            const result = await handler(command, api)
            if (result === undefined) continue
            const reply = await api.send("/reply", { id: command.id, result })
            if (reply.status !== 200 && reply.body.error?.code !== "invalid_reply") throw new Error(JSON.stringify(reply))
          } catch (error) {
            await api.send("/reply", { id: command.id, error: { code: error.code || "host_failure", message: error.message } })
          }
        }
      })()
    },
    async stop() { stop = true; await pump },
  }
  await api.connect()
  await bridge.bind("session", connectionId)
  await writeFile(state.project.path, JSON.stringify(state))
  return api
}

export async function simulatedHost(command, panel) {
  const { method, params } = command
  const { state } = panel
  switch (method) {
    case "inspect": return structuredClone(state)
    case "preflight":
      panel.preflight = { actions: hash(params.actions), fingerprint: hash(state) }
      return { actions: params.actions, warnings: [], affected: [], estimatedMs: params.actions.length * 10 }
    case "save":
      await writeFile(state.project.path, JSON.stringify(state))
      return { project: structuredClone(state.project) }
    case "execute":
      if (panel.preflight?.fingerprint !== hash(state) || panel.preflight?.actions !== hash(params.actions))
        throw Object.assign(new Error("Host revision or preflight changed"), { code: "stale_fingerprint" })
      panel.preflight = null
      for (const action of params.actions) {
        if (action.type === "fail") throw Object.assign(new Error("Definite host failure"), { code: "action_failed" })
        state.items.push({ id: state.items.length + 1, ...structuredClone(action) })
      }
      return { results: [{ id: state.items.length }] }
    case "open":
      if (panel.dirty) throw Object.assign(new Error("Dirty host refuses open"), { code: "unsafe_state" })
      Object.assign(state, JSON.parse(await readFile(params.path, "utf8")))
      state.project = { id: "path:" + hash(params.path), path: params.path, saved: true }
      return { project: structuredClone(state.project) }
    case "raw": return { value: params.source }
    default: throw new Error(`Unsupported simulated method: ${method}`)
  }
}
