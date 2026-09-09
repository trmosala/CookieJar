import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import transport from "../panel/transport.cjs";

const restoreOperation = "First save and verify a checkpoint of the current state, including unsaved edits. Then open a verified recovery copy; canonical file NOT replaced. Save As, rebind and reviewed reconciliation required."
function fixture(...args) {
    const operation=args.length ? args[0] : restoreOperation;
    const html=fs.readFileSync(new URL("../panel/index.html",import.meta.url),"utf8");
    class Element {
        constructor(tag="div"){this.tag=tag;this.children=[];this.events={};this.value="";this.hidden=false;this.disabled=false;this.checked=false;this._text="";}
        set textContent(v){this._text=v;this.children=[];if(this.tag==="select")this.value="";}
        get textContent(){return this._text+this.children.map(e=>e.textContent).join("");}
        appendChild(child){this.children.push(child);if(this.tag==="select" && this.children.length===1)this.value=child.value;return child;}
        addEventListener(name,fn){this.events[name]=fn;}
        removeAttribute(name){delete this[name];}
        focus(){this.focused=true;}
    }
    const elements={};
    for(const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)){
        const e=new Element(match[1]);e.hidden=/\bhidden\b/.test(match[0]);e.disabled=/\bdisabled\b/.test(match[0]);elements[match[2]]=e;
    }
    const calls=[],blobs=[],revoked=[],intervals=[],events={};
    let client,confirm=true;
    const project={id:"project",path:"C:/safe.aep",saved:true};
    const store={state:{panelId:"ui-panel",credential:"a".repeat(43),uncertain:false},save(){},close(){}};
    const request=async(d,c,endpoint,body)=>{
        calls.push({endpoint,body:structuredClone(body)});
        const action=body.action;
        if(action==="checkpoints")return {result:[{id:"checkpoint-1",createdAt:1000,pinned:false,storageMode:"project",size:123}]};
        if(action==="renders")return {result:[{id:"job-1",state:"running",path:"DO NOT DISPLAY"}]};
        if(action==="checkpoint.restore.propose")return {result:{token:"SECRET-RESTORE-TOKEN",sourceTimestamp:1000,destinationTimestamp:2000,operation}};
        if(action==="diagnostics")return {result:{version:"0.1.0",events:[{code:"ready"}]}};
        return {result:{ok:true}};
    };
    const api={...transport,Store:function(){return store;},Client:function(options){
        client=new transport.Client({...options,request});
        client.descriptor={instanceId:"instance",port:12345,protocol:1,version:"0.1.0"};
        Object.assign(client.state,{connection:"connected",project,capabilities:{fileNetwork:true},binding:{id:"binding",sessionID:"session",state:"active",project},lock:null});
        client.start=()=>{client.running=true;};client.stop=()=>{client.running=false;};
        return client;
    }};
    const document={hidden:false,getElementById:id=>elements[id],createElement:tag=>new Element(tag)};
    const window={__adobe_cep__:{evalScript(){throw new Error("UI must not inspect AE to export diagnostics");}},location:{href:new URL("../panel/index.html",import.meta.url).href},
        cep_node:{require(name){if(name==="path")return path;if(name==="url")return url;if(name.endsWith("transport.cjs"))return api;throw new Error(name);}},
        URL:{createObjectURL(blob){blobs.push(blob);return "blob:metadata-"+blobs.length;},revokeObjectURL(value){revoked.push(value);}},
        confirm(){return confirm;},addEventListener(name,fn){events[name]=fn;},requestAnimationFrame:fn=>queueMicrotask(fn)};
    vm.runInNewContext(fs.readFileSync(new URL("../panel/ui.js",import.meta.url),"utf8"),{
        window,document,Promise,Blob,Image:function(){},setTimeout,clearTimeout,setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){}
    });
    async function click(id){assert.ok(elements[id].events.click,"handler for "+id);elements[id].events.click();await new Promise(r=>setImmediate(r));}
    return {client,e:elements,calls,blobs,revoked,intervals,events,document,click,set confirm(v){confirm=v;}};
}
test("actual panel UI loads metadata, pins, cancels deletion, reviews exact restore, and clears on binding changes",async()=>{
    const f=fixture();
    assert.equal(f.calls.length,0,"no automatic collection");
    await f.click("services-refresh");
    assert.match(f.e["checkpoint-details"].textContent,/project \/ 123 bytes/);
    assert.match(f.e.renders.textContent,/job-1 \/ running/);assert.doesNotMatch(f.e.renders.textContent,/DO NOT DISPLAY/);
    await f.click("checkpoint-pin");
    assert.deepEqual(f.calls.find(c=>c.body.action==="checkpoint.pin").body,{action:"checkpoint.pin",id:"checkpoint-1",pinned:true});
    f.confirm=false;await f.click("checkpoint-delete");assert.equal(f.calls.some(c=>c.body.action==="checkpoint.delete"),false);
    f.confirm=true;await f.click("checkpoint-delete");assert.ok(f.calls.some(c=>c.body.action==="checkpoint.delete"));
    await f.click("restore-propose");
    assert.equal(f.e["restore-review"].hidden,false);
    assert.match(f.e["restore-details"].textContent,/source:.*destination:/);
    assert.equal(f.e["restore-operation"].textContent,restoreOperation);
    assert.equal(Object.values(f.e).some(e=>e.textContent.includes("SECRET-RESTORE-TOKEN")),false);
    await f.click("restore-cancel");assert.equal(f.client.restoreApproval,null);
    await f.click("restore-propose");await f.click("restore-confirm");
    assert.deepEqual(f.calls.find(c=>c.body.action==="checkpoint.restore.confirm").body,{action:"checkpoint.restore.confirm",token:"SECRET-RESTORE-TOKEN"});
    assert.equal(f.client.restoreApproval,null);assert.equal(f.client.running,true);
    await f.click("services-refresh");await f.click("restore-propose");
    f.client.state.binding=null;f.client.emit();
    assert.equal(f.e["restore-review"].hidden,true);assert.equal(f.e.checkpoint.children.length,0);assert.equal(f.client.restoreApproval,null);
});
test("actual UI diagnostics prepare only backend metadata, revoke downloads, and do not poll while hidden",async()=>{
    const f=fixture();
    await f.click("diagnostics");
    assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{action:"diagnostics"});
    assert.deepEqual(JSON.parse(await f.blobs[0].text()),{version:"0.1.0",events:[{code:"ready"}]});
    assert.equal(f.e["diagnostics-download"].hidden,false);assert.equal(f.e["diagnostics-download"].href,"blob:metadata-1");
    f.e["services-auto"].checked=true;f.document.hidden=true;f.intervals[0]();
    assert.equal(f.calls.length,1);
    f.document.hidden=false;f.intervals[0]();await new Promise(r=>setImmediate(r));
    assert.ok(f.calls.some(c=>c.body.action==="checkpoints"));assert.ok(f.calls.some(c=>c.body.action==="renders"));
    f.client.state.binding=null;f.client.emit();assert.deepEqual(f.revoked,["blob:metadata-1"]);assert.equal(f.e["diagnostics-download"].hidden,true);
});
test("restore cannot be confirmed without bounded backend disclosure and displays text literally",async()=>{
    for(const operation of [, "", {}, "x".repeat(65537)]){
        const f=fixture(operation);
        await f.click("services-refresh");await f.click("restore-propose");
        assert.equal(f.client.restoreApproval,null);
        assert.equal(f.e["restore-review"].hidden,true);
        assert.equal(f.e["restore-confirm"].disabled,true);
        await f.click("restore-confirm");
        assert.equal(f.calls.some(c=>c.body.action==="checkpoint.restore.confirm"),false);
    }
    const operation="Save checkpoint. <script>injected()</script> Open recovery copy.";
    const f=fixture(operation);
    await f.click("services-refresh");await f.click("restore-propose");
    assert.equal(f.e["restore-operation"].textContent,operation);
    assert.equal(f.e["restore-operation"].children.length,0);
});

test("unsupported backend services show errors and stop optional metadata polling",async()=>{
    const f=fixture();f.e["services-auto"].checked=true;
    f.client.request=async()=>{throw Object.assign(new Error("Bridge rejected request"),{code:"not_found"});};
    await f.click("services-refresh");assert.match(f.e["services-status"].textContent,/does not provide/);assert.equal(f.e["services-auto"].checked,false);
});
