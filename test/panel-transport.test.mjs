import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import transport from "../panel/transport.cjs";
const { Client, HostRPC, Store, request, normalizeCapture } = transport;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const descriptor = {port:12345,instanceId:"instance",protocol:1,version:"0.1.0",updateUrl:"https://github.com/trmosala/CookieJar/releases"};
const project = {id:"path:c:/test.aep",path:"c:/test.aep",saved:true};
const status = {project,capabilities:{fileNetwork:true},aeVersion:"25.3",busy:false,uncertain:false};
function fixture(overrides={}) {
    const events=[],store={state:{panelId:"panel",credential:"a".repeat(43),uncertain:false},save(){events.push(["save",this.state.uncertain]);},descriptor(){return {...descriptor};}};
    let command=null;
    const binding={id:"binding",state:"active",sessionID:"session",project};
    const host={pending:false,uncertain:false,call:async(method,params)=>{events.push(["host",method,params]);return method==="status" ? status : {ok:true};}};
    const client=new Client({store,host,changed(s){events.push(["ui",s.busy,s.capture,s.uncertain]);},beforeCapture:async()=>{events.push(["paint"]);},
        normalize:async r=>({mime:"image/png",data:"AAAA",width:1,height:1}),
        request:async(d,c,endpoint,body)=>{
            events.push([endpoint,body,c]);
            if(endpoint==="/connect")return {connectionId:"connection",protocol:1,version:"0.1.0"};
            if(endpoint==="/heartbeat")return {binding,lock:{state:"executing"}};
            if(endpoint==="/poll"){const c=command;command=null;return {command:c};}
            return {ok:true};
        },...overrides});
    client.descriptor={...descriptor};
    Object.assign(client.state,{connection:"connected",...status,binding,lock:{state:"executing"}});
    return {client,host,store,events,binding,set command(c){command=c;}};
}
test("panel management sends exact authenticated schemas and requires an explicit single-use restore token",async()=>{
    const f=fixture();f.client.state.lock=null;
    const rows=[{id:"cp",createdAt:1000,pinned:false,storageMode:"project",size:123,projectPath:"not returned"}];
    f.client.request=async(d,credential,endpoint,body)=>{
        assert.equal(endpoint,"/panel");assert.equal(credential,f.store.state.credential);f.events.push([endpoint,structuredClone(body)]);
        if(body.action==="checkpoints")return {result:rows};
        if(body.action==="checkpoint.restore.propose")return {result:{token:"opaque-token",sourceTimestamp:1000,destinationTimestamp:2000}};
        if(body.action==="diagnostics")return {result:{version:"0.1.0",counts:{jobs:0}}};
        if(body.action==="renders")return {result:[{id:"job",state:"completed"}]};
        return {result:{ok:true}};
    };
    assert.deepEqual(await f.client.panel("checkpoints",{}),[{id:"cp",createdAt:1000,pinned:false,storageMode:"project",size:123}]);
    await f.client.panel("checkpoint.pin",{id:"cp",pinned:true});
    await f.client.panel("checkpoint.delete",{id:"cp"});
    const proposal=await f.client.panel("checkpoint.restore.propose",{id:"cp"});
    assert.deepEqual(proposal,{sourceTimestamp:1000,destinationTimestamp:2000});assert.equal("token" in proposal,false);
    assert.equal(f.events.some(e=>e[1]?.action==="checkpoint.restore.confirm"),false);
    await f.client.confirmRestore();
    assert.deepEqual(f.events.find(e=>e[0]==="/panel" && e[1].action==="checkpoint.restore.confirm")[1],{action:"checkpoint.restore.confirm",token:"opaque-token"});
    await assert.rejects(f.client.confirmRestore(),{code:"invalid_token"});
    assert.deepEqual(await f.client.panel("diagnostics",{}),{version:"0.1.0",counts:{jobs:0}});
    assert.deepEqual(await f.client.panel("renders",{}),[{id:"job",state:"completed"}]);
    assert.equal(f.events.some(e=>e[0]==="host"),false,"services do not collect host content");
    assert.equal(JSON.stringify(f.store.state).includes("opaque-token"),false);
    await assert.rejects(f.client.panel("checkpoint.pin",{id:"cp",pinned:true,sessionID:"other"}),{code:"invalid_payload"});
});
test("restore approval is invalidated by binding switch/cancel and consumed even when confirmation fails",async()=>{
    const f=fixture();f.client.state.lock=null;
    f.client.request=async(d,c,e,body)=>body.action==="checkpoint.restore.propose" ? {result:{token:"once",sourceTimestamp:1,destinationTimestamp:null}} : Promise.reject(Object.assign(new Error("lost response"),{code:"disconnected"}));
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
    f.client.beforeCapture=async()=>{throw Object.assign(new Error("Hidden"),{code:"unsafe_state"});};
    await f.client.command({id:"cap",method:"capture",params:{},sessionID:"session"});
    assert.equal(f.events.some(e=>e[0]==="host"),false);
});
test("descriptor mismatch hard-stops; reconnect drops binding until fresh heartbeat",async()=>{
    const f=fixture();f.store.descriptor=()=>({...descriptor,version:"9.0"});
    await f.client.tick();assert.equal(f.client.state.connection,"incompatible");assert.equal(f.events.some(e=>e[0]==="host"),false);
    f.store.descriptor=()=>({...descriptor,instanceId:"restart"});await f.client.connect();
    assert.equal(f.client.state.binding,null);
});
test("pair, rotate, unpair use frozen schemas and do not persist pairing code",async()=>{
    const f=fixture();f.store.state.credential=null;
    f.client.request=async(d,c,endpoint,body)=>{f.events.push([endpoint,body,c]);return endpoint==="/unpair" ? {ok:true} : {credential:"b".repeat(43),connectionId:"conn",protocol:1,version:"0.1.0",updateUrl:descriptor.updateUrl};};
    await f.client.pair("ABCD");assert.deepEqual(f.events.find(e=>e[0]==="/pair")[1],{code:"ABCD",protocol:1,version:"0.1.0",panelId:"panel"});
    assert.equal(JSON.stringify(f.store.state).includes("ABCD"),false);
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
        store=new Store(dir);store.state.credential="a".repeat(43);store.state.uncertain=true;store.save();
        assert.throws(()=>new Store(dir),{code:"panel_in_use"});
        const file=store.file;
        if(process.platform==="win32"){
            const p=Buffer.from(file).toString("base64");
            const script="$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+p+"'));$acl=[System.IO.File]::GetAccessControl($p);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=@($acl.Access);if($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 9}";
            execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true});
        }else assert.equal(fs.statSync(file).mode & 0o777,0o600);
        store.close();store=new Store(dir);assert.equal(store.state.credential,"a".repeat(43));assert.equal(store.state.uncertain,true);
    }finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("actual image normalizer uses PNG for alpha/JPEG otherwise, scales, bounds and removes owned temporary output",async()=>{
    for(const alpha of [true,false]){
        const dir=path.join(os.tmpdir(),"cookiemonster-ae-"+Date.now()+"-"+Math.floor(Math.random()*1e9));fs.mkdirSync(dir);
        const file=path.join(dir,"frame_00000.png"),png=Buffer.alloc(24);Buffer.from("89504e470d0a1a0a","hex").copy(png);png.writeUInt32BE(4000,16);png.writeUInt32BE(1000,20);fs.writeFileSync(file,png);
        let painted=0;
        class ImageDouble{set src(v){assert.ok(v.startsWith("data:image/png;base64,"));queueMicrotask(()=>this.onload());}}
        const document={createElement(tag){assert.equal(tag,"canvas");return {width:0,height:0,getContext(){return {fillRect(){painted++;},drawImage(){}};},toDataURL(mime,quality){assert.equal(quality,.92);return "data:"+mime+";base64,"+Buffer.from("test").toString("base64");}};}};
        const result=await normalizeCapture({path:file,tempDir:dir,alpha},document,ImageDouble);
        assert.equal(result.mime,alpha?"image/png":"image/jpeg");assert.equal(result.width,2000);assert.equal(result.height,500);assert.equal(painted,alpha?0:1);assert.equal(fs.existsSync(dir),false);
    }
});
test("normalizer refuses arbitrary paths without deleting them",async()=>{
    const file=path.join(os.tmpdir(),"not-owned-"+Date.now()+".png");fs.writeFileSync(file,"keep");
    try{await assert.rejects(normalizeCapture({path:file,tempDir:os.tmpdir(),alpha:true},{},function(){}),{code:"invalid_capture"});assert.equal(fs.readFileSync(file,"utf8"),"keep");}finally{fs.unlinkSync(file);}
});
test("panel source syntax stays ES5-shaped and CSP does not enable remote browser code",()=>{
    for(const name of ["ui.js","transport.cjs"]){const source=fs.readFileSync(new URL("../panel/"+name,import.meta.url),"utf8");new vm.Script(source);assert.doesNotMatch(source,/^\s*(?:import |export |const |let |class )/m);}
    const html=fs.readFileSync(new URL("../panel/index.html",import.meta.url),"utf8");assert.match(html,/script-src 'self'/);assert.match(html,/role="alert"/);assert.match(html,/doctype html/);
});
