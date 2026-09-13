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
    const state={connection:'connected',project:{id:'p',path:'D:/Project.aep',saved:true},activeCompId:1,compositions:[{id:1,name:'Main'}]}
    let skill={name:'brand',source:'a'.repeat(64),revision:'b'.repeat(64),description:'Brand motion'}
    window.managementCalls=[]
    const api={requestId:()=> 'a'.repeat(40),request:async(d,c,p,b)=>{
      window.managementCalls.push(b)
      if(b.action==='models')return {result:{models:[]}}
      if(b.action==='checkpoints')return {result:{checkpoints:[]}}
      if(b.action==='skills')return {result:{skills:skill?[skill]:[],directory:'D:/',sessionID:'s'}}
      if(b.action==='skillManage'){
        const input=b.management
        const result={...skill,content:'Use smooth easing.',document:'---\\nname: brand\\n---\\nUse smooth easing.',location:'D:/.opencode/skills/brand/SKILL.md',scope:'workspace',editable:true,token:'review',digest:'digest',backup:'D:/backup.bak',deleted:input.operation==='delete'}
        if(input.action==='apply' && input.operation==='edit')skill={...skill,...input.draft,revision:'c'.repeat(64)}
        if(input.action==='apply' && input.operation==='delete')skill=null
        return {result}
      }
      return {result:{sessionID:'s',directory:'D:/',status:'idle',workspaceConfirmed:true,messages:[]}}
    }}
    window.CookieMonsterChat({state,descriptor:{},heartbeat:async()=>{},panel:async()=>[]},{state:{credential:'test'},save(){}},api)
  })
  await page.locator('#chat-skills>summary').click()
  await page.locator('#chat-skill-picker').selectOption('0')
  await page.getByRole('button',{name:'Manage selected skill',exact:true}).click()
  await page.waitForFunction(()=>document.getElementById('skill-manager-content').value==='Use smooth easing.')
  for(const width of [320,360,700]){
    await page.setViewportSize({width,height:700})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    assert.equal(await page.evaluate(()=>document.getElementById('chat-form').getBoundingClientRect().bottom<=innerHeight),true,'Composer stays inside the panel with the manager open')
    await page.screenshot({path:'coverage/skill-manager-'+width+'.png'})
  }
  await page.getByRole('button',{name:'Copy skill',exact:true}).click()
  assert.match(await page.locator('#skill-manager-status').innerText(),/Copied/)
  await page.getByLabel('Skill name',{exact:true}).fill('brand-updated')
  await page.getByLabel('Skill instructions',{exact:true}).fill('Use slower easing.')
  await page.getByRole('button',{name:'Review changes',exact:true}).click()
  await page.getByRole('button',{name:'Confirm change',exact:true}).click()
  await page.waitForFunction(()=>document.getElementById('skill-manager-status').textContent.includes('Backup:'))
  await page.getByRole('button',{name:'Close',exact:true}).click()
  await page.locator('#chat-skill-picker').selectOption('0')
  await page.getByRole('button',{name:'Manage selected skill',exact:true}).click()
  await page.getByRole('button',{name:'Review deletion',exact:true}).click()
  await page.getByRole('button',{name:'Confirm change',exact:true}).click()
  await page.waitForFunction(()=>document.getElementById('skill-manager-status').textContent.includes('Deleted.'))
  const applied=await page.evaluate(()=>window.managementCalls.filter(c=>c.management?.action==='apply'))
  assert.equal(applied.length,2);assert.equal(applied[0].management.draft.name,'brand-updated');assert.equal(applied[1].management.operation,'delete')
  console.log('Skill management browser flow passed: copy, edit, review, save, delete and narrow layouts')
} finally {await browser.close()}
