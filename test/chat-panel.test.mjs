import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
function fixture(input = {}) {
  const saved = input instanceof Map ? input : new Map(), options = input instanceof Map ? {} : input;
  class Element {
    constructor(){this.children=[];this.events={};this.value='';this.disabled=false}
    set textContent(v){this.text=v;this.children=[]}
    get textContent(){return (this.text||'')+this.children.map(c=>c.textContent).join('')}
    appendChild(c){this.children.push(c);return c}
    addEventListener(k,f){this.events[k]=f}
    setAttribute(k,v){this[k]=v}
    focus(){}
    click(){this.events.click?.({})}
  }
  const els={},readers=[],calls=[],messages=[],panelCalls=[]
  let checkpointList=[], failRestore=false, restores=0
  const el=id=>els[id] ||= new Element()
  const client={state:{connection:'connected',project:{id:'one',path:'one.aep'},activeCompId:1,compositions:[{id:1,name:'Main'}]},descriptor:{}}
  client.context=()=>JSON.stringify(client.state.project)
  client.start=()=>{}
  client.heartbeat=async()=>{}
  client.panel=async(action,args)=>{panelCalls.push({action,args});if(action==='checkpoints')return checkpointList;client.restoreApproval={token:'review'};return {operation:'Save current project and restore checkpoint before the edit'};}
  client.confirmRestore=async()=>{restores++;client.restoreApproval=null;if(failRestore)throw {message:'Interrupted'};return {currentCheckpointId:'current-backup',emergencyPath:'backup.aep',warning:'Current work preserved.',recoveryCopy:false};}
  let failSend=false, model=null, status='idle', failModel=false, refresh, holdState=false, releaseState
  let skills=[], skillDirectory='D:\\\\workspace', sessionID='ses-test', failSkillSave=false
  const catalog=[{id:'sol',providerID:'test',name:'Sol',provider:'Test',variants:['low','high']},{id:'fast',providerID:'test',name:'Fast',provider:'Test',variants:[]}]
  const context={window:{addEventListener(){},localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}},document:{getElementById:el,createElement:()=>new Element()},setInterval(fn){refresh=fn;},clearInterval(){},
    FileReader:class {readAsDataURL(file){this.file=file;readers.push(this)}}}
  vm.runInNewContext(readFileSync(new URL('../panel/preferences.js',import.meta.url),'utf8'),context)
  vm.runInNewContext(readFileSync(new URL('../panel/chat.js',import.meta.url),'utf8'),context)
  const chat=context.window.CookieMonsterChat(client,{state:{credential:'test'},save(){}},{requestId:()=> 'a'.repeat(40),async request(d,c,p,b){calls.push(b);if(options.request){const result=await options.request(b);if(result)return {result};}if(b.action==='skillManage')return {result:{name:b.management.selected.name,source:b.management.selected.source,revision:b.management.selected.revision,scope:'workspace',editable:true,content:'Original skill',description:'Description',location:'skills/test/SKILL.md',token:'review',digest:'digest',backup:'skills/test/backup.bak',deleted:b.management.operation==='delete'}};if(b.action==='retryDraft')return {result:{sessionID,messageID:b.messageID,text:'Original request',attachments:[{filename:'ref.txt',mime:'text/plain',url:'data:text/plain;base64,SGVsbG8='}]}};if(b.action==='skills')return {result:{skills,directory:skillDirectory,sessionID}};if(b.action==='skillReview')return {result:{token:'review',directory:skillDirectory,destination:'skills/'+b.draft.name+'/SKILL.md'}};if(b.action==='skillSave'){if(failSkillSave)throw {message:'Save not confirmed'};return {result:{name:b.draft.name,destination:'SKILL.md'}};}if(b.action==='checkpoints')return {result:{checkpoints:checkpointList}};if(b.action==='state' && holdState){const prior=model;await new Promise(resolve=>{releaseState=resolve});return {result:{status:'idle',model:prior,messages:[],workspaces:[]}};}if(b.action==='send' && failSend)throw {code:'disconnected',message:'Disconnected'};if(b.action==='models')return {result:{models:catalog}};if(b.action==='model'){if(failModel)throw {message:'Model unavailable'};model=b.model;return {result:{model}};}return {result:b.action==='send'? {delivery:'accepted'}:{status,model,sessionID,directory:skillDirectory,messages,workspaces:[skillDirectory]}}}})
  const tick=()=>new Promise(r=>setImmediate(r))
  const drop=(name='ref.png',size=10)=>el('chat-form').events.drop({preventDefault(){},dataTransfer:{files:[{name,size}]}})
  const finish=r=>{r.result='data:image/png;base64,SGVsbG8=';r.onload()}
  el('chat-input').value='Describe this';el('chat-input').events.input()
  return {el,chat,client,readers,calls,tick,drop,finish,messages,panelCalls,set skills(v){skills=v},set skillDirectory(v){skillDirectory=v},set sessionID(v){sessionID=v},set failSkillSave(v){failSkillSave=v},set checkpointList(v){checkpointList=v},set failRestore(v){failRestore=v},get restores(){return restores},refresh:()=>refresh(),releaseState:()=>releaseState(),set holdState(v){holdState=v},set failSend(v){failSend=v},set failModel(v){failModel=v},set status(v){status=v}}
}
test('workspace picker shows exact suggestions, preserves choices and resets on project switches',async()=>{
  let directory='/Projects/one', workspaces=['/unrelated'], sessionID=null
  const f=fixture({request:async b=>{
    if(b.action==='state')return {status:'idle',messages:[],directory,workspaces,sessionID}
  }})
  await f.tick()
  const picker=f.el('chat-workspace')
  assert.equal(picker.value,directory)
  assert.equal(picker.hidden,false)
  assert.match(picker.textContent,/open in CookieMonster/)
  assert.equal(f.calls.find(c=>c.action==='models').directory,directory)
  picker.value='/unrelated';picker.events.change.call(picker);await f.tick()
  await f.refresh()
  assert.equal(picker.value,'/unrelated')
  assert.equal(f.calls.filter(c=>c.action==='state').at(-1).directory,'/unrelated')
  assert.equal(f.calls.filter(c=>c.action==='models').at(-1).directory,'/unrelated')
  workspaces=['/unrelated','/another'];await f.refresh()
  assert.equal(picker.value,'/unrelated')
  f.el('chat-form').events.submit({preventDefault(){}})
  assert.equal(picker.disabled,true)
  await f.tick()
  assert.equal(f.calls.find(c=>c.action==='send').directory,'/unrelated')
  directory='/Projects/two'
  f.chat.update({...f.client.state,project:{id:'two',path:'/Projects/two/title.aep'}})
  assert.equal(picker.value,'')
  await f.refresh()
  assert.equal(picker.value,directory)
  assert.equal(f.calls.filter(c=>c.action==='state').at(-1).directory,undefined)
  sessionID='saved-chat';directory='/persisted';await f.refresh()
  assert.equal(picker.value,'/persisted')
  assert.equal(picker.disabled,true)
})

test('unsaved picker never silently selects the sole registered workspace',async()=>{
  const f=fixture({request:async b=>{
    if(b.action==='state')return {status:'idle',messages:[],directory:null,workspaces:['/unrelated']}
    if(b.action==='models')return {models:[],needsWorkspace:true,workspaceError:'Save the After Effects project or select a workspace in CookieMonster.'}
  }})
  await f.tick()
  const picker=f.el('chat-workspace')
  assert.equal(picker.value,'')
  assert.equal(picker.hidden,false)
  assert.equal(picker.disabled,false)
  assert.match(f.el('chat-model-status').textContent,/Save.*select a workspace/)
  f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  assert.equal(f.calls.find(c=>c.action==='send').directory,undefined)
})

test('workspace changes discard an in-flight catalog and reload for the selected directory',async()=>{
  let release, hold=true
  const model=id=>({id,providerID:'test',name:id,provider:'Test',variants:[]})
  const f=fixture({request:async b=>{
    if(b.action==='state')return {status:'idle',messages:[],directory:b.directory || '/project',workspaces:['/project','/chosen']}
    if(b.action==='models'){
      if(hold){hold=false;await new Promise(resolve=>{release=resolve})}
      return {models:[model(b.directory)]}
    }
  }})
  await f.tick()
  const picker=f.el('chat-workspace')
  picker.value='/chosen';picker.events.change.call(picker)
  assert.equal(f.el('chat-model').disabled,true)
  release();await f.tick()
  assert.equal(f.calls.filter(c=>c.action==='models').at(-1).directory,'/chosen')
  assert.match(f.el('chat-model').textContent,/chosen/)
  assert.doesNotMatch(f.el('chat-model').textContent,/project/)
})

test('composer capture freezes the pinned composition and time, previews alpha, removes and submits a file part',async()=>{
  const f=fixture();await f.tick()
  const state={...f.client.state,project:{id:'one',path:'one.aep',saved:true},compositions:[{id:1,name:'Main',time:0.5},{id:2,name:'Pinned',time:1.25}]}
  f.client.state=state;f.chat.update(state);f.el('chat-comp').value='2';f.el('chat-comp').events.change()
  let finish
  f.client.panel=async(action,args)=>{f.panelCalls.push({action,args});return new Promise(resolve=>{finish=()=>resolve({compId:args.compId,time:args.time,attachment:{mime:'image/png',url:'data:image/png;base64,AAAA'}})})}
  f.el('chat-capture').click();await f.tick()
  assert.equal(f.panelCalls[0].action,'frame.capture')
  assert.equal(f.panelCalls[0].args.compId,2);assert.equal(f.panelCalls[0].args.time,1.25)
  assert.equal(f.el('chat-send').disabled,true)
  f.chat.update({...state,activeCompId:1,compositions:[{id:1,name:'Main',time:1},{id:2,name:'Pinned',time:2}]})
  finish();await f.tick()
  assert.match(f.el('chat-attachments').textContent,/Pinned \(#2\).*1.250s.*alpha/)
  f.el('chat-attachments').children[0].children.at(-1).click()
  assert.equal(f.el('chat-attachments').children.length,0)
  f.el('chat-capture').click();await f.tick();finish();await f.tick()
  f.el('chat-input').value='Use this frame';f.el('chat-input').events.input();f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  const sent=f.calls.find(c=>c.action==='send')
  assert.equal(sent.attachments[0].mime,'image/png');assert.match(sent.attachments[0].filename,/ae-comp-2-at-2s/)
})

test('capture discards project changes, respects attachment count and blocks uncertain retries',async()=>{
  const f=fixture();await f.tick()
  const state={...f.client.state,project:{id:'one',path:'one.aep',saved:true},compositions:[{id:1,name:'Main',time:0}]}
  f.client.state=state;f.chat.update(state)
  let finish,captures=0
  f.client.panel=async()=>{captures++;return new Promise(resolve=>{finish=()=>resolve({compId:1,time:0,attachment:{mime:'image/png',url:'data:image/png;base64,AAAA'}})})}
  f.el('chat-capture').click();await f.tick()
  const next={...state,project:{id:'two',path:'two.aep',saved:true}}
  f.client.state=next;f.chat.update(next);finish();await f.tick()
  assert.equal(f.el('chat-attachments').children.length,0)
  for(let i=0;i<4;i++){f.drop('ref'+i+'.png');f.finish(f.readers[i])}
  assert.equal(f.el('chat-capture').disabled,true)
  f.el('chat-capture').click();assert.equal(captures,1)
  f.el('chat-attachments').children[0].children.at(-1).click()
  f.client.panel=async()=>{captures++;throw {code:'capture_timeout',message:'Native frame still pending'}}
  f.el('chat-capture').click();await f.tick()
  assert.equal(f.client.state.uncertain,true);assert.equal(f.el('chat-capture').disabled,true)
  assert.match(f.el('chat-error').textContent,/No automatic retry/)
  f.el('chat-capture').click();assert.equal(captures,2)
})

test('captured frames share the remaining byte budget with uploaded references',async()=>{
  const f=fixture();await f.tick()
  const state={...f.client.state,project:{id:'one',path:'one.aep',saved:true},compositions:[{id:1,name:'Main',time:0}]}
  f.client.state=state;f.chat.update(state)
  f.drop('large.png',10*1024*1024-2);f.finish(f.readers[0])
  f.client.panel=async()=>({compId:1,time:0,attachment:{mime:'image/png',url:'data:image/png;base64,AAAA'}})
  f.el('chat-capture').click();await f.tick()
  assert.equal(f.el('chat-attachments').children.length,1)
  assert.match(f.el('chat-error').textContent,/remaining attachment limit/)
  assert.equal(f.client.state.uncertain,undefined)
  assert.equal(f.el('chat-capture').disabled,false)
})

test('skill picker searches and clears on workspace, session and project changes',async()=>{
  const f=fixture();await f.tick()
  f.skills=[{name:'brand-motion',description:'Logo easing',source:'b'.repeat(64),revision:'c'.repeat(64)},{name:'titles',description:'Text',source:'d'.repeat(64),revision:'e'.repeat(64)}]
  f.el('chat-skills-refresh').click();await f.tick()
  f.el('chat-skill-search').value='logo';f.el('chat-skill-search').events.input()
  assert.equal(f.el('chat-skill-picker').children.length,2)
  f.el('chat-skill-picker').value='0';f.el('chat-skill-picker').events.change.call(f.el('chat-skill-picker'))
  assert.match(f.el('chat-skill-status').textContent,/Selected: brand-motion \(not loaded\)/)
  f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  assert.equal(f.calls.find(c=>c.action==='send').skill.name,'brand-motion')
  f.sessionID='new-session';await f.refresh()
  assert.equal(f.el('chat-skill-picker').value,'')
  f.el('chat-skills-refresh').click();await f.tick()
  f.el('chat-skill-picker').value='0';f.el('chat-skill-picker').events.change.call(f.el('chat-skill-picker'))
  f.el('chat-workspace').events.change()
  assert.equal(f.el('chat-skill-picker').value,'')
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}})
  assert.equal(f.el('chat-skill-picker').value,'')
  assert.equal(f.el('chat-workspace').value,'')
})

test('save technique drafts only completed reply text, reviews edits, and never retries failed saves',async()=>{
  const f=fixture()
  f.messages.push({id:'answer',role:'assistant',completed:true,parts:[
    {type:'reasoning',text:'Not a technique'},
    {type:'text',text:'Keep logo fixed.'},{type:'text',text:'Use ease out.'},
  ]})
  await f.tick()
  f.el('chat-messages').children[0].children.at(-1).click()
  assert.equal(f.el('technique-instructions').value,'Keep logo fixed.\n\nUse ease out.')
  assert.equal(f.calls.some(c=>c.action==='skillSave'),false)
  f.el('technique-name').value='brand-motion';f.el('technique-description').value='Logo easing'
  f.el('technique-review-button').click();await f.tick()
  assert.equal(f.el('technique-confirm').hidden,false)
  assert.match(f.el('technique-review').textContent,/This CM workspace/)
  f.el('technique-instructions').value='Edited';f.el('technique-instructions').events.input()
  assert.equal(f.el('technique-confirm').hidden,true)
  f.el('technique-review-button').click();await f.tick()
  f.failSkillSave=true;f.el('technique-confirm').click();await f.tick()
  assert.equal(f.calls.filter(c=>c.action==='skillSave').length,1)
  assert.equal(f.calls.find(c=>c.action==='skillSave').draft.instructions,'Edited')
  f.el('technique-confirm').click();await f.tick()
  assert.equal(f.calls.filter(c=>c.action==='skillSave').length,1)
  assert.match(f.el('technique-status').textContent,/No automatic retry/)
})

test('message restore uses the first checkpoint for its exact parent request and opens review only',async()=>{
  const f=fixture()
  f.checkpointList=[{id:'before-one'},{id:'later-one'}]
  f.messages.push({id:'one',role:'user',parts:[{type:'text',text:'Edit this'}]},
    {id:'two',role:'user',parts:[{type:'text',text:'Another request'}]},
    {role:'assistant',parentID:'one',parts:[{type:'checkpoint',id:'before-one',label:'Before edit'},{type:'checkpoint',id:'later-one',label:'Later edit'}]})
  await f.tick()
  const rows=f.el('chat-messages').children
  const restore=rows[0].children.at(-1).children.at(-1)
  const unrelated=rows[1].children.at(-1).children.at(-1)
  assert.equal(restore.disabled,false)
  assert.equal(unrelated.disabled,true)
  restore.click();await f.tick()
  assert.equal(f.panelCalls.at(-1).args.id,'before-one')
  assert.equal(f.restores,0)
  assert.equal(f.el('chat-restore-review').hidden,false)
})

test('disclosures preserve manual choices during streaming and reset with the project',async()=>{
  const f=fixture();f.status='busy'
  const message={id:'stream',role:'assistant',parts:[{id:'tool',type:'tool',text:'ae_inspect · running'},
    {id:'image',type:'image',url:'data:image/png;base64,SGVsbG8=',filename:'Frame'},
    {id:'answer',type:'text',text:'A'.repeat(1300)}]}
  f.messages.push(message);await f.tick();await f.refresh()
  const row=()=>f.el('chat-messages').children[0]
  assert.equal(row().children[1].open,true)
  assert.equal(row().children[2].open,false)
  assert.equal(row().children[3].open,false)
  row().children[1].children[0].events.click({preventDefault(){}})
  row().children[2].children[0].events.click({preventDefault(){}})
  message.parts.push({id:'reason',type:'reasoning',text:'Reported reasoning summary'})
  await f.refresh()
  assert.equal(row().children[1].open,false)
  assert.equal(row().children[2].open,true)
  assert.match(row().children[1].textContent,/Reported reasoning summary/)
  f.status='idle';await f.refresh()
  assert.equal(row().children[1].open,false)
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}});await f.refresh()
  assert.equal(row().children[2].open,false)
})

test('activity preference sets defaults while preserving manual disclosure choices across reload',async()=>{
  const saved=new Map([['cookiejar-presentation-v1',JSON.stringify({activity:'expanded'})]])
  const f=fixture(saved);f.messages.push({id:'pref',role:'assistant',completed:true,parts:[{type:'reasoning',text:'Reported details'}]})
  await f.tick();await f.refresh();const details=f.el('chat-messages').children[0].children[1]
  assert.equal(details.open,true);details.children[0].events.click({preventDefault(){}})
  const again=fixture(saved);again.messages.push(...f.messages);await again.tick();await again.refresh()
  assert.equal(again.el('chat-messages').children[0].children[1].open,false)
})

test('activity automatically collapses when streaming ends without a manual choice',async()=>{
  const f=fixture();f.status='busy';f.messages.push({id:'stream',role:'assistant',parts:[{type:'tool',text:'Running'}]})
  await f.tick();await f.refresh();assert.equal(f.el('chat-messages').children[0].children[1].open,true)
  f.status='idle';await f.refresh();assert.equal(f.el('chat-messages').children[0].children[1].open,false)
})

test('older turns collapse together and manual choices survive a panel reload',async()=>{
  const saved=new Map()
  const conversation=Array.from({length:4},(_,i)=>[
    {id:'user-'+i,role:'user',parts:[{type:'text',text:'Request '+i}]},
    {id:'answer-'+i,role:'assistant',parentID:'user-'+i,parts:[{type:'text',text:'Answer '+i}]},
  ]).flat()
  const first=fixture(saved);first.messages.push(...conversation);await first.tick();await first.refresh()
  const turns=()=>first.el('chat-messages').children.filter(c=>c.className==='chat-disclosure chat-turn')
  assert.equal(turns().length,2)
  assert.equal(turns()[0].open,false)
  assert.match(turns()[0].textContent,/Answer 0/)
  turns()[0].children[0].events.click({preventDefault(){}})
  assert.equal(turns()[0].open,true)
  const reloaded=fixture(saved);reloaded.messages.push(...conversation);await reloaded.tick();await reloaded.refresh()
  const restored=reloaded.el('chat-messages').children.filter(c=>c.className==='chat-disclosure chat-turn')
  assert.equal(restored[0].open,true)
  assert.equal(restored[1].open,false)
})

test('model picker saves supported reasoning and clears it when switching models',async()=>{
  const f=fixture();await f.tick()
  assert.equal(f.el('chat-model').disabled,false)
  f.el('chat-model').value=JSON.stringify(['test','sol']);f.el('chat-model').events.change()
  assert.equal(f.el('chat-send').disabled,true);await f.tick()
  assert.equal(f.el('chat-reasoning').children.length,3)
  f.el('chat-reasoning').value='high';f.el('chat-reasoning').events.change();await f.tick()
  assert.equal(f.calls.filter(c=>c.action==='model').at(-1).model.variant,'high')
  f.el('chat-model').value=JSON.stringify(['test','fast']);f.el('chat-model').events.change();await f.tick()
  assert.equal(f.calls.filter(c=>c.action==='model').at(-1).model.variant,'default')
  assert.equal(f.el('chat-reasoning').disabled,true)
  f.chat.update({...f.client.state,connection:'disconnected'})
  assert.equal(f.el('chat-model').disabled,true);assert.match(f.el('chat-model-status').textContent,/Connect/)
})

test('failed model save restores confirmed selection and exposes the error',async()=>{
  const f=fixture();await f.tick()
  f.el('chat-model').value=JSON.stringify(['test','sol']);f.el('chat-model').events.change();await f.tick()
  f.failModel=true;f.el('chat-model').value=JSON.stringify(['test','fast']);f.el('chat-model').events.change();await f.tick()
  assert.equal(f.el('chat-model').value,JSON.stringify(['test','sol']))
  assert.match(f.el('chat-model-status').textContent,/unavailable/)
})
test('drop previews, removal before send and fixed comp delivery',async()=>{
  const f=fixture();await f.tick();f.drop();assert.equal(f.el('chat-send').disabled,true)
  f.finish(f.readers[0]);assert.equal(f.el('chat-attachments').children.length,1)
  f.el('chat-attachments').children[0].children.at(-1).click()
  assert.equal(f.el('chat-attachments').children.length,0)
  f.drop('brief.txt');f.finish(f.readers[1]);f.el('chat-form').events.submit({preventDefault(){}})
  f.client.state.activeCompId=2;await f.tick()
  const sent=f.calls.find(c=>c.action==='send');assert.equal(sent.compId,1);assert.equal(sent.attachments.length,1);assert.equal(sent.attachments[0].mime,'text/plain')
  assert.equal(f.el('chat-attachments').children.length,0)
})
test('paste and browse work; project change discards pending reads',async()=>{
  const f=fixture();await f.tick()
  f.el('chat-input').events.paste({preventDefault(){},clipboardData:{files:[{name:'image.png',size:10}]}})
  f.el('chat-files').files=[{name:'brief.pdf',size:10}];f.el('chat-files').events.change.call(f.el('chat-files'))
  assert.equal(f.readers.length,2)
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}})
  f.readers.forEach(f.finish);assert.equal(f.el('chat-attachments').children.length,0);assert.equal(f.el('chat-input').value,'')
})
test('unsupported and oversized files are rejected, uncertain delivery cannot resubmit',async()=>{
  const f=fixture();await f.tick();f.drop('bad.exe');assert.match(f.el('chat-error').textContent,/Use images/)
  f.drop('big.png',11*1024*1024);assert.match(f.el('chat-error').textContent,/10 MB/);assert.equal(f.readers.length,0)
  f.drop();f.finish(f.readers[0]);f.failSend=true
  f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  assert.equal(f.el('chat-send').disabled,true);assert.equal(f.el('chat-attachments').children.length,1)
  f.el('chat-form').events.submit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.action==='send').length,1)
})


test('attachment dialogs wait for host polling and prevent new scripts until closed',async()=>{
  const {default:transport}=await import('../panel/transport.cjs')
  let calls=0
  const host={pending:true,call(){calls++;return Promise.reject(new Error('Script ran during modal'))}}
  const client=new transport.Client({host,store:{state:{}},changed(){}})
  let opened=false
  const requests=[]
  client.state.connection='connected'
  client.send=async(path,body)=>{requests.push({path,body});return {binding:null,lock:null}}
  const ready=client.beginFileDialog().then(()=>{opened=true})
  await client.tick();assert.equal(calls,0);assert.equal(opened,false)
  host.pending=false;await ready
  assert.equal(opened,true);await client.tick();assert.equal(calls,0)
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/heartbeat');assert.equal(requests[0].body.busy,true)
  await assert.rejects(client.status(),{code:'host_busy'});assert.equal(calls,0)
  client.endFileDialog();assert.equal(client.fileDialogOpen,false)
})

test('AE file dialogs defer read-only status without creating uncertain edits or repeated calls',async()=>{
  const {default:transport}=await import('../panel/transport.cjs')
  let callback,calls=0,late
  const host=new transport.HostRPC({evalScript(source,cb){calls++;callback=cb}},10,(method)=>{late=method})
  await assert.rejects(host.call('status',{}),{code:'host_busy'})
  assert.equal(host.pending,true);assert.equal(host.uncertain,false)
  const client=new transport.Client({host,store:{state:{}},changed(){}})
  await client.tick();assert.equal(calls,1)
  callback(JSON.stringify({result:{}}));assert.equal(host.pending,false);assert.equal(late,'status')
  await assert.rejects(host.call('execute',{}),{code:'outcome_uncertain'})
  assert.equal(host.uncertain,true)
  callback(JSON.stringify({result:{}}))
})


test('an older state poll cannot overwrite a newly confirmed model',async()=>{
  const f=fixture();await f.tick()
  f.el('chat-model').value=JSON.stringify(['test','sol']);f.el('chat-model').events.change();await f.tick()
  f.holdState=true;const pending=f.refresh();await f.tick()
  f.el('chat-model').value=JSON.stringify(['test','fast']);f.el('chat-model').events.change();await f.tick()
  assert.equal(f.el('chat-model').value,JSON.stringify(['test','fast']))
  f.holdState=false;f.releaseState();await pending
  assert.equal(f.el('chat-model').value,JSON.stringify(['test','fast']))
})


test('chat checkpoint cards review exact operation, preserve work, and never retry failed restores',async()=>{
  const f=fixture();f.client.state.binding={sessionID:'ses-test',state:'active'};f.checkpointList=[{id:'cp-one'}]
  f.messages.push({role:'assistant',parts:[{type:'checkpoint',id:'cp-one',label:'Before this edit'}]});await f.tick()
  const card=f.el('chat-messages').children[0].children[1],button=card.children[2]
  assert.equal(button.disabled,false);button.click();await f.tick()
  assert.equal(f.el('chat-restore-review').hidden,false)
  assert.match(f.el('chat-restore-operation').textContent,/Save current/)
  assert.equal(f.el('chat-send').disabled,true)
  f.el('chat-restore-cancel').click();assert.equal(f.restores,0)
  button.click();await f.tick();f.failRestore=true
  f.el('chat-restore-confirm').click();await f.tick()
  assert.equal(f.restores,1);assert.match(f.el('chat-restore-status').textContent,/not confirmed/)
  f.el('chat-restore-confirm').click();await f.tick();assert.equal(f.restores,1)
})

test('pending restore suppresses chat polling through temporary project changes',async()=>{
  const f=fixture();f.client.state.binding={sessionID:'ses-test',state:'active'};f.checkpointList=[{id:'cp-one'}]
  f.messages.push({role:'assistant',parts:[{type:'checkpoint',id:'cp-one',label:'Before this edit'}]});await f.tick()
  f.el('chat-messages').children[0].children[1].children[2].click();await f.tick()
  let finish;f.client.confirmRestore=()=>new Promise(resolve=>{finish=resolve})
  f.el('chat-restore-confirm').click();await f.tick()
  f.chat.update({...f.client.state,project:{id:'emergency',path:'emergency.aep'}})
  const count=f.calls.length;await f.refresh();assert.equal(f.calls.length,count)
  f.chat.update(f.client.state);finish({currentCheckpointId:'backup',emergencyPath:'emergency.aep',warning:'Retained'})
  await f.tick();assert.match(f.el('chat-restore-status').textContent,/restored/)
})

test('checkpoint cards reject foreign ownership and stale reviews',async()=>{
  const f=fixture();f.client.state.binding={sessionID:'ses-test',state:'active'};f.checkpointList=[{id:'cp-one'}]
  f.messages.push({role:'assistant',parts:[{type:'checkpoint',id:'cp-one',label:'Before this edit'}]});await f.tick()
  const button=f.el('chat-messages').children[0].children[1].children[2]
  button.click();await f.tick();f.client.restoreApproval=null;f.chat.update(f.client.state)
  assert.equal(f.el('chat-restore-review').hidden,true)
  f.el('chat-restore-confirm').click();assert.equal(f.restores,0)
  f.chat.update({...f.client.state,binding:{sessionID:'foreign'}})
  assert.equal(button.disabled,true)
})

test('oversized restore review explains the limit without claiming a restore',async()=>{
  const f=fixture();f.client.state.binding={sessionID:'ses-test',state:'active'};f.checkpointList=[{id:'cp-one'}]
  f.messages.push({role:'assistant',parts:[{type:'checkpoint',id:'cp-one',label:'Before this edit'}]});await f.tick()
  f.client.panel=async()=>{throw {code:'response_too_large',message:'Review response too large'}}
  f.el('chat-messages').children[0].children[1].children[2].click();await f.tick()
  assert.match(f.el('chat-error').textContent,/review exceeded its response limit/)
  assert.equal(f.el('chat-restore-review').hidden,true);assert.equal(f.restores,0)
})

test('unsupported compact restore explains compatibility without falling back or confirming',async()=>{
  const f=fixture();f.client.state.binding={sessionID:'ses-test',state:'active'};f.checkpointList=[{id:'cp-one'}]
  f.messages.push({role:'assistant',parts:[{type:'checkpoint',id:'cp-one',label:'Before this edit'}]});await f.tick()
  let calls=0
  f.client.panel=async()=>{calls++;throw {code:'restore_unsupported',message:'Legacy host'}}
  f.el('chat-messages').children[0].children[1].children[2].click();await f.tick()
  assert.match(f.el('chat-error').textContent,/matching compact-restore support/)
  assert.equal(f.el('chat-restore-review').hidden,true);assert.equal(f.restores,0)
  await f.refresh();assert.equal(calls,1)
})

test('project checkpoint picker reviews a selected checkpoint without a message card and blocks busy restores',async()=>{
  const f=fixture();await f.tick()
  const toggle=f.el('chat-checkpoints-toggle'),review=f.el('chat-checkpoint-review')
  f.checkpointList=[{id:'older',createdAt:'2026-09-10T10:00:00Z'},{id:'newer',createdAt:'2026-09-11T10:00:00Z'}]
  toggle.events.click.call(toggle);await f.tick()
  assert.equal(f.el('chat-checkpoints').hidden,false)
  assert.equal(f.el('chat-checkpoint-picker').value,'newer')
  assert.equal(review.disabled,false)
  f.el('chat-checkpoint-picker').value='older';f.el('chat-checkpoint-picker').events.change()
  review.events.click.call(review);await f.tick()
  assert.equal(f.panelCalls.at(-1).args.id,'older')
  assert.equal(f.restores,0)
  assert.equal(f.el('chat-restore-review').hidden,false)
  f.el('chat-restore-cancel').click()
  f.status='busy';await f.refresh()
  assert.equal(review.disabled,true)
  const count=f.panelCalls.length;review.events.click.call(review);await f.tick()
  assert.equal(f.panelCalls.length,count)
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}})
  assert.equal(f.el('chat-checkpoints').hidden,true)
  assert.equal(f.el('chat-checkpoint-picker').value,'')
})


test('a rendering failure releases the poll latch and later refreshes recover',async()=>{
  const f=fixture();await f.tick()
  const box=f.el('chat-messages'),append=box.appendChild
  f.messages.push({id:'reply',role:'assistant',completed:true,error:'Login required',parts:[]})
  box.appendChild=()=>{throw new Error('Render failed')}
  await f.refresh()
  assert.match(f.el('chat-error').textContent,/Render failed/)
  box.appendChild=append
  await f.refresh()
  assert.match(box.textContent,/Login required/)
  assert.equal(f.el('chat-progress').textContent,'Ready')
})


test('edit and retry reviews originals, preserves the draft on cancel and never sends on click',async()=>{
  const f=fixture();await f.tick()
  f.messages.push({id:'msg_original',role:'user',parts:[{type:'text',text:'Display text'}]})
  await f.refresh();await f.tick()
  function find(element,label){if(element.textContent===label && element.events.click)return element;for(const child of element.children){const found=find(child,label);if(found)return found;}}
  const retry=()=>find(f.el('chat-messages'),'Edit and retry')
  retry().click();await f.tick()
  assert.equal(f.el('chat-input').value,'Original request')
  assert.match(f.el('chat-attachments').textContent,/ref.txt/)
  assert.equal(f.calls.filter(c=>c.action==='send').length,0)
  f.el('chat-retry-cancel').click()
  assert.equal(f.el('chat-input').value,'Describe this')
  assert.equal(f.el('chat-attachments').children.length,0)
  retry().click();await f.tick()
  f.el('chat-input').value='Edited request'
  f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  const sent=f.calls.find(c=>c.action==='send')
  assert.equal(sent.text,'Edited request');assert.equal(sent.retryMessageID,'msg_original')
  assert.equal(sent.attachments[0].filename,'ref.txt');assert.equal(f.el('chat-retry-note').hidden,true)
  f.status='busy';await f.refresh();assert.equal(retry().disabled,true)
})


test('a retry draft arriving after a project change is discarded',async()=>{
  const f=fixture();await f.tick()
  f.messages.push({id:'msg_original',role:'user',parts:[{type:'text',text:'Request'}]})
  await f.refresh();await f.tick()
  const row=f.el('chat-messages').children.find(c=>c.className==='chat-message from-user')
  row.children.at(-1).children[0].click()
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}})
  await f.tick()
  assert.notEqual(f.el('chat-input').value,'Original request')
  assert.equal(f.el('chat-attachments').children.length,0)
  assert.equal(f.el('chat-retry-note').hidden,true)
  assert.equal(f.calls.filter(c=>c.action==='send').length,0)
})


test('skill manager reviews edits and deletion before applying, and resets on project changes',async()=>{
  const f=fixture();await f.tick()
  f.skills=[{name:'test',source:'a'.repeat(64),revision:'b'.repeat(64)}]
  f.el('chat-skills-refresh').click();await f.tick()
  f.el('chat-skill-picker').value='0';f.el('chat-skill-picker').events.change.call(f.el('chat-skill-picker'))
  f.el('chat-skill-manage').click();await f.tick()
  assert.equal(f.el('skill-manager-content').value,'Original skill')
  assert.equal(f.el('chat-send').disabled,true)
  f.el('skill-manager-content').value='Changed skill';f.el('skill-manager-content').events.input()
  f.el('skill-manager-edit').click();await f.tick()
  assert.equal(f.calls.filter(c=>c.management?.action==='apply').length,0)
  f.el('skill-manager-content').events.input()
  assert.equal(f.el('skill-manager-confirm').hidden,true)
  f.el('skill-manager-edit').click();await f.tick()
  f.el('skill-manager-confirm').click();await f.tick()
  assert.equal(f.calls.find(c=>c.management?.action==='apply').management.draft.instructions,'Changed skill')
  assert.match(f.el('skill-manager-status').textContent,/Backup/)
  f.el('skill-manager-close').click()
  f.el('chat-skill-picker').value='0';f.el('chat-skill-picker').events.change.call(f.el('chat-skill-picker'))
  f.el('chat-skill-manage').click();await f.tick();f.el('skill-manager-delete').click();await f.tick()
  f.el('skill-manager-confirm').click();await f.tick()
  assert.equal(f.calls.filter(c=>c.management?.action==='apply').at(-1).management.operation,'delete')
  f.chat.update({...f.client.state,project:{id:'two',path:'two.aep'}})
  assert.equal(f.el('skill-manager').hidden,true)
})

test('expanded attachments accept GIF and code files and allow more than 2 MiB',async()=>{
 const f=fixture();await f.tick()
 f.drop('animation.gif',3*1024*1024);f.finish(f.readers[0])
 f.drop('animation.jsx',20);f.finish(f.readers[1])
 f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
 const sent=f.calls.find(c=>c.action==='send')
 assert.equal(sent.attachments[0].mime,'image/gif');assert.equal(sent.attachments[1].mime,'text/plain')
})
