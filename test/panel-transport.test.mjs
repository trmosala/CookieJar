import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridge } from "../src/bridge.mjs";
import transport from "../panel/transport.cjs";
import { restoreFixture } from "./bridge-panel.mjs";
import { createRuntime } from "../src/plugin.mjs";
import { createCheckpoints } from "../src/storage.mjs";
import fsp from "node:fs/promises";
import { releaseMetadata } from "../src/protocol.mjs";
import { createRequire } from "node:module";
const compatibility=()=>({status:"compatible",pluginVersion:"0.2.3",protocol:1,panelVersion:"0.2.3",panelProtocol:1,...releaseMetadata()});
const { Client, HostRPC, Store, request, normalizeCapture } = transport;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const descriptor = {port:12345,instanceId:"instance",protocol:1,version:"0.2.3",updateUrl:"https://github.com/trmosala/CookieJar/releases"};
const project = {id:"path:c:/test.aep",path:"c:/test.aep",saved:true};
const status = {project,activeCompId:1,capabilities:{fileNetwork:true},aeVersion:"25.3",busy:false,uncertain:false};
function fixture(overrides={}) {
    const events=[],store={state:{panelId:"panel",credential:"a".repeat(43),uncertain:false},save(){events.push(["save",this.state.uncertain]);},descriptor(){return {...descriptor};}};
    let command=null;
    const binding={id:"binding",state:"active",sessionID:"session",project};
    const host={pending:false,uncertain:false,call:async(method,params)=>{events.push(["host",method,params]);return method==="status" ? status : {ok:true};}};
    const client=new Client({store,host,changed(s){events.push(["ui",s.busy,s.capture,s.uncertain]);},beforeCapture:async()=>{events.push(["paint"]);},
        normalize:async r=>({mime:"image/png",data:"AAAA",width:1,height:1}),
        request:async(d,c,endpoint,body)=>{
            events.push([endpoint,body,c]);
            if(endpoint==="/connect" || endpoint==="/compatibility")return {connectionId:"connection",protocol:1,version:"0.2.3",updateUrl:descriptor.updateUrl,compatibility:compatibility()};
            if(endpoint==="/heartbeat")return {binding,lock:{state:"executing"}};
            if(endpoint==="/poll"){const c=command;command=null;return {command:c};}
            return {ok:true};
        },...overrides});
    client.descriptor={...descriptor};
    Object.assign(client.state,{connection:"connected",...status,binding,lock:{state:"executing"}});
    return {client,host,store,events,binding,set command(c){command=c;}};
}
test("a binding established between heartbeat and poll is refreshed before host dispatch",async()=>{
    const f=fixture(),send=f.client.request;let beats=0;
    f.client.request=async function(d,c,endpoint,body){
        if(endpoint==="/heartbeat" && ++beats===1)return {binding:null,lock:null};
        return send(d,c,endpoint,body);
    };
    f.command={id:"new-chat-command",method:"inspect",params:{},sessionID:"session"};
    await f.client.tick();
    assert.ok(beats>=2);
    assert.ok(f.events.some(e=>e[0]==="host" && e[1]==="inspect"));
    assert.ok(!f.events.some(e=>e[0]==="/reply" && e[1].error));
});

test("panel management sends exact authenticated schemas and requires an explicit single-use restore token",async()=>{
    const f=fixture();f.client.state.lock=null;
    const rows=[{id:"cp",createdAt:1000,pinned:false,storageMode:"project",size:123,projectPath:"not returned"}];
    f.client.request=async(d,credential,endpoint,body,timeout)=>{
        assert.equal(timeout,body.action.startsWith("checkpoint.restore.") ? 300000 : 15000);assert.equal(endpoint,"/panel");assert.equal(credential,f.store.state.credential);f.events.push([endpoint,structuredClone(body)]);
        if(body.action==="checkpoints")return {result:rows};
        if(body.action==="checkpoint.restore.propose")return {result:{token:"opaque-token",sourceTimestamp:1000,destinationTimestamp:2000,operation:"Save edits and restore checkpoint."}};
        if(body.action==="diagnostics")return {result:{version:"0.2.3",counts:{jobs:0}}};
        if(body.action==="renders")return {result:[{id:"job",state:"completed"}]};
        if(body.action==="checkpoint.restore.confirm")return {result:{checkpointId:"cp",currentCheckpointId:"backup",path:project.path,
            canonicalPath:project.path,emergencyPath:"c:/private/emergency.aep",originalPath:"c:/private/original.aep",recoveryCopy:false,
            canonicalReplaced:true,rebindRequired:false,automationSuspended:false,fingerprint:"f".repeat(64),cleanup:null,warning:"Keep backups."}};
        return {result:{ok:true}};
    };
    assert.deepEqual(await f.client.panel("checkpoints",{}),[{id:"cp",createdAt:1000,pinned:false,storageMode:"project",size:123}]);
    await f.client.panel("checkpoint.pin",{id:"cp",pinned:true});
    await f.client.panel("checkpoint.delete",{id:"cp"});
    const proposal=await f.client.panel("checkpoint.restore.propose",{id:"cp"});
    assert.deepEqual(proposal,{sourceTimestamp:1000,destinationTimestamp:2000,operation:"Save edits and restore checkpoint."});assert.equal("token" in proposal,false);
    assert.equal(f.events.some(e=>e[1]?.action==="checkpoint.restore.confirm"),false);
    await f.client.confirmRestore();
    assert.deepEqual(f.events.find(e=>e[0]==="/panel" && e[1].action==="checkpoint.restore.confirm")[1],{action:"checkpoint.restore.confirm",token:"opaque-token"});
    await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
    assert.deepEqual(await f.client.panel("diagnostics",{}),{version:"0.2.3",counts:{jobs:0}});
    assert.deepEqual(await f.client.panel("renders",{}),[{id:"job",state:"completed"}]);
    assert.equal(f.events.some(e=>e[0]==="host"),false,"services do not collect host content");
    assert.equal(JSON.stringify(f.store.state).includes("opaque-token"),false);
    await assert.rejects(f.client.panel("checkpoint.pin",{id:"cp",pinned:true,sessionID:"other"}),{code:"invalid_payload"});
});
test("restore approval is invalidated by binding switch/cancel and consumed even when confirmation fails",async()=>{
    const f=fixture();f.client.state.lock=null;
    f.client.request=async(d,c,e,body)=>body.action==="checkpoint.restore.propose" ? {result:{token:"once",sourceTimestamp:1,destinationTimestamp:null,operation:"Save edits and restore checkpoint."}} : Promise.reject(Object.assign(new Error("lost response"),{code:"disconnected"}));
    await f.client.panel("checkpoint.restore.propose",{id:"cp"});
    f.client.state.binding={...f.binding,id:"new-binding"};f.client.emit();
    await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
    await f.client.panel("checkpoint.restore.propose",{id:"cp"});f.client.restoreApproval=null;
    await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
    await f.client.panel("checkpoint.restore.propose",{id:"cp"});
    await assert.rejects(f.client.confirmRestore(),{code:"disconnected"});
    assert.equal(f.store.state.uncertain,true);assert.equal(f.client.state.busy,true);
    await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
});
test("panel response validation rejects stale/malformed responses and pending services do not stop host polling",async()=>{
    const f=fixture();f.client.state.lock=null;let finish;
    const send=f.client.request;
    f.client.request=(d,c,e,b)=>e==="/panel" ? new Promise(r=>finish=r) : send(d,c,e,b);
    const pending=f.client.panel("renders",{});
    await f.client.tick();assert.ok(f.events.some(e=>e[0]==="/poll"));
    await assert.rejects(f.client.panel("checkpoints",{}),{code:"panel_busy"});
    f.client.state.project={...project,id:"changed"};
    finish({result:[]});await assert.rejects(pending,{code:"stale_binding"});
    f.client.request=async()=>({result:[{id:"cp",size:-1}]});
    await assert.rejects(f.client.panel("checkpoints",{}),{code:"invalid_response"});
    f.client.request=async()=>({ok:true});
    await assert.rejects(f.client.panel("diagnostics",{}),{code:"invalid_response"});
});
test("restore completion accepts the same owner's validated fallback without weakening ordinary context guards",async()=>{
    const f=fixture();f.client.state.lock=null;
    const result={checkpointId:"cp",currentCheckpointId:"backup",path:"c:/private/recovery.aep",canonicalPath:project.path,
        emergencyPath:"c:/private/emergency.aep",originalPath:"c:/private/original.aep",recoveryCopy:true,
        canonicalReplaced:false,rebindRequired:true,automationSuspended:true,fingerprint:"f".repeat(64),cleanup:null,warning:"Review retained backups."};
    f.client.request=async(d,c,e,body)=>{
        if(body.action==="checkpoint.restore.propose")return {result:{token:"once",sourceTimestamp:1,destinationTimestamp:2,operation:"Save current edits; restore the checkpoint."}};
        const next={id:"recovery",path:result.path,saved:true};
        f.client.state.project=next;f.client.state.binding={...f.binding,project:next};f.client.emit();
        return {result};
    };
    await f.client.panel("checkpoint.restore.propose",{id:"cp"});
    assert.deepEqual(await f.client.confirmRestore(),{...result,previousCheckpointId:null});
    assert.equal(f.client.restoreApproval,null);
});
test("restore completion refuses stale owners, reconnects, foreign sources and malformed recovery evidence",async()=>{
    const cases=[
        ["port",f=>{f.client.descriptor.port++;},"stale_binding"],
        ["instance",f=>{f.client.descriptor.instanceId="restarted";},"stale_binding"],
        ["credential",f=>{f.store.state.credential="b".repeat(43);},"stale_binding"],
        ["connection",f=>{f.client.connectionId="other";},"stale_binding"],
        ["epoch",f=>{f.client.connectionEpoch="new-epoch";},"stale_binding"],
        ["binding",f=>{f.client.state.binding={...f.binding,id:"other"};},"stale_binding"],
        ["session",f=>{f.client.state.binding={...f.binding,sessionID:"other"};},"stale_binding"],
        ["binding connection",f=>{f.client.state.binding={...f.binding,connectionId:"other"};},"stale_binding"],
        ["suspension",f=>{f.client.state.binding={...f.binding,state:"suspended"};},"stale_binding"],
        ["transient disconnect",f=>{f.client.state.connection="disconnected";f.client.emit();f.client.state.connection="connected";},"stale_binding"],
        ["reconnect",async f=>{await f.client.connect();f.client.state.binding=f.binding;},"stale_binding"],
        ["project",f=>{f.client.state.project={...project,id:"foreign"};},"stale_binding"],
        ["checkpoint",(f,r)=>{r.checkpointId="foreign";},"stale_binding"],
        ["source",(f,r)=>{r.canonicalPath=r.path="c:/foreign.aep";},"stale_binding"],
        ["flags",(f,r)=>{r.rebindRequired=true;},"invalid_response"],
        ["warning",(f,r)=>{r.warning=" ";},"invalid_response"],
        ["oversized warning",(f,r)=>{r.warning="x".repeat(65537);},"invalid_response"],
        ["backup",(f,r)=>{delete r.currentCheckpointId;},"invalid_response"],
        ["fingerprint",(f,r)=>{r.fingerprint="not verified";},"invalid_response"],
        ["relative backup",(f,r)=>{r.emergencyPath="relative.aep";},"invalid_response"],
        ["backup control",(f,r)=>{r.originalPath="c:/bad\npath";},"invalid_response"],
        ["original overlaps",(f,r)=>{r.originalPath=r.path;},"invalid_response"],
        ["cleanup",(f,r)=>{r.cleanup={};},"invalid_response"],
        ["wrong fallback path",(f,r)=>{
            Object.assign(r,{recoveryCopy:true,canonicalReplaced:false,rebindRequired:true,automationSuspended:true,path:"c:/private/recovery.aep"});
            const next={id:"foreign",path:"c:/foreign.aep",saved:true};
            f.client.state.project=next;f.client.state.binding={...f.binding,project:next};
        },"stale_binding"],
    ];
    for(const [name,change,code] of cases){
        const f=fixture();f.client.state.lock=null;
        const send=f.client.request;
        const result={checkpointId:"cp",currentCheckpointId:"backup",path:project.path,canonicalPath:project.path,
            emergencyPath:"c:/private/emergency.aep",originalPath:"c:/private/original.aep",recoveryCopy:false,
            canonicalReplaced:true,rebindRequired:false,automationSuspended:false,fingerprint:"f".repeat(64),cleanup:null,warning:"Keep backups."};
        f.client.request=async(d,c,e,body)=>{
            if(e!=="/panel")return send(d,c,e,body);
            if(body.action==="checkpoint.restore.propose")return {result:{token:"once",sourceTimestamp:1,destinationTimestamp:2,operation:"Save edits; restore."}};
            await change(f,result);return {result};
        };
        await f.client.panel("checkpoint.restore.propose",{id:"cp"});
        await assert.rejects(f.client.confirmRestore(),{code},name);
        assert.equal(f.client.restoreApproval,null,name);
        assert.equal(f.store.state.uncertain,true,name);
        assert.equal(f.client.panelPending,false,name);
    }
});
test("Client validates proposal operation and timestamps before retaining a single-use approval",async()=>{
    for(const change of [
        r=>{delete r.operation;},r=>{r.operation="";},r=>{r.operation=" \n";},r=>{r.operation={};},
        r=>{r.operation="x".repeat(65537);},r=>{r.sourceTimestamp=1e20;},r=>{r.destinationTimestamp=NaN;}
    ]){
        const f=fixture();f.client.state.lock=null;
        const result={token:"once",sourceTimestamp:1,destinationTimestamp:2,operation:"Save edits; restore."};
        f.client.request=async()=>({result});
        await f.client.panel("checkpoint.restore.propose",{id:"cp"});
        change(result);
        await assert.rejects(f.client.panel("checkpoint.restore.propose",{id:"cp"}),{code:"invalid_response"});
        assert.equal(f.client.restoreApproval,null);
        await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
    }
});
test("actual Client.panel restore returns canonical and fallback backups through the production services",async t=>{
    for(const fallback of [false,true]){
        await t.test(fallback ? "fallback" : "canonical",async t=>{
            const f=await restoreFixture(t),{p,h,client,sessionID}=f;
            const checkpoints=createCheckpoints({dataDir:p.dataDir}),canonical=h.project.file.fsName;
            const checkpoint=await checkpoints.create({projectPath:canonical,projectId:h.call("inspect").result.project.id,planHash:"panel-restore"});
            h.props[0].setValue(42);
            await createRuntime({factories:{bridge:async()=>p.bridge,renderer:async()=>({list:async()=>[],close:async()=>{}})}});
            for(let i=0;!client.state.binding && i<200;i++)await sleep(10);
            const review=await client.panel("checkpoint.restore.propose",{id:checkpoint.id});
            assert.match(review.operation,/private emergency copy/);assert.equal("token" in review,false);
            assert.equal(h.project.dirty,true);assert.equal(h.closes,0);
            const rename=fsp.rename.bind(fsp);
            const fault=t.mock.method(fsp,"rename",async(source,destination)=>{
                if(fallback && source===canonical)throw Object.assign(new Error("canonical locked"),{code:"EACCES"});
                return rename(source,destination);
            });
            const result=await client.confirmRestore();
            fault.mock.restore();
            assert.equal(result.recoveryCopy,fallback);assert.equal(result.canonicalReplaced,!fallback);
            assert.equal(result.rebindRequired,fallback);assert.equal(result.automationSuspended,fallback);
            assert.equal(result.canonicalPath,canonical);assert.equal(result.path,h.project.file.fsName);
            assert.equal(h.closes,1);assert.equal(h.props[0].value,100);assert.ok(result.warning);
            const backup=await checkpoints.verify(result.currentCheckpointId);
            assert.equal(JSON.parse(await fsp.readFile(backup.path,"utf8")).props[0].value,42);
            assert.equal(JSON.parse(await fsp.readFile(result.emergencyPath,"utf8")).props[0].value,42);
            assert.deepEqual(f.commands.filter(c=>c.params.phase?.startsWith("restore_")).map(c=>c.params.phase),["restore_prepare","restore_finish"]);
            assert.equal(p.bridge.binding(sessionID,{allowLocked:true}).lock?.state || null,fallback ? "uncertain" : null);
            const list=await client.panel("checkpoints",{});
            assert.equal(list.some(c=>c.id===result.currentCheckpointId),!fallback,"current backup belongs to the canonical project only");
            const previous=await checkpoints.verify(result.previousCheckpointId);
            assert.equal(JSON.parse(await fsp.readFile(previous.path,"utf8")).props[0].value,100);
            await assert.rejects(client.confirmRestore(),{code:"invalid_token"});
            await f.stop();
        });
    }
});
test("evalScript transports quoted JSON, times out once, ignores late success and remains locked",async()=>{
    let callback,calls=0,late=0;
    const host=new HostRPC({evalScript(source,cb){calls++;callback=cb;vm.runInNewContext(source,{CookieMonsterAE:{dispatch(s){assert.equal(JSON.parse(s).params.source,'quote\"\\\\\n\u2028');}}});}},10,()=>late++);
    await assert.rejects(host.call("raw",{source:'quote\"\\\\\n\u2028'}),{code:"outcome_uncertain"});
    assert.equal(host.pending,true);
    await assert.rejects(host.call("inspect",{}),{code:"outcome_uncertain"});
    callback('{"result":{"ok":true}}');assert.equal(host.pending,false);assert.equal(host.uncertain,true);assert.equal(late,1);assert.equal(calls,1);
});
test("malformed host output latches unknown outcome",async()=>{
    const host=new HostRPC({evalScript(s,cb){cb("EvalScript error.");}},20);
    await assert.rejects(host.call("inspect",{}),{code:"invalid_host_result"});assert.equal(host.uncertain,true);
});
test("serial poll, durable in-flight latch, visible capture before host and idle heartbeat before reply",async()=>{
    const f=fixture();f.command={id:"cmd",method:"capture",params:{compId:1,time:0,alpha:true},sessionID:"session"};
    await Promise.all([f.client.tick(),f.client.tick()]);
    assert.equal(f.events.filter(e=>e[0]==="/poll").length,1);
    const host=f.events.findIndex(e=>e[0]==="host" && e[1]==="capture"),reply=f.events.findIndex(e=>e[0]==="/reply");
    assert.ok(f.events.findIndex(e=>e[0]==="save" && e[1]===true)<host);
    assert.ok(f.events.findIndex(e=>e[0]==="paint")<host);
    assert.ok(f.events.findIndex(e=>e[0]==="ui" && e[2]==="session")<host);
    assert.equal(f.events.slice(host,reply).filter(e=>e[0]==="/heartbeat").at(-1)[1].busy,false);
    assert.deepEqual(f.events[reply][1].result,{mime:"image/png",data:"AAAA",width:1,height:1});
    assert.equal(f.store.state.uncertain,false);assert.equal(f.client.state.busy,false);
});
test("long host work continues network heartbeats without extra evalScript",async()=>{
    const f=fixture();f.host.call=async method=>{f.events.push(["host",method]);if(method!=="status")await sleep(2150);return status;};
    f.command={id:"slow",method:"inspect",params:{},sessionID:"session"};
    await f.client.tick();
    assert.equal(f.events.filter(e=>e[0]==="host").length,2);
    assert.ok(f.events.filter(e=>e[0]==="/heartbeat" && e[1].busy).length>=2);
});
test("lost reply retains crash latch and never polls or retries again",async()=>{
    const f=fixture(),send=f.client.request;
    f.client.request=async(...args)=>{if(args[2]==="/reply")throw Object.assign(new Error("lost"),{code:"disconnected"});return send(...args);};
    f.command={id:"cmd",method:"execute",params:{actions:[]},sessionID:"session"};
    await f.client.tick();await f.client.tick();
    assert.equal(f.store.state.uncertain,true);assert.equal(f.client.state.uncertain,true);
    assert.equal(f.events.filter(e=>e[0]==="host" && e[1]==="execute").length,1);
});
test("binding and lock checks refuse writes before evalScript; hidden capture refuses before pixels",async()=>{
    const f=fixture();f.client.state.lock=null;
    await f.client.command({id:"cmd",method:"execute",params:{actions:[]},sessionID:"session"});
    assert.equal(f.events.at(-1)[1].error.code,"lock_required");assert.equal(f.events.some(e=>e[0]==="host"),false);
    await f.client.command({id:"cap",method:"capture",params:{},sessionID:"session"});
    assert.equal(f.events.at(-1)[1].error.code,"lock_required");
    assert.equal(f.events.some(e=>e[0]==="host" || e[0]==="paint"),false);
    f.client.state.lock={state:"executing"};
    f.client.beforeCapture=async()=>{throw Object.assign(new Error("Hidden"),{code:"unsafe_state"});};
    await f.client.command({id:"hidden",method:"capture",params:{},sessionID:"session"});
    assert.equal(f.events.find(e=>e[0]==="/reply" && e[1].id==="hidden")[1].error.code,"unsafe_state");
    assert.equal(f.events.some(e=>e[0]==="host"),false);
});
test("capture rechecks its lock after painting and retains ambiguous host failures",async()=>{
    const f=fixture(),send=f.client.request;
    f.client.request=async(...args)=>args[2]==="/heartbeat" ? {binding:f.binding,lock:null} : send(...args);
    await f.client.command({id:"lost-lock",method:"capture",params:{},sessionID:"session"});
    assert.equal(f.events.find(e=>e[0]==="/reply" && e[1].id==="lost-lock")[1].error.code,"lock_required");
    assert.equal(f.events.some(e=>e[0]==="host"),false);
    const g=fixture();
    g.host.call=async()=>{throw Object.assign(new Error("Unknown render failure"),{code:"host_error"});};
    await assert.rejects(g.client.command({id:"failed",method:"capture",params:{},sessionID:"session"}),{code:"outcome_uncertain"});
    assert.equal(g.store.state.uncertain,true);
});
test("host status rejects invalid active composition metadata before connect or heartbeat",async()=>{
    for(const activeCompId of [undefined,0,-1,1.5,"1",{},NaN,Number.MAX_SAFE_INTEGER+1]){
        const f=fixture();f.host.call=async()=>({...status,activeCompId});
        await assert.rejects(f.client.connect(),{code:"invalid_host_result"});
        await f.client.tick();
        assert.equal(f.events.some(e=>e[0]==="/connect" || e[0]==="/heartbeat"),false);
        assert.equal(f.client.state.connection,"disconnected");
    }
});
test("compatibility real bridge reports authenticated mismatches without host dispatch or credential replacement",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-compat-")),dataDir=path.join(root,"bridge");
    let bridge;
    const source=fs.readFileSync(new URL("../panel/transport.cjs",import.meta.url),"utf8");
    const exports={exports:{}};
    vm.runInNewContext(source.replace('var VERSION = "0.2.3", PROTOCOL = 1','var VERSION = "0.3.0", PROTOCOL = 2'),
        {module:exports,require:createRequire(import.meta.url),Buffer,process,setTimeout,clearTimeout});
    const FutureClient=exports.exports.Client;
    const releases={cookieMonsterVersion:"2.4.1",updates:{
        plugin:{version:"0.2.3",protocol:1,url:"https://releases.example.test/plugin"},
        panel:{version:"0.2.3",protocol:1,url:"https://releases.example.test/panel"},
        cookieMonster:{version:"2.4.1",protocol:1,url:"https://releases.example.test/desktop"}
    }};
    try{
        bridge=await createBridge({dataDir,releaseMetadata:releases});
        const d=JSON.parse(fs.readFileSync(path.join(dataDir,"descriptor.json"),"utf8")),calls=[];
        const store={state:{panelId:"compat-panel",credential:null,uncertain:false},save(){},descriptor:()=>({...d})};
        const host={call:async()=>{calls.push("host");return status;}};
        const current=new Client({store,host});
        await current.pair(bridge.pairingCode("compat-session").code);
        assert.equal(current.state.compatibility.cookieMonsterVersion,"2.4.1");
        await current.connect();
        assert.equal(current.state.compatibility.status,"compatible");
        assert.equal(current.state.compatibility.updates.panel.url,releases.updates.panel.url);
        await bridge.bind("compat-session",current.connectionId);
        await bridge.lock("compat-session",{kind:"recovery-test"});
        const before={...store.state};calls.length=0;
        const rotations=[];
        const future=new FutureClient({store,host,request:(d,c,e,b)=>{rotations.push(e);return request(d,c,e,b);}});
        future.discover();
        await assert.rejects(future.management("/rotate"),{code:"incompatible_version"});
        assert.deepEqual(rotations,[],"mismatched rotation must be refused before dispatch");
        assert.deepEqual(store.state,before);
        assert.equal((await request(d,before.credential,"/compatibility",{panelId:before.panelId,protocol:1,version:"0.2.3"})).connectionId,current.connectionId);
        await assert.rejects(future.connect(),{code:"incompatible_version"});
        future.start();
        for(let i=0;future.inFlight && i<200;i++)await sleep(10);
        assert.equal(future.state.connection,"incompatible");assert.equal(future.running,false);
        assert.equal(future.state.compatibility.panelVersion,"0.3.0");
        assert.equal(future.state.compatibility.panelProtocol,2);
        assert.equal(future.state.compatibility.updates.panel.version,"0.2.3");
        assert.deepEqual(calls,[]);assert.deepEqual(store.state,before);
        await future.tick();future.start();assert.deepEqual(calls,[]);
        await assert.rejects(future.status(),{code:"incompatible_version"});
        await assert.rejects(future.command({}),{code:"incompatible_version"});
        const live=(await bridge.connections())[0];
        assert.equal(live.connected,false);assert.equal(live.binding.state,"suspended");assert.ok(live.lock);
        await assert.rejects(request(d,null,"/compatibility",{panelId:"compat-panel",protocol:2,version:"0.2.3"}),{code:"unauthorized"});

        const unpairedStore={...store,automaticCode:()=>JSON.parse(fs.readFileSync(path.join(dataDir,"automatic-connection.json"),"utf8")).code,state:{panelId:"new-panel",credential:null,uncertain:false}};
        const unpaired=new FutureClient({store:unpairedStore,host});
        await assert.rejects(unpaired.connect(),{code:"incompatible_version"});
        assert.equal(unpaired.state.connection,"incompatible");
        await assert.rejects(unpaired.pair(bridge.pairingCode("new-session").code),e=>{
            assert.equal(e.code,"incompatible_version");
            assert.equal(e.details.compatibility.status,"incompatible");
            return true;
        });
        assert.equal(unpaired.state.compatibility.cookieMonsterVersion,"2.4.1");
        assert.equal(unpaired.state.connection,"incompatible");
        assert.equal(unpairedStore.state.credential,null);assert.deepEqual(calls,[]);

        const rejectedConnect=new FutureClient({store,host});
        rejectedConnect.discover();
        await assert.rejects(rejectedConnect.negotiate("/connect",{panelId:"compat-panel",protocol:2,version:"0.3.0",
            project,activeCompId:1,aeVersion:"25.3",capabilities:{fileNetwork:true}}),{code:"incompatible_version"});
        assert.equal(rejectedConnect.state.compatibility.pluginVersion,"0.2.3");
        assert.deepEqual(calls,[]);
    }finally{await bridge?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test("explicit invalid credential recovery revokes the server secret and retains profile identity, latch and durable locks",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-recover-")),dataDir=path.join(root,"bridge");
    let bridge,store,client;
    const calls=[],host={pending:false,uncertain:false,call:async method=>{calls.push(method);return status;}};
    const disk=()=>JSON.parse(fs.readFileSync(path.join(dataDir,"bridge-state.json"),"utf8"));
    try{
        bridge=await createBridge({dataDir,heartbeatMs:60000});
        store=new Store(dataDir,"recovery");
        client=new Client({store,host});
        await client.pair(bridge.pairingCode("recovery-session").code);
        await client.connect();
        const identity={panelId:store.state.panelId,connectionId:client.connectionId};
        await bridge.bind("recovery-session",identity.connectionId);
        const lock=await bridge.lock("recovery-session",{kind:"retained-recovery"});
        await client.heartbeat();
        calls.length=0;
        const original=store.state.credential;
        await assert.rejects(client.recoverCredential(bridge.pairingCode("valid-check").code),{code:"credential_valid"});
        assert.equal(store.state.credential,original);
        assert.deepEqual(disk().locks,[lock]);

        // Reproduce a bridge-committed rotation whose response was lost before local persistence.
        const d=store.descriptor(),lost=await request(d,original,"/rotate",{});
        assert.notEqual(lost.credential,original);
        await assert.rejects(client.management("/unpair"),{code:"unauthorized"});
        await assert.rejects(client.pair("unused"),{code:"already_paired"});
        await client.tick();client.stop();
        assert.equal(client.state.lastError,"unauthorized");
        assert.equal(store.state.credential,original,"authentication failure never clears the local credential");
        client.mark(true);host.uncertain=true;client.state.busy=true;
        calls.length=0;
        const before={...store.state},serverBefore=disk();
        await assert.rejects(client.recoverCredential("invalid-code"),{code:"invalid_pairing_code"});
        assert.deepEqual(store.state,before);assert.deepEqual(disk(),serverBefore);
        const code=bridge.pairingCode("recovery-session").code;
        await client.recoverCredential(code);
        assert.equal(store.state.panelId,identity.panelId);assert.equal(client.connectionId,identity.connectionId);
        assert.notEqual(store.state.credential,original);assert.notEqual(store.state.credential,lost.credential);
        assert.equal(store.state.uncertain,true);assert.equal(client.state.uncertain,true);assert.equal(host.uncertain,true);
        assert.equal(client.state.busy,true);assert.equal(client.running,false);assert.equal(client.state.binding,null);
        assert.deepEqual(client.state.lock,lock);assert.deepEqual(disk().locks,[lock]);
        assert.equal(disk().credentials.length,1);assert.equal(disk().credentials[0].connectionId,identity.connectionId);
        assert.deepEqual(JSON.parse(fs.readFileSync(store.file,"utf8")),store.state);
        assert.equal(JSON.stringify(store.state).includes(code),false);
        for(const secret of [original,lost.credential])
            await assert.rejects(request(d,secret,"/compatibility",{panelId:identity.panelId,protocol:1,version:"0.2.3"}),{code:"unauthorized"});
        await assert.rejects(request(d,null,"/pair",{panelId:identity.panelId,protocol:1,version:"0.2.3",code}),{code:"invalid_pairing_code"});
        await client.tick();
        await assert.rejects(client.connect(),{code:"outcome_uncertain"});
        assert.deepEqual(calls,[],"credential recovery never dispatches AE work");
        assert.equal((await bridge.connections())[0].connected,false);

        const saved={...store.state};
        store.close();await bridge.close();
        bridge=await createBridge({dataDir,heartbeatMs:60000});
        store=new Store(dataDir,"recovery");assert.deepEqual(store.state,saved);
        client=new Client({store,host});await client.tick();
        assert.equal((await bridge.connections()).length,0);assert.deepEqual(calls,[]);
        assert.equal(disk().locks[0].id,lock.id);assert.equal(disk().locks[0].connectionId,identity.connectionId);
        assert.equal(disk().locks[0].state,"uncertain");
        const verified=await request(store.descriptor(),saved.credential,"/compatibility",{panelId:identity.panelId,protocol:1,version:"0.2.3"});
        assert.equal(verified.connectionId,identity.connectionId);
        assert.equal((await bridge.connections())[0].lock.id,lock.id);
        // Local reconciliation and rebinding remain separate, explicit actions.
        host.uncertain=false;client.start=()=>{};await client.reconcile();await client.connect();
        assert.equal(client.connectionId,identity.connectionId);
        const rebound=await bridge.bind("recovered-session",identity.connectionId);
        assert.equal(rebound.lock.id,lock.id);assert.equal(rebound.lock.state,"uncertain");
        assert.throws(()=>bridge.binding("recovered-session"),{code:"target_locked"});
    }finally{client?.stop();store?.close();await bridge?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test("credential recovery fails closed for transport, scope, persistence and concurrent host work",async()=>{
    for(const mode of ["disconnected","malformed","stale-probe","stale-pair","save-failed","pending","panel-pending","valid"]){
        const f=fixture(),before={...f.store.state},lock=f.client.state.lock,requests=[];
        f.client.mark(true);f.host.uncertain=true;f.client.state.busy=true;
        if(mode==="pending")f.host.pending=true;
        if(mode==="panel-pending")f.client.panelPending=true;
        f.client.request=async(d,c,e,b)=>{
            requests.push(e);
            if(e==="/compatibility"){
                if(mode==="disconnected")throw Object.assign(new Error("offline"),{code:"disconnected"});
                if(mode==="valid")return {connectionId:"connection",protocol:1,version:"0.2.3",updateUrl:descriptor.updateUrl,compatibility:compatibility()};
                if(mode==="stale-probe")f.client.connectionGeneration++;
                throw Object.assign(new Error("invalid credential"),{code:"unauthorized"});
            }
            assert.equal(e,"/pair");assert.equal(c,null);assert.equal(b.panelId,before.panelId);
            assert.equal(f.store.state.credential,before.credential,"never clear credential before server replacement");
            if(mode==="stale-pair")f.client.connectionGeneration++;
            if(mode==="save-failed")f.store.save=()=>{throw Object.assign(new Error("disk full"),{code:"ENOSPC"});};
            return mode==="malformed" ? {} : {connectionId:"connection",credential:"b".repeat(43),protocol:1,version:"0.2.3",updateUrl:descriptor.updateUrl,compatibility:compatibility()};
        };
        const expected={disconnected:"disconnected",malformed:"invalid_response","stale-probe":"stale_binding","stale-pair":"stale_binding","save-failed":"ENOSPC",pending:"host_busy","panel-pending":"host_busy",valid:"credential_valid"}[mode];
        await assert.rejects(f.client.recoverCredential("FRESH"),{code:expected},mode);
        assert.equal(f.store.state.credential,before.credential,mode);assert.equal(f.store.state.panelId,before.panelId,mode);
        assert.equal(f.store.state.uncertain,true,mode);assert.equal(f.host.uncertain,true,mode);
        assert.equal(f.client.state.lock,lock,mode);assert.equal(f.client.running,false,mode);
        assert.equal(f.events.some(e=>e[0]==="host"),false,mode);
        if(["disconnected","stale-probe","pending","panel-pending","valid"].includes(mode))assert.equal(requests.includes("/pair"),false,mode);
    }
});
test("compatibility validation rejects injected URLs, inconsistent fields and unbounded versions",()=>{
    const {compatibilityMetadata:validate}=transport;
    const good=compatibility();
    assert.deepEqual(validate(good),good);
    assert.equal(good.cookieMonsterVersion,null);
    const configured=()=>({...compatibility(),...releaseMetadata({cookieMonsterVersion:"2.4.1",updates:{
        panel:{version:"0.2.3",protocol:1,url:"https://releases.example.test/panel"}
    }})});
    assert.equal(validate(configured()).updates.panel.status,"configured");
    for(const url of ["javascript:alert(1)","http://example.test/a","file:///C:/secret","//example.test/a",
        "https://user:secret@example.test/a","https://example.test/a?token=secret","https://example.test/a#fragment",
        "https://example.test/%0aevil","https://example.test/\\evil","https://example.test/a b","https://example.test/a\n",{}, "https://"+"a".repeat(2050)]){
        const m=configured();m.updates.panel.url=url;
        assert.throws(()=>validate(m),{code:"invalid_response"});
    }
    for(const change of [
        m=>{m.pluginVersion="<script>";},m=>{m.panelVersion="0.2.3\n";},m=>{m.cookieMonsterVersion="1".repeat(65);},
        m=>{m.status="incompatible";},m=>{m.protocol="1";},m=>{m.panelProtocol=null;},
        m=>{m.cookieMonsterVersionStatus="not_configured";},m=>{m.releaseSourceUrl="https://evil.test";},
        m=>{m.updates.panel.version="9.0.0";},m=>{m.updates.panel.protocol=2;},m=>{m.updates.panel.status="approved";},
        m=>{m.updates.plugin.url="https://evil.test";},m=>{m.updates.extra={};},m=>{m.secret="injected";}
    ]){
        const m=configured();change(m);assert.throws(()=>validate(m),{code:"invalid_response"});
    }
});
test("compatibility negotiation discards malformed and stale metadata without altering pairing or recovery state",async()=>{
    for(const mode of ["missing","unsafe-url","foreign-peer","outer-version","stale-credential","stale-descriptor","rejected-invalid"]){
        const f=fixture(),before={...f.store.state};
        f.store.descriptor=()=>({...descriptor,version:"9.0"});
        f.client.state.compatibility=compatibility();
        f.client.request=async()=>{
            const m=compatibility();
            if(mode==="missing")return {};
            if(mode==="unsafe-url")m.updates.panel={status:"configured",version:"0.2.3",protocol:1,url:"javascript:alert(1)"};
            if(mode==="foreign-peer"){m.panelVersion="0.2.3";m.status="incompatible";}
            if(mode==="stale-credential")f.store.state.credential="b".repeat(43);
            if(mode==="stale-descriptor")f.client.descriptor.port++;
            if(mode==="rejected-invalid")throw Object.assign(new Error("mismatch"),{code:"incompatible_version",details:{compatibility:{secret:"NO"}}});
            return {connectionId:"connection",protocol:1,version:mode==="outer-version" ? "9.0" : "0.2.3",updateUrl:descriptor.updateUrl,compatibility:m};
        };
        await assert.rejects(f.client.connect(),{code:mode.startsWith("stale-") ? "stale_binding" : "invalid_response"},mode);
        assert.equal(f.client.state.compatibility,null,mode);
        assert.equal(f.client.running,false,mode);
        assert.equal(f.events.some(e=>e[0]==="host"),false,mode);
        assert.equal(f.store.state.uncertain,before.uncertain,mode);
        assert.equal(f.store.state.panelId,before.panelId,mode);
    }
});
test("compatibility HTTP errors retain only validated negotiation metadata",async t=>{
    let metadata={...compatibility(),status:"incompatible",panelVersion:"0.2.3",panelProtocol:2},code="incompatible_version";
    const server=http.createServer((req,res)=>{
        res.writeHead(409,{"Content-Type":"application/json"});
        res.end(JSON.stringify({error:{code,message:"DO NOT DISPLAY",details:{compatibility:metadata,secret:"DO NOT RETAIN"}}}));
    });
    server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>server.close());
    const d={...descriptor,port:server.address().port};
    await assert.rejects(request(d,"a".repeat(43),"/connect",{}),e=>{
        assert.deepEqual(e.details,{compatibility:metadata});assert.equal(e.message,"Bridge rejected request");return true;
    });
    await assert.rejects(request(d,"a".repeat(43),"/panel",{}),e=>{assert.equal(e.details,undefined);return true;});
    metadata={secret:"NO"};
    await assert.rejects(request(d,"a".repeat(43),"/connect",{}),{code:"invalid_response"});
    code="invalid_pairing_code";
    await assert.rejects(request(d,null,"/pair",{}),e=>{assert.equal(e.details,undefined);return true;});
});
test("compatibility descriptor mismatch probes with credentials and stops before host dispatch",async()=>{
    const f=fixture();f.store.descriptor=()=>({...descriptor,version:"9.0"});
    f.client.request=async(d,c,endpoint,body)=>{
        f.events.push([endpoint,body,c]);
        throw Object.assign(new Error("Mismatch"),{code:"incompatible"});
    };
    f.client.running=true;
    await f.client.tick();
    assert.deepEqual(f.events.filter(e=>e[0]==="/compatibility"),[["/compatibility",{panelId:"panel",protocol:1,version:"0.2.3"},f.store.state.credential]]);
    assert.equal(f.events.some(e=>e[0]==="host"),false);
    assert.equal(f.client.state.connection,"incompatible");assert.equal(f.client.running,false);
});
test("descriptor mismatch hard-stops; reconnect drops binding until fresh heartbeat",async()=>{
    const f=fixture();f.store.descriptor=()=>({...descriptor,version:"9.0"});
    await f.client.tick();assert.equal(f.client.state.connection,"incompatible");assert.equal(f.events.some(e=>e[0]==="host"),false);
    f.store.descriptor=()=>({...descriptor,instanceId:"restart"});await f.client.connect();
    assert.equal(f.client.state.binding,null);
});
test("pair, rotate, unpair use frozen schemas and do not persist pairing code",async()=>{
    const f=fixture();f.store.state.credential=null;
    f.client.request=async(d,c,endpoint,body)=>{f.events.push([endpoint,body,c]);return endpoint==="/unpair" ? {ok:true} : {credential:"b".repeat(43),connectionId:"conn",protocol:1,version:"0.2.3",updateUrl:descriptor.updateUrl,compatibility:compatibility()};};
    await f.client.pair("ABCD");assert.deepEqual(f.events.find(e=>e[0]==="/pair")[1],{code:"ABCD",protocol:1,version:"0.2.3",panelId:"panel"});
    assert.equal(JSON.stringify(f.store.state).includes("ABCD"),false);
    await assert.rejects(f.client.pair("OTHER"),{code:"already_paired"});
    assert.equal(f.events.filter(e=>e[0]==="/pair").length,1);
    await f.client.management("/rotate");assert.equal(f.store.state.credential,"b".repeat(43));
    await f.client.management("/unpair");assert.equal(f.store.state.credential,null);
});
test("native HTTP is loopback-only, no Origin, GET poll has no body; malformed/auth/redirect responses fail",async(t)=>{
    let mode="ok";
    const server=http.createServer(async(req,res)=>{
        assert.equal(req.socket.remoteAddress,"127.0.0.1");assert.equal(req.headers.origin,undefined);assert.equal(req.headers.authorization,"Bearer "+"a".repeat(43));
        const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.equal(Buffer.concat(chunks).length,0);
        res.writeHead(mode==="auth"?401:mode==="redirect"?302:200,{"Content-Type":"application/json",Location:"http://example.invalid/"});
        res.end(mode==="malformed"?"{":mode==="auth"?JSON.stringify({error:{code:"unauthorized"}}):JSON.stringify({command: null}));
    });
    server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>server.close());
    const d={...descriptor,port:server.address().port,hostname:"evil.invalid"};
    assert.deepEqual(await request(d,"a".repeat(43),"/poll"),{command:null});
    for(const [m,code] of [["auth","unauthorized"],["malformed","invalid_response"],["redirect","bridge_error"]]){
        mode=m;await assert.rejects(request(d,"a".repeat(43),"/poll"),{code});
    }
});
test("actual credential store survives reopen, enforces exclusive owner and Windows owner-only ACL",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-store-"));let store;
    try{
        store=new Store(dir,"primary");store.state.credential="a".repeat(43);store.state.uncertain=true;store.save();
        assert.throws(()=>new Store(dir,"primary"),{code:"panel_in_use"});
        const file=store.file;
        if(process.platform==="win32"){
            const p=Buffer.from(file).toString("base64");
            const script="$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+p+"'));$acl=[System.IO.File]::GetAccessControl($p);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=@($acl.Access);if($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 9}";
            execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true});
        }else assert.equal(fs.statSync(file).mode & 0o777,0o600);
        store.close();store=new Store(dir,"primary");assert.equal(store.state.credential,"a".repeat(43));assert.equal(store.state.uncertain,true);
    }finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("two actual profiles pair concurrently with one bridge and preserve independent identities across reopen/restart",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-pairings-")),dir=path.join(root,"bridge");
    let bridge,a,b;
    try{
        bridge=await createBridge({dataDir:dir,heartbeatMs:60000});
        a=new Store(dir,"artist-a");b=new Store(dir,"artist-b");
        const make=store=>new Client({store,host:{call:async()=>({...status,project:{...project,id:store.profile,path:path.join(dir,store.profile+".aep")}})}});
        let ca=make(a),cb=make(b);
        await Promise.all([ca.pair(bridge.pairingCode("session-a").code),cb.pair(bridge.pairingCode("session-b").code)]);
        assert.notEqual(a.state.panelId,b.state.panelId);assert.notEqual(a.state.credential,b.state.credential);
        await Promise.all([ca.connect(),cb.connect()]);
        const connections=await bridge.connections();
        assert.equal(connections.length,2);assert.ok(connections.every(c=>c.connected));
        const ids=new Map(connections.map(c=>[c.panelId,c.connectionId]));
        await bridge.bind("session-a",ids.get(a.state.panelId));
        await bridge.bind("session-b",ids.get(b.state.panelId));
        await ca.management("/rotate");
        ca.mark(true);
        const savedA={...a.state},savedB={...b.state};
        assert.equal(savedB.uncertain,false);
        await assert.rejects(ca.pair("ignored"),{code:"outcome_uncertain"});
        assert.throws(()=>new Store(dir,"artist-a"),{code:"panel_in_use"});
        a.close();b.close();
        a=new Store(dir,"artist-a");b=new Store(dir,"artist-b");
        assert.deepEqual(a.state,savedA);assert.deepEqual(b.state,savedB);
        a.state.panelId=b.state.panelId;
        assert.throws(()=>a.save(),{code:"unsafe_storage"});a.state.panelId=savedA.panelId;
        await bridge.close();bridge=await createBridge({dataDir:dir,heartbeatMs:60000});
        ca=make(a);cb=make(b);
        assert.equal(ca.state.uncertain,true);await ca.tick();
        assert.equal((await bridge.connections()).length,0,"uncertain profile never reconnects automatically");
        // Explicit inspected-outcome reconciliation in this host double clears only A's local latch.
        ca.host.call=async(method)=>method==="reconcile" ? {} : {...status,project:{...project,id:"artist-a",path:path.join(dir,"artist-a.aep")}};
        ca.start=()=>{};
        await ca.reconcile();
        await Promise.all([ca.connect(),cb.connect()]);
        const reopened=await bridge.connections();
        assert.equal(reopened.length,2);
        for(const c of reopened){assert.equal(c.connectionId,ids.get(c.panelId));assert.equal(c.binding,null);}
        await cb.management("/unpair");
        assert.equal(a.state.credential,savedA.credential);assert.equal(b.state.credential,null);
        assert.equal(a.state.uncertain,false);
    }finally{a?.close();b?.close();await bridge?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("actual process claims exclude a live same-profile owner, reclaim crash/PID-reuse locks, and preserve uncertain state",async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-crash-")),children=[];
    const modulePath=fileURLToPath(new URL("../panel/transport.cjs",import.meta.url));
    let store;
    function launch(profile){
        const code=`const {Store}=require(process.argv[1]);let store;
            process.on("message",m=>{if(m==="close"){store?.close();process.exit(0);}});
            try {store=new Store(process.argv[2],process.argv[3]);store.state.credential="c".repeat(43);store.state.uncertain=true;store.save();process.send({state:store.state,lock:store.lock});}
            catch(e){process.send({error:e.code},()=>process.exit(0));}`;
        const child=spawn(process.execPath,["--input-type=commonjs","-e",code,modulePath,dir,profile],{stdio:["ignore","ignore","pipe","ipc"],windowsHide:true});
        children.push(child);
        return {child,result:once(child,"message",{signal:AbortSignal.timeout(30000)}).then(([r])=>r)};
    }
    try{
        const first=launch("primary"),r=await first.result;assert.ok(r.state,JSON.stringify(r));
        const second=launch("secondary"),other=await second.result;assert.ok(other.state,JSON.stringify(other));
        assert.notEqual(r.state.panelId,other.state.panelId);
        const competitor=launch("primary");assert.equal((await competitor.result).error,"panel_in_use");
        const dead=once(first.child,"exit");first.child.kill("SIGKILL");await dead;
        store=new Store(dir,"primary");assert.deepEqual(store.state,r.state);assert.equal(fs.existsSync(r.lock),false);
        const file=store.file,owners=path.dirname(store.lock);
        store.close();
        // A live PID with a different creation stamp is not the owner of this unique stale claim.
        const reused=path.join(owners,process.pid+"-"+"0".repeat(64)+"-"+"a".repeat(48)+".lock");
        fs.writeFileSync(reused,"");
        store=new Store(dir,"primary");assert.equal(fs.existsSync(reused),false);assert.deepEqual(store.state,r.state);
        const oldStore=store;store.close();store=new Store(dir,"primary");oldStore.close();
        assert.ok(fs.existsSync(store.lock),"late close must not unlink a replacement owner's claim");
        assert.throws(()=>oldStore.save(),{code:"ownership_lost"});
        store.close();
        const unknown=path.join(owners,"incomplete-owner");fs.writeFileSync(unknown,"");
        assert.throws(()=>new Store(dir,"primary"),{code:"ownership_unknown"});
        assert.ok(fs.existsSync(unknown));assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),r.state);
        fs.unlinkSync(unknown);
        fs.unlinkSync(file);
        assert.throws(()=>new Store(dir,"primary"),{code:"profile_state_missing"});
    }finally{
        store?.close();
        await Promise.all(children.map(async child=>{if(child.exitCode === null && child.signalCode === null){const exit=once(child,"exit");child.kill("SIGKILL");await exit;}}));
        fs.rmSync(dir,{recursive:true,force:true});
    }
});

test("legacy migration is explicit and in-place; missing/corrupt/uncertain state is never adopted by named profiles",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cm-panel-legacy-"));
    const base=path.join(dir,"panel-private"),file=path.join(base,"credential.json"),lock=path.join(base,"owner.json");
    const state={panelId:"previous-panel",credential:"d".repeat(43),uncertain:true};
    let legacy,named;
    try{
        for(const profile of [undefined,"","../escape","Uppercase","a/b","a".repeat(65)])assert.throws(()=>new Store(dir,profile),{code:"profile_required"});
        assert.throws(()=>new Store(dir,"legacy"),{code:"legacy_missing"});
        named=new Store(dir,"fresh");named.close();
        fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
        assert.throws(()=>new Store(dir,"other"),{code:"profile_state_missing"});
        fs.unlinkSync(lock);
        fs.writeFileSync(file,JSON.stringify(state));
        assert.throws(()=>new Store(dir,"other"),{code:"legacy_uncertain"});
        fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
        assert.throws(()=>new Store(dir,"legacy"),{code:"panel_in_use"});
        assert.equal(JSON.parse(fs.readFileSync(lock,"utf8")).pid,process.pid);
        fs.unlinkSync(lock);
        legacy=new Store(dir,"legacy");assert.equal(legacy.file,file);assert.deepEqual(legacy.state,state);
        assert.throws(()=>new Store(dir,"legacy"),{code:"panel_in_use"});
        assert.throws(()=>new Store(dir,"other"),{code:"legacy_uncertain"});
        legacy.state.uncertain=false;legacy.save();legacy.close();
        legacy=new Store(dir,"legacy");assert.equal(legacy.state.credential,state.credential);assert.equal(legacy.state.panelId,state.panelId);
        named=new Store(dir,"other");assert.equal(named.state.credential,null);assert.notEqual(named.state.panelId,state.panelId);
        named.close();legacy.close();
        fs.writeFileSync(file,'{"uncertain":true}');
        assert.throws(()=>new Store(dir,"legacy"),{code:"unsafe_storage"});
        assert.throws(()=>new Store(dir,"other"),{code:"unsafe_storage"});
        assert.equal(fs.readFileSync(file,"utf8"),'{"uncertain":true}');
    }finally{legacy?.close();named?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test("actual image normalizer uses PNG for alpha/JPEG otherwise, scales, bounds and removes owned temporary output",async()=>{
    for(const [alpha,maxWidth] of [[true,undefined],[false,undefined],[undefined,800],[true,1],[false,2000]]){
        const dir=path.join(os.tmpdir(),"cookiemonster-ae-"+Date.now()+"-"+Math.floor(Math.random()*1e9));fs.mkdirSync(dir);
        const file=path.join(dir,"frame_00000.png"),png=Buffer.alloc(24);Buffer.from("89504e470d0a1a0a","hex").copy(png);png.writeUInt32BE(4000,16);png.writeUInt32BE(1000,20);fs.writeFileSync(file,png);
        let painted=0;
        class ImageDouble{set src(v){assert.ok(v.startsWith("data:image/png;base64,"));queueMicrotask(()=>this.onload());}}
        const document={createElement(tag){assert.equal(tag,"canvas");return {width:0,height:0,getContext(){return {fillRect(){painted++;},drawImage(){}};},toDataURL(mime,quality){assert.equal(quality,.92);return "data:"+mime+";base64,"+Buffer.from("test").toString("base64");}};}};
        const result=await normalizeCapture({path:file,tempDir:dir,alpha,maxWidth},document,ImageDouble);
        assert.equal(result.mime,alpha!==false?"image/png":"image/jpeg");assert.equal(result.width,maxWidth || 2000);assert.equal(result.height,Math.max(1,Math.floor((maxWidth || 2000)/4)));assert.equal(painted,alpha!==false?0:1);assert.equal(fs.existsSync(dir),false);
    }
});
test("normalizer refuses arbitrary paths without deleting them",async()=>{
    const file=path.join(os.tmpdir(),"not-owned-"+Date.now()+".png");fs.writeFileSync(file,"keep");
    try{await assert.rejects(normalizeCapture({path:file,tempDir:os.tmpdir(),alpha:true},{},function(){}),{code:"invalid_capture"});assert.equal(fs.readFileSync(file,"utf8"),"keep");}finally{fs.unlinkSync(file);}
});
test("normalizer rejects invalid width/alpha and cleans only its owned output",async()=>{
    for(const params of [{maxWidth:0},{maxWidth:2001},{maxWidth:1.5},{maxWidth:"800"},{alpha:"yes"}]){
        const dir=path.join(os.tmpdir(),"cookiemonster-ae-"+Date.now()+"-"+Math.floor(Math.random()*1e9));fs.mkdirSync(dir);
        const file=path.join(dir,"frame_00000.png");fs.writeFileSync(file,"unused");
        try{
            await assert.rejects(normalizeCapture({path:file,tempDir:dir,...params},{},function(){assert.fail("Must validate before decode");}),{code:"invalid_capture"});
            assert.equal(fs.existsSync(dir),false);
        }finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
});
test("raw partial errors retain script diagnostics and durable uncertainty through HostRPC and Client",async()=>{
    const message="Script error at line 7: broken; partial changes may remain; do not retry.";
    const host=new HostRPC({evalScript(code,cb){cb(JSON.stringify({error:{code:"uncertain_outcome",message}}));}},1000);
    const f=fixture({host});
    await assert.rejects(f.client.command({id:"raw-failed",method:"raw",params:{source:"throw Error('broken')",expectedRevision:1},sessionID:"session"}),{code:"outcome_uncertain"});
    assert.deepEqual(f.events.find(e=>e[0]==="/reply")[1].error,{code:"uncertain_outcome",message});
    assert.equal(f.store.state.uncertain,true);assert.equal(f.client.state.busy,true);
});
test("panel source syntax stays ES5-shaped and CSP does not enable remote browser code",()=>{
    for(const name of ["ui.js","transport.cjs"]){const source=fs.readFileSync(new URL("../panel/"+name,import.meta.url),"utf8");new vm.Script(source);assert.doesNotMatch(source,/^\s*(?:import |export |const |let |class )/m);}
    const html=fs.readFileSync(new URL("../panel/index.html",import.meta.url),"utf8");assert.match(html,/script-src 'self'/);assert.match(html,/role="alert"/);assert.match(html,/doctype html/);
});

test("pending capture waits for a complete PNG before decoding and cleanup",async()=>{
    const dir=path.join(os.tmpdir(),"cookiemonster-ae-"+Date.now()+"-"+Math.floor(Math.random()*1e9));fs.mkdirSync(dir);
    const file=path.join(dir,"frame_00000.png");
    const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==","base64");
    let decoded=0;
    class ImageDouble{set src(v){decoded++;assert.deepEqual(Buffer.from(v.split(",")[1],"base64"),png);queueMicrotask(()=>this.onload());}}
    const document={createElement(){return {getContext(){return {drawImage(){}};},toDataURL(){return "data:image/png;base64,"+png.toString("base64");}};}};
    const result=normalizeCapture({path:file,tempDir:dir,pending:true,alpha:true},document,ImageDouble);
    const partial=setTimeout(()=>fs.writeFileSync(file,png.subarray(0,24)),10);
    const complete=setTimeout(()=>fs.writeFileSync(file,png),70);
    try{assert.equal((await result).mime,"image/png");assert.equal(decoded,1);assert.equal(fs.existsSync(dir),false);}
    finally{clearTimeout(partial);clearTimeout(complete);fs.rmSync(dir,{recursive:true,force:true});}
});
test("pending capture timeout preserves destination for a late native writer",async t=>{
    const dir=path.join(os.tmpdir(),"cookiemonster-ae-"+Date.now()+"-"+Math.floor(Math.random()*1e9));fs.mkdirSync(dir);
    const file=path.join(dir,"frame_00000.png");
    t.mock.timers.enable({apis:["setTimeout"]});
    try{
        const result=normalizeCapture({path:file,tempDir:dir,pending:true},{},function(){assert.fail("No incomplete decode");});
        const rejected=assert.rejects(result,{code:"capture_timeout"});
        t.mock.timers.tick(10001);await rejected;
        assert.equal(fs.existsSync(dir),true);fs.writeFileSync(file,"late native output");
        assert.throws(()=>transport.cleanupCapture({path:file,tempDir:dir,pending:true}),{code:"capture_pending"});
        assert.equal(fs.readFileSync(file,"utf8"),"late native output");
    }finally{t.mock.timers.reset();fs.rmSync(dir,{recursive:true,force:true});}
});

test("native PNG timeout keeps the panel uncertainty latch and prevents another host dispatch",async()=>{
    const f=fixture({normalize:async()=>{throw Object.assign(Error("PNG still pending"),{code:"capture_timeout"});}});
    await assert.rejects(f.client.command({id:"capture-pending",method:"capture",params:{compId:1,time:0},sessionID:"session"}),{code:"outcome_uncertain"});
    assert.equal(f.store.state.uncertain,true);assert.equal(f.client.state.busy,true);
    assert.equal(f.events.find(e=>e[0]==="/reply")[1].error.code,"capture_timeout");
    const calls=f.events.filter(e=>e[0]==="host").length;
    await f.client.tick();assert.equal(f.events.filter(e=>e[0]==="host").length,calls);
});

test("native restore gets its own bounded timeout without extending ordinary calls", async()=>{
    const host=new HostRPC({evalScript(code,callback){setTimeout(()=>callback('{"result":{"ok":true}}'),30);}},10,undefined,100);
    assert.deepEqual(await host.call("execute",{phase:"restore_prepare"}),{ok:true});
    await assert.rejects(host.call("inspect",{}),{code:"outcome_uncertain"});
});
