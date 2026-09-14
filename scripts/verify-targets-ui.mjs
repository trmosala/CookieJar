import {createRequire} from "node:module"
import {pathToFileURL,fileURLToPath} from "node:url"
import path from "node:path"
import assert from "node:assert/strict"
const {chromium}=createRequire(import.meta.url)(process.env.CM_PLAYWRIGHT_MODULE || "playwright")
const root=fileURLToPath(new URL("../",import.meta.url)),browser=await chromium.launch({headless:true,channel:"msedge"})
try{
 const page=await browser.newPage({viewport:{width:320,height:650}})
 await page.route("**/ui.js",r=>r.fulfill({body:"",contentType:"application/javascript"}))
 await page.goto(pathToFileURL(path.join(root,"panel/index.html")).href)
 await page.evaluate(()=>{
  window.sent=[];window.delayed=null
  const state={connection:"connected",project:{id:"p",path:"D:/p.aep",saved:true},activeCompId:1,compositions:[{id:1,name:"Main"}],selectedLayers:[{compId:1,layerId:7,name:"Title"}]}
  window.testState=state
  const api={requestId:()=>"a".repeat(40),request:async(d,c,p,b)=>{
   if(b.action==="targets"){
    if(b.search==="slow")await new Promise(resolve=>{window.delayed=resolve})
    return {result:{sessionID:"s",targets:[{compId:1,layerId:7,name:"Title",compName:"Main",projectEpoch:"e"},{compId:1,layerId:8,name:"Title",compName:"Main",projectEpoch:"e"}],nextCursor:"page2",note:"Continue for more"}}
   }
   if(b.action==="send"){sent.push(b);return {result:{delivery:"accepted"}}}
   if(b.action==="models")return {result:{models:[]}}
   if(b.action==="checkpoints")return {result:{checkpoints:[]}}
   return {result:{sessionID:"s",status:"idle",messages:[],workspaces:[],workspaceConfirmed:true}}
  }}
  window.targetChat=window.CookieMonsterChat({state,descriptor:{},panel:async()=>[],heartbeat:async()=>{}},{state:{credential:"test"},save(){}},api)
 })
 await page.locator("#chat-mention").click()
 await page.locator("#target-search").fill("slow");await page.locator("#target-find").click()
 await page.waitForFunction(()=>!!window.delayed)
 await page.locator("#target-search").fill("Title");await page.locator("#target-find").click()
 await page.locator("#target-results button").nth(1).click()
 await page.evaluate(()=>delayed())
 assert.equal(await page.locator("#chat-target-picker").isHidden(),true)
 assert.match(await page.locator("#chat-references").innerText(),/#8/)
 await page.locator("#chat-input").fill("Use the selected reference")
 await page.locator("#chat-send").click()
 await page.waitForFunction(()=>sent.length===1)
 assert.equal(await page.evaluate(()=>sent[0].references[0].layerId),8)
 await page.locator("#chat-mention").click()
 await page.keyboard.press("Escape")
 assert.equal(await page.locator("#chat-mention").evaluate(el=>document.activeElement===el),true)
 for(const width of [320,360,700]){await page.setViewportSize({width,height:650});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 console.log("Target references: duplicate IDs, stale search isolation, send, Escape/focus and narrow layouts passed")
}finally{await browser.close()}
