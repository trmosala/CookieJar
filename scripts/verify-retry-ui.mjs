import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const {chromium}=createRequire(import.meta.url)(process.env.CM_PLAYWRIGHT_MODULE || 'playwright')
const browser=await chromium.launch({headless:true,channel:'msedge'})
try {
  const page=await browser.newPage({viewport:{width:360,height:700}})
  await page.route('**/ui.js',r=>r.fulfill({body:'',contentType:'application/javascript'}))
  await page.goto(pathToFileURL(process.cwd()+'/panel/index.html').href)
  await page.evaluate(()=>{
    window.retryCalls=[]
    const state={connection:'connected',project:{id:'p',path:'D:/Project.aep',saved:true},activeCompId:1,compositions:[{id:1,name:'Main'}]}
    const snapshot={sessionID:'s',status:'idle',workspaceConfirmed:true,messages:[{id:'u',role:'user',parts:[{type:'text',text:'Animate the title.'}]}]}
    const api={requestId:()=> 'a'.repeat(40),request:async(d,c,p,b)=>{
      window.retryCalls.push(b)
      if(b.action==='retryDraft')return {result:{sessionID:'s',messageID:'u',text:'Animate the title.',attachments:[]}}
      if(b.action==='models')return {result:{models:[]}}
      if(b.action==='checkpoints')return {result:{checkpoints:[]}}
      if(b.action==='send')return {result:{delivery:'accepted'}}
      return {result:snapshot}
    }}
    window.CookieMonsterChat({state,descriptor:{},heartbeat:async()=>{},panel:async()=>[]},{state:{credential:'test'},save(){}},api)
  })
  await page.locator('#chat-input').fill('Unsent draft')
  await page.getByRole('button',{name:'Edit and retry',exact:true}).click()
  await page.locator('#chat-retry-note').waitFor()
  assert.equal(await page.locator('#chat-input').inputValue(),'Animate the title.')
  for(const width of [320,360,700]){
    await page.setViewportSize({width,height:700})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    const box=await page.locator('#chat-form').boundingBox()
    assert.ok(box.y>=0 && box.y+box.height<=700)
    await page.screenshot({path:'coverage/retry-'+width+'.png'})
  }
  await page.getByRole('button',{name:'Cancel retry',exact:true}).click()
  assert.equal(await page.locator('#chat-input').inputValue(),'Unsent draft')
  await page.getByRole('button',{name:'Edit and retry',exact:true}).click()
  await page.locator('#chat-input').fill('Make the entrance slower.')
  await page.getByRole('button',{name:'Send message',exact:true}).click()
  await page.waitForFunction(()=>window.retryCalls.some(c=>c.action==='send'))
  const sends=await page.evaluate(()=>window.retryCalls.filter(c=>c.action==='send'))
  assert.equal(sends.length,1);assert.equal(sends[0].retryMessageID,'u');assert.equal(sends[0].text,'Make the entrance slower.')
  console.log('Retry browser flow passed at 320, 360 and 700px: review, cancel, edit and send once')
} finally {await browser.close()}
