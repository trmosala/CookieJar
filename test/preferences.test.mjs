import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import {readFileSync} from "node:fs"
const source=readFileSync(new URL("../panel/preferences.js",import.meta.url),"utf8")
function load(storage){const window={localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}},document={getElementById:()=>null,documentElement:{setAttribute(){}}};vm.runInNewContext(source,{window,document});return window.CookieJarPreferences}
test("preferences persist only bounded presentation values and reset without touching other storage",()=>{
  const storage=new Map([["credential","secret"],["recovery","uncertain"]]);let p=load(storage)
  assert.equal(p.get().activity,"auto");p.set({textSize:"large",density:"compact",sendKey:"modifier",activity:"expanded",permission:"allow"})
  p=load(storage);assert.equal(p.get().textSize,"large");assert.equal(p.get().sendKey,"modifier")
  assert.equal(p.get().permission,undefined);p.reset();assert.equal(p.get().density,"comfortable")
  assert.equal(storage.get("credential"),"secret");assert.equal(storage.get("recovery"),"uncertain")
  for(const raw of ['{', 'null', '[1]', '{"textSize":900,"density":"unsafe"}', 'x'.repeat(3000)]){
    storage.set("cookiejar-presentation-v1",raw);assert.equal(load(storage).get().textSize,"normal")
  }
})
test("send key preserves multiline, modifiers and IME composition",()=>{
  const p=load(new Map())
  assert.equal(p.shouldSend({key:"Enter"}),true)
  for(const extra of [{shiftKey:true},{isComposing:true},{keyCode:229},{altKey:true},{ctrlKey:true}])assert.equal(p.shouldSend({key:"Enter",...extra}),false)
  p.set({...p.get(),sendKey:"modifier"})
  assert.equal(p.shouldSend({key:"Enter"}),false)
  assert.equal(p.shouldSend({key:"Enter",ctrlKey:true}),true)
  assert.equal(p.shouldSend({key:"Enter",metaKey:true}),true)
  assert.equal(p.shouldSend({key:"Enter",metaKey:true,isComposing:true}),false)
})
