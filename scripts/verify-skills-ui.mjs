import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const browser = await chromium.launch({headless:true,channel:process.env.CM_BROWSER_CHANNEL || (process.platform==='win32' ? 'msedge' : undefined)})
try {
  const page = await browser.newPage({viewport:{width:420,height:780}})
  await page.route('**/ui.js',r=>r.fulfill({body:'',contentType:'application/javascript'}))
  await page.goto(pathToFileURL(path.join(root,'panel/index.html')).href)
  await page.evaluate(()=>{
    let session='first', skills=[], messages=[{id:'answer',role:'assistant',completed:true,parts:[{type:'text',text:'Keep the logo fixed. Use a short ease out.'}]}]
    const directory='D:\\Brand Workspace'
    const state={connection:'connected',project:{id:'visual',path:directory+'\\Brand.aep',saved:true},activeCompId:1,compositions:[{id:1,name:'Main'}]}
    const client={state,descriptor:{},heartbeat:async()=>{},start(){},panel:async()=>({})}
    window.skillCalls=[]
    const api={requestId:()=> 'a'.repeat(40),request:async(d,c,p,b)=>{
      window.skillCalls.push(b)
      if(b.action==='models')return {result:{models:[]}}
      if(b.action==='checkpoints')return {result:{checkpoints:[]}}
      if(b.action==='skills')return {result:{skills,directory,sessionID:session}}
      if(b.action==='skillReview')return {result:{token:'review',directory,destination:directory+'\\.opencode\\skills\\'+b.draft.name+'\\SKILL.md'}}
      if(b.action==='skillSave'){
        skills.push({name:b.draft.name,description:b.draft.description,source:'b'.repeat(64),revision:'c'.repeat(64)})
        return {result:{name:b.draft.name,destination:'SKILL.md'}}
      }
      if(b.action==='new'){session='later';messages=[];return {result:{sessionID:session}}}
      if(b.action==='send'){
        messages=[{id:'loaded',role:'assistant',completed:true,parts:[{type:'text',text:'Using the saved technique.'},{type:'skill',name:b.skill.name}]}]
        return {result:{delivery:'accepted'}}
      }
      return {result:{sessionID:session,directory,workspaceConfirmed:true,messages,status:'idle',workspaces:[directory]}}
    }}
    window.CookieMonsterChat(client,{state:{credential:'visual'},save(){}},api)
  })
  await page.getByRole('button',{name:'Save technique...'}).click()
  await page.getByLabel('Name',{exact:true}).focus()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.locator('#technique-cancel').evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Tab')
  assert.equal(await page.locator('#technique-name').evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#chat-technique').isVisible(),false)
  assert.equal(await page.locator('#chat-input').evaluate(e=>e===document.activeElement),true)
  await page.getByRole('button',{name:'Save technique...'}).click()
  for(const viewport of [{width:420,height:780},{width:320,height:500}]){
    await page.setViewportSize(viewport)
    const box=await page.locator('#chat-form').boundingBox()
    assert.ok(box.y+box.height<=viewport.height,JSON.stringify({viewport,box}))
  }
  await page.getByLabel('Name',{exact:true}).fill('brand-motion')
  await page.getByLabel('Description',{exact:true}).fill('Logo easing')
  await page.getByLabel('Instructions',{exact:true}).fill('Keep the logo fixed. Use a short ease out.')
  await page.getByRole('button',{name:'Review save',exact:true}).click()
  await page.getByRole('button',{name:'Save skill',exact:true}).click()
  await page.waitForFunction(()=>document.getElementById('chat-technique').hidden)
  await page.getByRole('button',{name:'Conversations',exact:true}).click()
  await page.getByRole('button',{name:'New chat',exact:true}).click()
  await page.locator('#chat-skills>summary').click()
  await page.locator('#chat-skill-picker option[value="0"]').waitFor({state:'attached'})
  const composer=await page.locator('#chat-form').boundingBox()
  assert.ok(composer.y+composer.height<=500,JSON.stringify(composer))
  await page.getByLabel('Search skills').fill('logo')
  await page.getByLabel('Reusable skill').selectOption('0')
  await page.getByLabel('Message CookieMonster').fill('Apply the saved easing')
  await page.getByRole('button',{name:'Send message',exact:true}).click()
  await page.locator('.chat-skill-loaded').waitFor()
  assert.match(await page.locator('.chat-skill-loaded').innerText(),/brand-motion/)
  await page.setViewportSize({width:420,height:780})
  await mkdir(path.join(root,'coverage'),{recursive:true})
  await page.screenshot({path:path.join(root,'coverage/issue21-skills-ui.png')})
  console.log('Skills browser flow passed: draft, review, save, later conversation, search, selection and load badge')
} finally { await browser.close() }
