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
    const options=args[1] || {};
    for(const id of ["profile-form","profile","profile-open","profile-status"]){
        assert.ok(elements[id],"real HTML must provide "+id);
        if(options.missingProfile)delete elements[id];
    }
    const calls=[],blobs=[],revoked=[],intervals=[],events={},opened=[];
    let client,confirm=true;
    const project={id:"project",path:"C:/safe.aep",saved:true};
    const store={state:{panelId:"ui-panel",credential:"a".repeat(43),uncertain:!!options.uncertain},save(){},close(){this.closed=true;}};
    const request=async(d,c,endpoint,body)=>{
        calls.push({endpoint,body:structuredClone(body)});
        const action=body.action;
        if(action==="checkpoints")return {result:[{id:"checkpoint-1",createdAt:1000,pinned:false,storageMode:"project",size:123}]};
        if(action==="renders")return {result:[{id:"job-1",state:"running",path:"DO NOT DISPLAY"}]};
        if(action==="checkpoint.restore.propose")return {result:{token:"SECRET-RESTORE-TOKEN",sourceTimestamp:1000,destinationTimestamp:2000,operation}};
        if(action==="diagnostics")return {result:{version:"0.2.2",events:[{code:"ready"}]}};
        if(action==="checkpoint.restore.confirm"){
            const recoveryCopy=!!options.fallback;
            const result={checkpointId:"checkpoint-1",currentCheckpointId:"backup-1",canonicalPath:project.path,
                path:recoveryCopy ? "C:/private/recovery.aep" : project.path,emergencyPath:"C:/private/emergency.aep",
                originalPath:options.noOriginal ? undefined : "C:/private/original.aep",recoveryCopy,canonicalReplaced:!recoveryCopy,
                rebindRequired:recoveryCopy,automationSuspended:recoveryCopy,fingerprint:"f".repeat(64),cleanup:null,
                warning:"Keep the actual backups. <script>literal warning</script>"};
            const next=recoveryCopy ? {id:"recovery",path:result.path,saved:true} : project;
            client.state.project=next;client.state.binding={...client.state.binding,project:next};client.emit();
            if(options.beforeResult)await options.beforeResult(client,result);
            return {result};
        }
        return {result:{ok:true}};
    };
    const api={...transport,Store:function(dir,profile){
        opened.push(profile);assert.equal(dir,undefined);
        if(options.storeError)throw Object.assign(new Error("Profile refused"),{code:options.storeError});
        store.profile=profile;return store;
    },Client:function(options){
        client=new transport.Client({...options,request});
        client.descriptor={instanceId:"instance",port:12345,protocol:1,version:"0.2.2"};
        Object.assign(client.state,{connection:"connected",project,capabilities:{fileNetwork:true},binding:{id:"binding",sessionID:"session",state:"active",project},lock:null});
        client.start=()=>{client.running=true;};client.stop=()=>{client.running=false;};
        return client;
    }};
    api.automaticStore=()=>new api.Store(undefined,"automatic-1");
    const document={hidden:false,getElementById:id=>elements[id],createElement:tag=>new Element(tag)};
    const window={__adobe_cep__:{
        getHostEnvironment(){return JSON.stringify(options.environment || {appId:"AEFT",appVersion:"25.3"});},
        getSystemPath(type){assert.equal(type,"extension");return options.extension || new URL("../panel/",import.meta.url).href;},
        evalScript(){throw new Error("UI must not inspect AE to export diagnostics");}
    },location:{href:"https://untrusted.invalid/ignored/index.html"},
        cep_node:{require(name){if(name==="path")return path;if(name==="url")return url;if(name.endsWith("transport.cjs"))return api;throw new Error(name);}},
        URL:{createObjectURL(blob){blobs.push(blob);return "blob:metadata-"+blobs.length;},revokeObjectURL(value){revoked.push(value);}},
        confirm(){return confirm;},addEventListener(name,fn){events[name]=fn;},requestAnimationFrame:fn=>queueMicrotask(fn)};
    vm.runInNewContext(fs.readFileSync(new URL("../panel/ui.js",import.meta.url),"utf8"),{
        window,document,Promise,Blob,Image:function(){},setTimeout,clearTimeout,setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){}
    });
    async function click(id){assert.ok(elements[id].events.click,"handler for "+id);elements[id].events.click();await new Promise(r=>setImmediate(r));}
    function select(profile){elements.profile.value=profile;elements["profile-form"].events.submit({preventDefault(){}});}
    if(!options.manual && elements["profile-form"]?.events.submit)select("primary");
    return {get client(){return client;},store,opened,select,e:elements,calls,blobs,revoked,intervals,events,document,click,set confirm(v){confirm=v;}};
}
test("panel opens automatically, retains uncertainty and closes its saved identity on unload",()=>{
    const first=fixture(restoreOperation,{manual:true});
    assert.ok(first.client);assert.deepEqual(first.opened,["automatic-1"]);
    assert.equal(first.client.running,true);
    first.select("artist-b");assert.deepEqual(first.opened,["automatic-1"]);
    first.events.unload();assert.equal(first.store.closed,true);
    const uncertain=fixture(restoreOperation,{uncertain:true});
    assert.equal(uncertain.client.running,false);assert.equal(uncertain.e.pair.disabled,true);
    assert.match(uncertain.e.status.textContent,/OUTCOME UNCERTAIN/);
    const refused=fixture(restoreOperation,{manual:true,storeError:"unsafe_storage"});
    assert.equal(refused.client,undefined);assert.match(refused.e.error.textContent,/unsafe_storage/);
});
test("recovery appears only when needed and distinguishes local review from chat recovery",()=>{
    const f=fixture();
    assert.equal(f.e["recovery-notice"].hidden,true);
    assert.equal(f.e["connection-notice"].hidden,true);
    f.client.state.uncertain=true;f.client.emit();
    assert.equal(f.e["recovery-notice"].hidden,false);
    assert.equal(f.e.reconcile.hidden,false);
    assert.match(f.e["recovery-message"].textContent,/will not be repeated/);
    f.client.state.uncertain=false;f.client.state.lock={state:"uncertain"};f.client.emit();
    assert.equal(f.e.reconcile.hidden,true);
    assert.match(f.e["recovery-message"].textContent,/in chat/);
    f.client.state.lock=null;f.client.emit();
    assert.equal(f.e["recovery-notice"].hidden,true);
});

test("profile bootstrap fails closed for missing markup, wrong host, and remote extension paths",()=>{
    for(const options of [{missingProfile:true},{environment:{appId:"PHXS",appVersion:"25.0"}},{extension:"file://remote/share/panel"},{extension:"\\\\remote\\share\\panel"},{extension:"C:\\safe\\..\\other"},{extension:"/safe/../other"}]){
        const f=fixture(restoreOperation,{...options,manual:true});
        assert.equal(f.client,undefined);assert.deepEqual(f.opened,[]);assert.match(f.e.status.textContent,/unavailable/);
    }
});
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
    assert.deepEqual(JSON.parse(await f.blobs[0].text()),{version:"0.2.2",events:[{code:"ready"}]});
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

test("UI keeps validated canonical and fallback backup disclosure across context and metadata refreshes",async()=>{
    for(const fallback of [false,true]){
        const f=fixture(restoreOperation,{fallback,noOriginal:fallback});
        await f.click("services-refresh");await f.click("restore-propose");await f.click("restore-confirm");
        const disclosure=f.e["services-status"].textContent;
        for(const text of ["Last Restore Result / Session session","Keep the actual backups. <script>literal warning</script>",
            "currentCheckpointId: backup-1","emergencyPath: C:/private/emergency.aep",
            "canonicalReplaced: "+!fallback,"rebindRequired: "+fallback,"automationSuspended: "+fallback])
            assert.ok(disclosure.includes(text),text);
        assert.ok(disclosure.includes(fallback ? "originalPath: Not returned" : "originalPath: C:/private/original.aep"));
        assert.equal(f.e["services-status"].children.length,0,"literal text only");
        assert.equal(f.e.checkpoint.children.length,0,"backups are not inserted into scoped checkpoint metadata");
        f.client.state.binding={...f.client.state.binding,id:"new-binding",sessionID:"other-session"};f.client.emit();
        assert.match(f.e["services-status"].textContent,/Last Restore Result \/ Session session/);
        await f.click("services-refresh");await f.click("diagnostics");
        assert.match(f.e["services-status"].textContent,/currentCheckpointId: backup-1/);
        assert.equal(f.e.checkpoint.children.some(e=>e.value==="backup-1"),false);
    }
});
test("UI never announces success or discloses unvalidated stale, foreign or malformed restore results",async()=>{
    for(const beforeResult of [
        c=>{c.connectionGeneration++;},
        c=>{c.state.binding={...c.state.binding,sessionID:"foreign"};},
        (c,r)=>{r.checkpointId="foreign";},
        (c,r)=>{r.warning={};},
    ]){
        const f=fixture(restoreOperation,{fallback:true,beforeResult});
        await f.click("services-refresh");await f.click("restore-propose");await f.click("restore-confirm");
        assert.match(f.e["services-status"].textContent,/Restore not confirmed/);
        assert.doesNotMatch(f.e["services-status"].textContent,/Last Restore Result|backup-1|Restore completed/);
        assert.equal(f.store.state.uncertain,true);
    }
});
test("compatibility UI separates versions, exposes only configured HTTPS links and cleans stale links",()=>{
    const f=fixture();
    assert.match(f.e.versions.textContent,/Panel 0.2.2 \/ Bridge Plugin unknown \/ CookieMonster Desktop not configured/);
    for(const key of ["plugin","panel","cookieMonster"]){
        assert.equal(f.e["update-"+key].hidden,true);
        assert.equal(f.e["update-"+key].href,undefined);
        assert.equal(f.e["update-"+key+"-status"].textContent,"not configured");
    }
    const empty={status:"compatible",pluginVersion:"0.2.2",protocol:1,panelVersion:"0.2.2",panelProtocol:1,
        cookieMonsterVersion:null,cookieMonsterVersionStatus:"not_configured",releaseSourceUrl:"https://github.com/trmosala/CookieJar/releases",
        updates:Object.fromEntries(["plugin","panel","cookieMonster"].map(k=>[k,{status:"not_configured",version:null,protocol:null,url:null}]))};
    const configured=structuredClone(empty);
    configured.cookieMonsterVersion="2.4.1";configured.cookieMonsterVersionStatus="configured";
    for(const key of ["plugin","panel","cookieMonster"])
        configured.updates[key]={status:"configured",version:key==="cookieMonster" ? "2.4.1" : "0.2.2",protocol:1,url:"https://releases.example.test/"+key};
    f.client.state.compatibility=configured;f.client.emit();
    assert.match(f.e.versions.textContent,/Bridge Plugin 0.2.2 \/ CookieMonster Desktop 2.4.1/);
    for(const key of ["plugin","panel","cookieMonster"]){
        assert.equal(f.e["update-"+key].href,configured.updates[key].url);
        assert.equal(f.e["update-"+key].hidden,false);
    }
    assert.equal(f.e["release-source"].href,empty.releaseSourceUrl);
    const html=fs.readFileSync(new URL("../panel/index.html",import.meta.url),"utf8");
    assert.match(html,/Release source is not an approved internal installer/);
    assert.match(html,/id="update-panel"[^>]*rel="noopener noreferrer"/);
    for(const metadata of [empty,null,{...configured,cookieMonsterVersion:"<script>"},{...configured,updates:{...configured.updates,panel:{...configured.updates.panel,url:"javascript:alert(1)"}}}]){
        f.client.state.compatibility=metadata;f.client.emit();
        for(const key of ["plugin","panel","cookieMonster"]){
            assert.equal(f.e["update-"+key].hidden,true);
            assert.equal(f.e["update-"+key].href,undefined);
        }
        assert.match(f.e.versions.textContent,/Desktop not configured/);
    }
    f.client.state.compatibility=configured;f.client.emit();
    f.client.state.compatibility=null;f.client.emit();
    assert.equal(f.e["release-source"].hidden,true);assert.equal(f.e["release-source"].href,undefined);
    f.client.state.connection="incompatible";f.client.state.uncertain=true;f.client.emit();
    assert.match(f.e["compatibility-status"].textContent,/automation stopped/);
    assert.equal(f.e.reconcile.disabled,true);assert.equal(f.e["restore-propose"].disabled,true);
});
test("credential recovery UI requires confirmation and fresh code without clearing the latch or starting automation",async()=>{
    const f=fixture(restoreOperation,{uncertain:true}),before={...f.store.state},calls=[];
    f.client.state.busy=true;f.client.state.connection="incompatible";f.client.emit();
    assert.equal(f.e.rotate.disabled,true);assert.equal(f.e["recover-credential"].disabled,false);
    f.client.recoverCredential=async code=>{calls.push(code);};
    f.confirm=false;f.e.code.value="CANCELLED";await f.click("recover-credential");
    assert.deepEqual(calls,[]);assert.equal(f.e.code.value,"");
    f.confirm=true;f.e.code.value=" FRESH ";await f.click("recover-credential");
    assert.deepEqual(calls,["FRESH"]);assert.equal(f.e.code.value,"");
    assert.deepEqual(f.store.state,before);assert.equal(f.client.running,false);
    assert.match(f.e["credential-recovery-status"].textContent,/Automation remains stopped/);
    assert.match(f.e["credential-recovery-status"].textContent,/local latch separately/);
    f.client.recoverCredential=async()=>{throw Object.assign(new Error("Code refused"),{code:"invalid_pairing_code"});};
    await f.click("recover-credential");assert.match(f.e.error.textContent,/invalid_pairing_code/);
    assert.match(f.e["credential-recovery-status"].textContent,/recovery not confirmed/);
    assert.doesNotMatch(f.e["credential-recovery-status"].textContent,/Credential recovered/);
    assert.deepEqual(f.store.state,before);assert.equal(f.client.running,false);
    f.client.host.pending=true;f.client.emit();assert.equal(f.e["recover-credential"].disabled,true);
});
test("unsupported backend services show errors and stop optional metadata polling",async()=>{
    const f=fixture();f.e["services-auto"].checked=true;
    f.client.request=async()=>{throw Object.assign(new Error("Bridge rejected request"),{code:"not_found"});};
    await f.click("services-refresh");assert.match(f.e["services-status"].textContent,/does not provide/);assert.equal(f.e["services-auto"].checked,false);
});
