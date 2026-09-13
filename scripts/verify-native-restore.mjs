// Native Windows qualification. Requires an unlocked, idle AE with a clean saved project.
// Uses real AE, HTTP bridge, panel transport, workflow and checkpoint storage.
// This does not substitute for testing the installed CEP chat with a live model.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { createRuntime } from "../src/plugin.mjs"
import { RESTORE_PROOF } from "../src/bridge.mjs"
import transport from "../panel/transport.cjs"

if (!process.argv.includes("--run-live")) {
  console.log("Usage: node scripts/verify-native-restore.mjs --run-live [AfterFX.com path]\nRequires an unlocked desktop and a clean saved project. Creates a disposable 96-layer project; retains all evidence and backups.")
  process.exit(0)
}
assert.equal(process.platform, "win32", "This native runner is for Windows")
const root = fileURLToPath(new URL("../", import.meta.url))
const afterfx = process.argv[process.argv.indexOf("--run-live") + 1] || "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.com"
await fs.access(afterfx)
const directory = await fs.mkdtemp(path.join(root, "coverage", "native-restore-"))
const canonical = path.join(directory, "disposable.aep")
const privateRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "cm-native-restore-"))
const execute = promisify(execFile), phases = []
let serial = 0, uncertain = false, queue = Promise.resolve()
const quote = value => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
const digest = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex")
function native(body) {
  const task = queue.then(async () => {
    if (uncertain) throw new Error("Native dispatch is uncertain; no retry or cleanup close is allowed")
    const id = ++serial, output = path.join(directory, id + ".json"), script = path.join(directory, id + ".jsx")
    await fs.writeFile(script, `(function(){var f=new File(${quote(output)});try{var result=(function(){${body}\n})();f.open('w');f.write(result);f.close();}catch(e){f.open('w');f.write('NATIVE_ERROR '+e.toString());f.close();}})();`)
    const start = performance.now()
    try {
      await execute(afterfx, ["-r", script], { windowsHide: true, timeout: 120000 })
      let raw
      while (performance.now() - start < 120000) {
        try { raw = await fs.readFile(output, "utf8"); if (raw) break } catch (e) { if (e.code !== "ENOENT") throw e }
        await delay(50)
      }
      if (!raw) throw new Error("Native result timed out")
      if (raw.startsWith("NATIVE_ERROR")) throw new Error(raw)
      return raw
    } catch (e) { uncertain = true; throw e }
  })
  queue = task.catch(() => {})
  return task
}
// Deliberately use ES3 bodies: these strings execute in the native ExtendScript engine.
const preflight = (await native(`
  if(!app.project.file || app.project.dirty || app.project.renderQueue.rendering)throw Error('Open project must be clean, saved and idle');
  return [String(app.version), app.project.file.fsName, String(app.project.revision)].join('|');
`)).split("|")
const originalPath = preflight[1], originalHash = await digest(originalPath)
let runtime, store, client, pumping = false, pump, restored, completed = false
const report = { version: preflight[0], protocol: RESTORE_PROOF, directory, privateRoot, originalPath, originalHash, phases }
try {
  // Confirm storage/bridge startup before switching away from the user's project.
  runtime = await createRuntime({ dataDir: path.join(privateRoot,"private"), timeoutMs: 120000, heartbeatMs: 180000 })
  await native(`
    if(!app.project.file || app.project.file.fsName!==${quote(originalPath)} || app.project.dirty || app.project.revision!==${Number(preflight[2])})throw Error('Original changed after preflight');
    app.newProject();
    var comp=app.project.items.addComp('Restore qualification 96 layers',960,540,1,5,25);
    for(var i=0;i<96;i++){var l=comp.layers.addNull();l.name='Layer '+i;l.property('ADBE Transform Group').property('ADBE Position').setValueAtTime(0,[i,100]);l.property('ADBE Transform Group').property('ADBE Position').setValueAtTime(2,[i+200,300]);}
    var start=new Date().getTime();app.project.save(new File(${quote(canonical)}));
    var elapsed=new Date().getTime()-start;
    var prior=typeof CookieMonsterAE==='undefined'?null:CookieMonsterAE;
    $.evalFile(new File(${quote(path.join(root,"panel","host.jsx"))}));
    $.global.CookieJarNativeRestoreTest=CookieMonsterAE;
    CookieMonsterAE=prior;
    return String(elapsed);
  `).then(ms => { report.nativeInitialSaveMs = Number(ms) })
  store = new transport.Store(runtime.dataDir,"native-qualification")
  const host = new transport.HostRPC({ evalScript(code, callback) {
    // The same production dispatch function runs in AE; isolate its state from the installed panel.
    native(`return ${code.replace("CookieMonsterAE.dispatch", "$.global.CookieJarNativeRestoreTest.dispatch")};`)
      .then(callback, e => { console.error(e.message) })
  } },120000)
  client = new transport.Client({ store, host })
  await client.pair(runtime.bridge.pairingCode("native-qualification").code)
  await client.connect()
  const connection = (await runtime.bridge.connections()).find(c => c.panelId === store.state.panelId)
  assert.ok(connection)
  await runtime.bridge.bind("native-qualification",connection.id,{expectedProject:connection.project})
  const command = client.command.bind(client)
  client.command = async cmd => {
    const start=performance.now(), result=await command(cmd)
    phases.push({method:cmd.method,phase:cmd.params.phase || null,ms:Math.round(performance.now()-start),requestBytes:JSON.stringify(cmd).length})
    return result
  }
  pumping = true
  pump = (async()=>{while(pumping){await client.tick();await delay(10)}})()
  const checkpoint = await runtime.checkpoints.create({ projectPath:canonical, projectId:connection.project.id, planHash:"native-qualification",pinned:true })
  await native(`var c=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i) instanceof CompItem)c=app.project.item(i);}if(!c)throw Error('Fixture comp missing');c.name='Unsaved recovery marker';return 'edited';`)
  const review = await client.panel("checkpoint.restore.propose",{id:checkpoint.id})
  assert.match(review.operation,/save current edits in place/i)
  const start=performance.now()
  restored = await client.confirmRestore()
  report.result=restored
  report.restoreMs=Math.round(performance.now()-start)
  assert.equal(restored.recoveryCopy,false)
  assert.equal(restored.canonicalReplaced,true)
  assert.equal(await digest(canonical),checkpoint.hash)
  assert.equal(runtime.bridge.binding("native-qualification").lock,null)
  const state = await runtime.workflow.inspectRestore("native-qualification")
  assert.equal(state.protocol,RESTORE_PROOF)
  pumping=false; await pump; client.stop()
  const previous = await runtime.checkpoints.verify(restored.previousCheckpointId)
  assert.equal(previous.hash,checkpoint.hash)
  report.previousDiskVerified=true
  const current = await runtime.checkpoints.verify(restored.currentCheckpointId)
  assert.equal(await digest(restored.emergencyPath),current.hash)
  report.nativeRestored = await native(`var c=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i) instanceof CompItem)c=app.project.item(i);}if(!c || c.name!=='Restore qualification 96 layers' || c.numLayers!==96)throw Error('Restored scene mismatch');return '96 layers and original name verified';`)
  await native(`
    if(app.project.dirty)throw Error('Unexpected edits after restore');
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.open(new File(${quote(current.path)}));
    var c=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i) instanceof CompItem)c=app.project.item(i);}if(!c || c.name!=='Unsaved recovery marker' || c.numLayers!==96)throw Error('Backup did not retain unsaved marker');
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.open(new File(${quote(canonical)}));return 'backup marker verified';
  `)
  assert.equal(await digest(originalPath),originalHash)
  await native(`if(app.project.dirty || app.project.file.fsName!==${quote(canonical)})throw Error('Unexpected cleanup state');app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.open(new File(${quote(originalPath)}));return 'original returned';`)
  assert.equal(await digest(originalPath),originalHash)
  completed=true
} catch(e) {
  report.error={message:e.message,code:e.code,details:e.details}
  process.exitCode=1
  console.error("Qualification failed. No automatic restore retry; retain the disposable project and recovery files.")
} finally {
  pumping=false
  await pump?.catch(()=>{})
  client?.stop(); store?.close(); await runtime?.close()
  report.completed=completed
  await fs.writeFile(path.join(directory,"report.json"),JSON.stringify(report,null,2))
  console.log(JSON.stringify({completed,report:path.join(directory,"report.json"),restoreMs:report.restoreMs,error:report.error},null,2))
}
