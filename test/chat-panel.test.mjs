import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
function fixture() {
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
  const els={},readers=[],calls=[]
  const el=id=>els[id] ||= new Element()
  const client={state:{connection:'connected',project:{id:'one',path:'one.aep'},activeCompId:1,compositions:[{id:1,name:'Main'}]},descriptor:{}}
  let failSend=false, model=null, status='idle', failModel=false, refresh, holdState=false, releaseState
  const catalog=[{id:'sol',providerID:'test',name:'Sol',provider:'Test',variants:['low','high']},{id:'fast',providerID:'test',name:'Fast',provider:'Test',variants:[]}]
  const context={window:{addEventListener(){}},document:{getElementById:el,createElement:()=>new Element()},setInterval(fn){refresh=fn;},clearInterval(){},
    FileReader:class {readAsDataURL(file){this.file=file;readers.push(this)}}}
  vm.runInNewContext(readFileSync(new URL('../panel/chat.js',import.meta.url),'utf8'),context)
  const chat=context.window.CookieMonsterChat(client,{state:{credential:'test'},save(){}},{requestId:()=> 'a'.repeat(40),async request(d,c,p,b){calls.push(b);if(b.action==='state' && holdState){const prior=model;await new Promise(resolve=>{releaseState=resolve});return {result:{status:'idle',model:prior,messages:[],workspaces:[]}};}if(b.action==='send' && failSend)throw {code:'disconnected',message:'Disconnected'};if(b.action==='models')return {result:{models:catalog}};if(b.action==='model'){if(failModel)throw {message:'Model unavailable'};model=b.model;return {result:{model}};}return {result:b.action==='send'? {delivery:'accepted'}:{status,model,messages:[],workspaces:[]}}}})
  const tick=()=>new Promise(r=>setImmediate(r))
  const drop=(name='ref.png',size=10)=>el('chat-form').events.drop({preventDefault(){},dataTransfer:{files:[{name,size}]}})
  const finish=r=>{r.result='data:image/png;base64,SGVsbG8=';r.onload()}
  el('chat-input').value='Describe this';el('chat-input').events.input()
  return {el,chat,client,readers,calls,tick,drop,finish,refresh:()=>refresh(),releaseState:()=>releaseState(),set holdState(v){holdState=v},set failSend(v){failSend=v},set failModel(v){failModel=v},set status(v){status=v}}
}
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
  const f=fixture();await f.tick();f.drop('bad.exe');assert.match(f.el('chat-error').textContent,/Use PNG/)
  f.drop('big.png',3*1024*1024);assert.match(f.el('chat-error').textContent,/2 MB/);assert.equal(f.readers.length,0)
  f.drop();f.finish(f.readers[0]);f.failSend=true
  f.el('chat-form').events.submit({preventDefault(){}});await f.tick()
  assert.equal(f.el('chat-send').disabled,true);assert.equal(f.el('chat-attachments').children.length,1)
  f.el('chat-form').events.submit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.action==='send').length,1)
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
