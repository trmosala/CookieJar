import {createRequire} from "node:module"
import {pathToFileURL,fileURLToPath} from "node:url"
import path from "node:path"
import assert from "node:assert/strict"
const {chromium}=createRequire(import.meta.url)(process.env.CM_PLAYWRIGHT_MODULE || "playwright")
const root=fileURLToPath(new URL("../",import.meta.url)),browser=await chromium.launch({headless:true,channel:"msedge"})
try{
 const page=await browser.newPage({viewport:{width:360,height:700}})
 await page.goto(pathToFileURL(path.join(root,"panel/index.html")).href)
 await page.evaluate(()=>{
  window.calls=[];document.getElementById("connection-notice").hidden=true;document.getElementById("connection-status").className="is-connected";document.getElementById("connection-status").textContent="Connected"
  const state={connection:"connected",project:{id:"p",path:"D:/Projects/Brand launch/Long project name.aep",saved:true},activeCompId:1,compositions:[{id:1,name:"Main title"}]}
  const snapshot={sessionID:"s",title:"Brand launch — a long conversation title that must truncate",status:"idle",model:{providerID:"test",id:"sol",variant:"high"},workspaceConfirmed:true,messages:[{id:"u",role:"user",parts:[{type:"text",text:"Give the title a gentle entrance."}]},{id:"a",parentID:"u",role:"assistant",completed:true,parts:[{type:"tool",text:"ae_inspect · completed"},{type:"text",text:"The title now fades in. The rest of the composition stays in place."},{type:"checkpoint",id:"cp",label:"Before this edit"}]}]}
  const api={requestId:()=>"a".repeat(40),request:async(d,c,p,b)=>{calls.push(b.action);if(b.action==="conversations")return {result:{conversations:[{sessionID:"s",title:snapshot.title,directory:"D:/Projects/Brand launch",updatedAt:1700000000000}],total:1,nextOffset:null}};if(b.action==="models")return {result:{models:[{id:"sol",providerID:"test",name:"CM_GPT6_Astra_Low",provider:"CookieMonster",variants:["low","high"]}]}};if(b.action==="checkpoints")return {result:{checkpoints:[]}};return {result:snapshot}}}
  window.redesignChat=window.CookieMonsterChat({state,descriptor:{},panel:async()=>[],heartbeat:async()=>{}},{state:{credential:"test"},save(){}},api)
 })
 await page.getByText("The title now fades in.",{exact:false}).waitFor()
 for(const width of [320,360,700]){
  await page.setViewportSize({width,height:700})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  const composer=await page.locator("#chat-form").boundingBox()
  assert.ok(composer.y+composer.height<=700 && composer.y+composer.height>=680)
  for(const id of ["chat-conversations-open","settings-toggle","chat-attach","chat-capture","chat-model","chat-mention","chat-send"]){const box=await page.locator("#"+id).boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=width,id)}
  await page.screenshot({path:path.join(root,"coverage/redesign-"+width+".png")})
 }
 await page.locator("#chat-conversations-open").click()
 await page.locator(".chat-conversation-row").waitFor()
 await page.keyboard.press("Escape")
 assert.equal(await page.locator("#chat-conversations-open").evaluate(el=>el===document.activeElement),true)
 await page.locator("#settings-toggle").click()
 await page.waitForFunction(()=>document.activeElement.id==="settings-close")
 await page.keyboard.press("Shift+Tab")
 assert.equal(await page.locator(".advanced-content").evaluate(el=>el.contains(document.activeElement)),true)
 await page.screenshot({path:path.join(root,"coverage/redesign-settings.png")})
 await page.keyboard.press("Escape")
 assert.equal(await page.locator("#settings-toggle").evaluate(el=>el===document.activeElement),true)
 assert.equal(await page.evaluate(()=>calls.includes("send")),false)
 console.log("Redesign: 320/360/700px controls, pinned composer, drawer/settings focus and no prompt dispatch passed")
}finally{await browser.close()}
