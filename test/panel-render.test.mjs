import test from "node:test"
import assert from "node:assert/strict"
import { createPanelRender } from "../src/panel-render.mjs"
import { createRuntime, checkPermissionConfig } from "../src/plugin.mjs"
import { panelFixture, simulatedHost } from "./bridge-panel.mjs"
const tick = () => new Promise(resolve => setImmediate(resolve))
test("authenticated dashboard template discovery enforces configured deny and explicit approval",async t=>{
  const cleanup=[],p=await panelFixture({after:close=>cleanup.push(close)})
  p.state.items=[{id:1,kind:"comp",name:"Main",duration:1,frameRate:25}]
  Object.assign(p.state,{revision:1,projectEpoch:"render",aeVersion:"26",fingerprint:"render",nextCursor:null})
  const runtime=await createRuntime({factories:{bridge:async()=>p.bridge,renderer:async()=>({list:async()=>[],close:async()=>{}})}})
  t.after(async()=>{await p.stop();await runtime.close();for(const close of cleanup)await close()})
  let policy="deny",calls=0
  runtime.chat={assertRestorable:async()=>{},permissionPolicy:(_,name)=>checkPermissionConfig({permission:{ae_templates:policy}},name)}
  await p.start(async command=>{if(command.method!=="templates")return simulatedHost(command,p);calls++;return {renderSettings:["Best Settings"],outputModules:["Lossless"]}})
  async function start(){const r=await p.send("/panel",{action:"render.start",tool:"ae_templates",args:{compId:1}});assert.equal(r.status,200);return r.body.result.token}
  async function poll(token){let r;for(let n=0;n<100;n++){r=await p.send("/panel",{action:"render.poll",token});if(r.body.result.status!=="running")return r.body.result;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error("Operation did not settle")}
  assert.equal((await poll(await start())).status,"failed");assert.equal(calls,0)
  policy="ask";const token=await start(),review=await poll(token)
  assert.equal(review.status,"approval");assert.equal(calls,0)
  const answer=await p.send("/panel",{action:"render.reply",token,approvalID:review.approval.id,allow:true});assert.equal(answer.status,200)
  const result=await poll(token);assert.equal(result.status,"completed");assert.deepEqual(result.result.outputModules,["Lossless"]);assert.equal(calls,1)
})
test("render panel continues exact staged approvals without replay, and rejects cross-binding and duplicate replies", async () => {
  let calls=0, launched=0
  const service=createPanelRender({execute:async(tool,args,c)=>{
    calls++;await c.ask({permission:"ae_grant",patterns:["Grant reviewed directory"]})
    await c.ask({permission:"ae_render_submit",patterns:["Render frozen frames"]})
    launched++;return JSON.stringify({jobId:"job"})
  }})
  const start=service.start("session","binding","ae_render_submit",{},()=>{})
  await tick();const review=service.poll("session","binding",start.token)
  assert.equal(review.status,"approval");assert.equal(service.busy("session"),true)
  assert.throws(()=>service.reply("other","binding",start.token,review.approval.id,true),{code:"invalid_token"})
  assert.throws(()=>service.poll("session","other",start.token),{code:"invalid_token"})
  service.reply("session","binding",start.token,review.approval.id,true)
  assert.throws(()=>service.reply("session","binding",start.token,review.approval.id,true),{code:"invalid_token"})
  await tick();const final=service.poll("session","binding",start.token)
  assert.equal(launched,0);service.reply("session","binding",start.token,final.approval.id,true)
  await tick();assert.equal(service.poll("session","binding",start.token).status,"completed")
  assert.equal(calls,1);assert.equal(launched,1);assert.equal(service.busy("session"),false)
})
test("denial, expiry, project drift and release never launch a render", async () => {
  for(const mode of ["deny","expire","drift","release"]){
    let clock=0,valid=true,launched=false
    const service=createPanelRender({now:()=>clock,execute:async(tool,args,c)=>{await c.ask({permission:"ae_render_submit",patterns:["Render"]});launched=true;return '{}'}})
    const start=service.start("s","b","ae_render_submit",{},()=>{if(!valid)throw Object.assign(new Error("Changed"),{code:"stale_binding"})})
    await tick();const review=service.poll("s","b",start.token)
    if(mode==="expire"){clock=120001;assert.throws(()=>service.reply("s","b",start.token,review.approval.id,true),{code:"invalid_token"});service.release("s")}
    else if(mode==="release")service.release("s")
    else {if(mode==="drift")valid=false;service.reply("s","b",start.token,review.approval.id,mode!=="deny")}
    await tick();assert.equal(launched,false)
  }
})
