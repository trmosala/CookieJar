import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.CM_PLAYWRIGHT_MODULE || "playwright")
const root=fileURLToPath(new URL("../",import.meta.url))
const browser=await chromium.launch({headless:true,channel:process.platform==="win32"?"msedge":undefined})
try{
  const page=await browser.newPage()
  await page.route("**/ui.js",route=>route.fulfill({body:"",contentType:"application/javascript"}))
  await page.goto(pathToFileURL(path.join(root,"panel/index.html")).href)
  await page.evaluate(()=>{
    document.getElementById("advanced").open=true
    document.querySelectorAll(".settings-page").forEach(e=>e.hidden=e.id!=="settings-services")
    window.started=[];let task=null
    const state={connection:"connected",project:{id:"p",saved:true,path:"D:/p.aep"},compositions:[{id:1,name:"A long composition title with duplicate-friendly ID"}]}
    const client={state,context:()=>"p",emit(){dashboard.update(state)},panel:async(action,args)=>{
      if(action==="renders")return [{jobId:"job",state:"completed"}]
      if(action==="render.start"){started.push(args);task={token:"t",status:"approval",approval:{id:"a",summary:"Review exact operation",permission:args.tool},result:args.tool==="ae_templates"?{renderSettings:["Best"],outputModules:["Lossless"]}:{jobId:"job"}};return task}
      if(action==="render.reply"){task={...task,status:args.allow?"completed":"failed",approval:null,error:{message:"Denied"}};return {answered:true}}
      return task
    }}
    window.dashboard=window.CookieJarRender(client,{renderDirectory:()=>"D:/output"},async()=>{})
    dashboard.update(state)
  })
  await page.locator("#render-templates").click()
  await page.locator("#render-approve").click()
  await page.waitForFunction(()=>document.getElementById("render-output").value==="Lossless")
  await page.locator("#render-path").fill("D:/output/frame.avi")
  await page.locator("#render-submit").click()
  await page.locator("#render-approve").click()
  await page.waitForFunction(()=>window.started.at(-1).tool==="ae_render_submit")
  await page.locator("#render-deny").click()
  await page.waitForFunction(()=>document.getElementById("render-status").textContent.includes("Denied"))
  assert.equal(await page.evaluate(()=>started.filter(s=>s.tool==="ae_render_submit").length),1)
  await mkdir(path.join(root,"coverage"),{recursive:true})
  for(const width of [320,360,700]){
    await page.setViewportSize({width,height:720})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.screenshot({path:path.join(root,"coverage","render-"+width+".png")})
  }
  console.log("Render dashboard staged approvals, denial and 320/360/700px layouts passed")
}finally{await browser.close()}

