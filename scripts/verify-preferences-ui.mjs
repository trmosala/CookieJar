import {createRequire} from "node:module"
import {pathToFileURL,fileURLToPath} from "node:url"
import path from "node:path"
import assert from "node:assert/strict"
const {chromium}=createRequire(import.meta.url)(process.env.CM_PLAYWRIGHT_MODULE || "playwright")
const root=fileURLToPath(new URL("../",import.meta.url)),browser=await chromium.launch({headless:true,channel:"msedge"})
try{
 const page=await browser.newPage({viewport:{width:320,height:600}})
 await page.route("**/ui.js",r=>r.fulfill({body:"",contentType:"application/javascript"}))
 const url=pathToFileURL(path.join(root,"panel/index.html")).href
 await page.goto(url);await page.evaluate(()=>document.getElementById("advanced").open=true)
 await page.locator("#preference-textSize").selectOption("large")
 await page.locator("#preference-density").selectOption("compact")
 await page.locator("#preference-sendKey").selectOption("modifier")
 await page.reload();await page.evaluate(()=>document.getElementById("advanced").open=true)
 assert.equal(await page.locator("#preference-textSize").inputValue(),"large")
 assert.equal(await page.locator("#preference-sendKey").inputValue(),"modifier")
 for(const width of [320,360,700]){await page.setViewportSize({width,height:600});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(root,"coverage","preferences-"+width+".png")})}
 await page.locator("#preferences-reset").click();assert.equal(await page.locator("#preference-textSize").inputValue(),"normal")
 console.log("Preferences persist/reset and remain usable at 320/360/700px with large text")
}finally{await browser.close()}
