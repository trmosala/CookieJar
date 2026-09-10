import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createBridge } from "../src/bridge.mjs"
import transport from "../panel/transport.cjs"

test("automatic startup selects the interrupted identity before an alphabetically earlier idle profile", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cm-ae-auto-recovery-"));
  const bridge=await createBridge({dataDir:path.join(root,"private")});
  let selected;
  t.after(async()=>{selected?.close();await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  const idle=new transport.Store(bridge.dataDir,"a-idle");idle.close();
  const interrupted=new transport.Store(bridge.dataDir,"z-interrupted");
  interrupted.state.uncertain=true;interrupted.save();interrupted.close();
  selected=transport.automaticStore(bridge.dataDir);
  assert.equal(selected.profile,"z-interrupted");
  assert.equal(selected.state.uncertain,true);
  selected.state.uncertain=false;selected.save();selected.close();
  // Recovery must not switch back to an older alphabetical profile on the next launch.
  const oldDate=new Date(Date.now()-60000);
  fs.utimesSync(idle.file,oldDate,oldDate);
  selected=transport.automaticStore(bridge.dataDir);
  assert.equal(selected.profile,"z-interrupted");
  assert.equal(selected.state.uncertain,false);
});

test("automatic connection authenticates, reuses identities, preserves ownership and project boundaries across reconnect", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm-ae-auto-"))
  let bridge, store, second, client
  t.after(async () => {
    client?.stop(); second?.close(); store?.close()
    await bridge?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  bridge = await createBridge({ dataDir: path.join(root, "private"), heartbeatMs: 60000 })
  store = transport.automaticStore(path.join(root, "private"))
  const identity = store.state.panelId
  const state = { project: { id: "one", path: path.join(root, "one.aep"), saved: true },
    activeCompId: 1, capabilities: { fileNetwork: true }, aeVersion: "26.3", uncertain: false }
  const host = { call: async method => { assert.equal(method, "status"); return state } }
  client = new transport.Client({ store, host })
  await client.connect()
  assert.equal(client.state.connection, "connected")
  assert.ok(store.state.credential)
  const savedCredential = store.state.credential
  const first = await bridge.ensureBound("chat")
  await assert.rejects(bridge.ensureBound("other-chat"), { code: "binding_owned" })
  await client.connect()
  assert.equal((await bridge.ensureBound("chat")).id, first.id)
  assert.equal(store.state.credential, savedCredential)
  state.activeCompId = 8
  await client.tick()
  assert.equal((await bridge.connections())[0].activeCompId, 8)
  state.project = { ...state.project, id: "two", path: path.join(root, "two.aep") }
  await client.tick()
  await assert.rejects(bridge.ensureBound("chat"), { code: "binding_suspended" })
  const changed = state.project
  state.project = first.project
  await client.tick()
  await assert.rejects(bridge.ensureBound("chat"), { code: "binding_suspended" })
  state.project = changed
  await client.tick()
  await bridge.release("chat")
  await bridge.ensureBound("chat")
  await bridge.lock("chat", { kind: "test" })
  await client.connect()
  await assert.rejects(bridge.ensureBound("chat"), e => ["target_locked", "binding_suspended"].includes(e.code))
  // A simultaneous panel receives its own persistent slot, not the live owner's identity.
  second = transport.automaticStore(path.join(root, "private"))
  assert.notEqual(second.state.panelId, identity)
  const other = new transport.Client({ store: second, host })
  await other.connect()
  await assert.rejects(bridge.ensureBound("third-chat"), { code: "target_ambiguous" })
  store.state.uncertain = true; store.save(); store.close()
  store = transport.automaticStore(path.join(root, "private"))
  assert.equal(store.state.panelId, identity)
  assert.equal(store.state.uncertain, true)
  client = new transport.Client({ store, host })
  await assert.rejects(client.connect(), { code: "outcome_uncertain" })
  // Reopening/restarting keeps both credentials and durable recovery evidence.
  await bridge.close()
  bridge = await createBridge({ dataDir: path.join(root, "private"), heartbeatMs: 60000 })
  store.state.uncertain = false; store.save()
  client = new transport.Client({ store, host })
  await client.connect()
  assert.equal(store.state.credential, savedCredential)
  await assert.rejects(bridge.ensureBound("chat"), { code: "target_locked" })
})

test("automatic bootstrap requires its local secret and cannot rotate an existing identity", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm-ae-auto-auth-"))
  const bridge = await createBridge({ dataDir: path.join(root, "private") })
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const descriptor = JSON.parse(fs.readFileSync(path.join(root, "private", "descriptor.json")))
  const bootstrap = JSON.parse(fs.readFileSync(path.join(root, "private", "automatic-connection.json")))
  assert.equal(descriptor.code, undefined)
  const body = { panelId: "auto", protocol: transport.PROTOCOL, version: transport.VERSION, code: "wrong" }
  await assert.rejects(transport.request(descriptor, null, "/pair", body), { code: "invalid_pairing_code" })
  body.code = bootstrap.code
  const paired = await transport.request(descriptor, null, "/pair", body)
  const retry = await transport.request(descriptor, null, "/pair", body)
  assert.equal(retry.credential, paired.credential, "lost response retry is idempotent")
  await transport.request(descriptor, paired.credential, "/rotate", {})
  await assert.rejects(transport.request(descriptor, null, "/pair", body), { code: "already_paired" })
  assert.ok(!JSON.stringify(bridge.compatibility("chat")).includes(bootstrap.code))
})

test("transient connection failure keeps automatic reconnect running without dispatching host commands", async () => {
  const store = { state: { panelId: "retry", credential: null, uncertain: false },
    descriptor: () => ({ instanceId: "test", port: 12345, protocol: transport.PROTOCOL, version: transport.VERSION }),
    automaticCode: () => "a".repeat(43) }
  let requests = 0
  const client = new transport.Client({ store, host: { call() { assert.fail("offline bridge must not dispatch to AE") } },
    request: async () => { requests++; throw Object.assign(new Error("offline"), { code: "disconnected" }) } })
  client.running = true
  await client.tick(); await client.tick()
  assert.equal(requests, 2)
  assert.equal(client.running, true)
  assert.equal(store.state.credential, null)
  client.stop()
})
