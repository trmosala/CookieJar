import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridge } from "../src/bridge.mjs";
import transport from "../panel/transport.cjs";
import { hostDouble } from "./workflow-host.mjs";

const source = readFileSync(new URL("../panel/host.jsx", import.meta.url), "utf8");
function fixture() {
    const PT = { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 };
    const VT = Object.fromEntries(["NO_VALUE","OneD","TwoD","ThreeD","TwoD_SPATIAL","ThreeD_SPATIAL","COLOR","CUSTOM_VALUE","MARKER","TEXT_DOCUMENT","SHAPE"].map((k,i)=>[k,i+1]));
    let next = 100, begins = 0, ends = 0;
    class Property {
        constructor(name, value=100, type=VT.OneD) {
            Object.assign(this,{name,matchName:name,propertyType:PT.PROPERTY,propertyValueType:type,value,numKeys:0,canSetExpression:true,canVaryOverTime:true,expression:"",expressionError:"",expressionEnabled:false,hasMin:false,hasMax:false,isSpatial:false,isSeparationLeader:false,keys:[]});
        }
        setValue(v) { this.value=v; }
        valueAtTime() { return this.value; }
        setValueAtTime(time,value) { const k=this.keys.find(k=>k.time===time);if(k)k.value=value;else this.keys.push({time,value});this.keys.sort((a,b)=>a.time-b.time);this.numKeys=this.keys.length; }
        keyTime(k) { return this.keys[k-1].time; }
        keyValue(k) { return this.keys[k-1].value; }
        keyInInterpolationType() { return 1; } keyOutInterpolationType() { return 1; }
        keyInTemporalEase() { return [{speed:0,influence:33}]; } keyOutTemporalEase() { return [{speed:0,influence:33}]; }
        keyTemporalContinuous() { return false; } keyTemporalAutoBezier() { return false; } keyLabel() { return 0; }
        removeKey(k) { this.keys.splice(k-1,1);this.numKeys=this.keys.length; }
        isInterpolationTypeValid() { return true; }
        setInterpolationTypeAtKey(k,a,b) { this.keys[k-1].interpolation=[a,b]; }
        setTemporalEaseAtKey() {} setTemporalContinuousAtKey() {} setTemporalAutoBezierAtKey() {} setLabelAtKey() {}
    }
    class Group {
        constructor(name,children=[]) { Object.assign(this,{name,matchName:name,propertyType:PT.INDEXED_GROUP,children}); children.forEach(p=>p.parentProperty=this); }
        get numProperties() { return this.children.length; }
        property(index) { return typeof index==="number" ? this.children[index-1] || null : this.children.find(p=>p.matchName===index) || null; }
        canAddProperty(name) { return name==="ADBE Slider Control"; }
        addProperty(name) { const p=new Group(name,[new Property("ADBE Slider Control-0001",0)]);p.isEffect=true;p.enabled=true;p.canSetEnabled=true;p.parentProperty=this;this.children.push(p);return p; }
    }
    class Layer {
        constructor(comp,kind="",text="") {
            Object.assign(this,{id:next++,name:kind,matchName:"ADBE AV Layer",enabled:true,locked:false,shy:false,solo:false,startTime:0,inPoint:0,outPoint:comp.duration,stretch:100,parent:null,source:null,selected:false,threeDLayer:false,containingComp:comp});
            this.effects=new Group("ADBE Effect Parade");
            this.transform=new Group("ADBE Transform Group",[new Property("ADBE Opacity"),new Property("ADBE Position",[0,0],VT.TwoD)]);
            this.text=new Group("ADBE Text Properties",[new Property("ADBE Text Document",{text},VT.TEXT_DOCUMENT)]);
            this.groups=[this.effects];
            this.kind=kind;
        }
        get numProperties(){return this.groups.length;}
        property(p){if(typeof p==="number")return this.groups[p-1] || null;return this.groups.find(g=>g.matchName===p) || (p===this.transform.matchName ? this.transform : p===this.text.matchName && this.kind==="text" ? this.text : null);}
        remove(){this.containingComp.list.splice(this.containingComp.list.indexOf(this),1);}
        moveToEnd(){this.remove();this.containingComp.list.push(this);}
        moveBefore(l){this.remove();this.containingComp.list.splice(this.containingComp.list.indexOf(l),0,this);}
    }
    class TextLayer extends Layer {}
    class CameraLayer extends Layer {}
    class LightLayer extends Layer {}
    class FolderItem { constructor(name){this.id=next++;this.name=name;this.parentFolder=null;} }
    class FileSource {
        constructor(){Object.assign(this,{isStill:true,hasAlpha:true,alphaMode:1,invertAlpha:false,premulColor:[0,0,0]});}
    }
    class FootageItem {
        constructor(file){Object.assign(this,{id:next++,name:"Footage",file,mainSource:new FileSource(),footageMissing:false,useProxy:false,parentFolder:null});}
    }
    class ImportOptions {
        constructor(file){this.file=file;}
        canImportAs(){return true;}
    }
    class CompItem {
        constructor(name="Comp",width=1920,height=1080,pixelAspect=1,duration=5,frameRate=25){
            Object.assign(this,{id:next++,name,width,height,pixelAspect,duration,frameRate,time:0,bgColor:[0,0,0],parentFolder:null,list:[]});
            const add=(kind,text)=>{const l=kind==="text" ? new TextLayer(this,kind,text) : new Layer(this,kind);this.list.unshift(l);return l;};
            this.layers={addText:t=>add("text",t),addShape:()=>add("shape"),addNull:()=>add(""),addSolid:()=>add("solid"),addCamera:()=>add("camera"),addLight:()=>add("light"),add:s=>{const l=add("footage");l.source=s;return l;}};
        }
        get numLayers(){return this.list.length;} get frameDuration(){return 1/this.frameRate;}
        layer(i){return this.list[i-1];} remove(){project.list.splice(project.list.indexOf(this),1);}
    }
    const comp=new CompItem(), lyr=comp.layers.addNull();
    const rqItems=[], disk=new Map();
    class File {
        constructor(p){this.fsName=p;this.exists=true;this.alias=false;this.length=100;}
        remove(){disk.delete(this.fsName);return true;}
    }
    class Folder {
        constructor(p){this.fsName=p;this.exists=disk.has(p);}
        create(){disk.set(this.fsName,"dir");return true;}
        getFiles(pattern){return [...disk.keys()].filter(p=>p.startsWith(this.fsName+"/") && (!pattern || p.endsWith(".png"))).map(p=>new File(p));}
        remove(){disk.delete(this.fsName);return true;}
    }
    Folder.temp={fsName:"C:/Temp"};
    const RQ={QUEUED:1,UNQUEUED:2,DONE:3,USER_STOPPED:4,ERR_STOPPED:5,NEEDS_OUTPUT:6,RENDERING:7,WILL_CONTINUE:8};
    const queue={
        rendering:false,get numItems(){return rqItems.length;},item:i=>rqItems[i-1],
        items:{add(c){
            const om={templates:["PNG"],file:null,applyTemplate(){},getSettings(){return {Format:"PNG Sequence"};},setSettings(){},postRenderAction:0};
            const r={comp:c,status:RQ.QUEUED,onStatusChanged:null,templates:["Best Settings"],outputModule(){return om;},setSettings(){},remove(){rqItems.splice(rqItems.indexOf(this),1);}};
            Object.defineProperty(r,"render",{configurable:true,get(){return this.status===RQ.QUEUED;},set(v){this.status=v?RQ.QUEUED:RQ.UNQUEUED;}});
            rqItems.push(r);return r;
        }},
        render(){for(const r of rqItems)if(r.render){disk.set(r.outputModule(1).file.fsName.replace("[#####]","00000"),"png");r.status=RQ.DONE;}}
    };
    const project={list:[comp],file:new File("C:/Project/demo.aep"),revision:1,dirty:false,renderQueue:queue,activeItem:comp,
        get numItems(){return this.list.length;},item(i){return this.list[i-1];},save(){},
        importFile(options){const footage=new FootageItem(options.file);this.list.push(footage);this.revision++;return footage;},
        items:{addComp(...args){const c=new CompItem(...args);project.list.push(c);return c;},addFolder(name){const f=new FolderItem(name);project.list.push(f);return f;}}};
    const app={project,version:"25.3",effects:[{matchName:"ADBE Slider Control",displayName:"Slider",category:"Controls",version:"1"}],preferences:{getPrefAsLong(){return 1;}},beginUndoGroup(){begins++;},endUndoGroup(){ends++;},open(file){project.file=file;return project;}};
    const context=vm.createContext({app,$:{os:"Windows"},FootageItem,FileSource,ImportOptions,ImportAsType:{FOOTAGE:1},CompItem,FolderItem,TextLayer,CameraLayer,LightLayer,PropertyType:PT,PropertyValueType:VT,KeyframeInterpolationType:{LINEAR:1,BEZIER:2,HOLD:3},KeyframeEase:function(speed,influence){this.speed=speed;this.influence=influence;},Shape:function(){},File,Folder,RQItemStatus:RQ,GetSettingsFormat:{STRING:1},PostRenderAction:{NONE:0},MarkerValue:function(comment){this.comment=comment;}});
    vm.runInContext(source,context);
    const call=(method,params={})=>JSON.parse(context.CookieMonsterAE.dispatch(JSON.stringify({method,params})));
    const plan=actions=>{const p=call("preflight",{actions});assert.ok(p.result,JSON.stringify(p));return p.result.actions;};
    const run=actions=>call("execute",{actions:plan(actions)});
    const locator=()=>call("inspect").result.items[0].layers[0].properties.find(p=>p.matchName==="ADBE Transform Group").properties[0].locator;
    return {call,run,plan,locator,context,app,project,comp,lyr,Property,Group,File,FootageItem,queue,rqItems,disk,RQ,get begins(){return begins;},get ends(){return ends;}};
}
function animation(f) {
    const props=f.lyr.transform.children;
    // Native-like setters increment revision/dirty, while reads and endUndoGroup do not undo mutations.
    for(const p of props){
        for(const method of ["setValue","setValueAtTime","removeKey","setInterpolationTypeAtKey"]){
            const original=p[method].bind(p);
            p[method]=(...args)=>{const result=original(...args);f.project.revision++;f.project.dirty=true;return result;};
        }
        p.setTemporalEaseAtKey=(k,inEase,outEase)=>{p.keys[k-1].inEase=structuredClone(inEase);p.keys[k-1].outEase=structuredClone(outEase);f.project.revision++;f.project.dirty=true;};
        p.keyInTemporalEase=k=>p.keys[k-1].inEase || [{speed:0,influence:33}];
        p.keyOutTemporalEase=k=>p.keys[k-1].outEase || [{speed:0,influence:33}];
        p.keyInInterpolationType=k=>p.keys[k-1].interpolation?.[0] || 1;
        p.keyOutInterpolationType=k=>p.keys[k-1].interpolation?.[1] || 1;
        let expression="";
        Object.defineProperty(p,"expression",{configurable:true,get(){return expression;},set(value){expression=value;f.project.revision++;f.project.dirty=true;p.expressionEnabled=!!value;p.expressionError=value==="bad(" ? "Syntax error" : "";}});
    }
    const locators=f.call("inspect").result.items[0].layers[0].properties.find(p=>p.matchName==="ADBE Transform Group").properties.map(p=>p.locator);
    return [
        {type:"keyframe.set",locator:locators[0],time:0,value:0},
        {type:"keyframe.set",locator:locators[1],time:0,value:[0,0]},
        {type:"keyframe.set",locator:locators[0],time:2,value:100},
        {type:"keyframe.set",locator:locators[1],time:2,value:[200,100]},
        {type:"keyframe.interpolation",locator:locators[0],time:2,inType:"bezier",outType:"bezier",inEase:[{speed:5,influence:60}],outEase:[{speed:0,influence:40}]},
        {type:"expression.set",locator:locators[1],source:"value + [10, 20]",enabled:true}
    ];
}
test("duplicate footage imports reuse pinned native identity and preserve interpretation",()=>{
    const f=fixture(),file=new f.File("C:/Project/asset.png"),footage=new f.FootageItem(file);
    f.project.list.push(footage);
    const original=JSON.stringify(footage.mainSource),input=[{type:"asset.import",path:file.fsName,ref:"reused"}];
    let imported=0;
    f.project.importFile=()=>{imported++;throw Error("must reuse");};
    const result=f.run(input);
    assert.equal(result.result.results[0].id,footage.id);
    assert.equal(imported,0);assert.equal(JSON.stringify(footage.mainSource),original);
    assert.deepEqual(input,[{type:"asset.import",path:file.fsName,ref:"reused"}]);
    const pinned=f.plan(input);
    footage.mainSource.invertAlpha=true;
    assert.equal(f.call("execute",{actions:pinned}).error.code,"stale_plan");
    assert.equal(imported,0);
});
test("duplicate imports within one plan create only one native FootageItem",()=>{
    const f=fixture(),result=f.run([{type:"asset.import",path:"C:/Project/asset.png"},{type:"asset.import",path:"C:/Project/asset.png"}]);
    assert.ok(result.result,JSON.stringify(result));
    assert.equal(result.result.results[0].id,result.result.results[1].id);
    assert.equal(f.project.list.filter(item=>item instanceof f.FootageItem).length,1);
});
test("disabled ancestor protects stored properties and destructive layer operations",()=>{
    const f=fixture(),fx=f.lyr.effects.addProperty("ADBE Slider Control");
    fx.enabled=false;
    const effect=f.call("inspect").result.items[0].layers[0].properties[0].properties[0],loc=effect.properties[0].locator;
    for(const action of [
        {type:"property.set",locator:loc,value:1},{type:"keyframe.set",locator:loc,time:0,value:1},
        {type:"expression.set",locator:loc,source:"1"},{type:"effect.remove",locator:effect.locator},
        {type:"effect.reorder",locator:effect.locator,index:1},{type:"effect.enable",locator:effect.locator,enabled:false},
        {type:"effect.enable",locator:loc,enabled:true},
        {type:"layer.delete",compId:f.comp.id,layerId:f.lyr.id},{type:"comp.delete",compId:f.comp.id}
    ])assert.equal(f.call("preflight",{actions:[action]}).error.code,"disabled_effect");
    assert.equal(fx.property(1).value,0);assert.equal(fx.enabled,false);assert.equal(f.begins,0);
});
test("approved re-enable changes only the installed effect flag and retains normal property validation",()=>{
    const f=fixture(),fx=f.lyr.effects.addProperty("ADBE Slider Control"),stored=fx.property(1);
    stored.setValueAtTime(1,7);stored.expression="value + 2";stored.expressionEnabled=true;
    const plain=new f.Property("Static slider",17);plain.parentProperty=fx;fx.children.push(plain);
    const sibling=f.lyr.effects.addProperty("ADBE Slider Control");sibling.enabled=false;
    let enabled=false,enableWrites=0,dataWrites=0;
    Object.defineProperty(fx,"enabled",{get(){return enabled;},set(value){enableWrites++;enabled=value;f.project.revision++;}});
    for(const p of fx.children){
        const set=p.setValue.bind(p);
        p.setValue=value=>{dataWrites++;set(value);};
        for(const method of ["setValueAtTime","removeKey","setInterpolationTypeAtKey"])p[method]=()=>{dataWrites++;throw Error("Stored animation changed");};
        for(const key of ["expression","expressionEnabled"]){
            const value=p[key];
            Object.defineProperty(p,key,{get(){return value;},set(){dataWrites++;throw Error("Stored expression changed");}});
        }
    }
    const before=f.call("inspect").result.items[0].layers[0].properties[0].properties[0];
    const enable={type:"effect.enable",locator:before.locator,enabled:true};
    assert.equal(f.call("execute",{actions:[enable]}).error.code,"stale_plan");
    assert.equal(f.call("preflight",{actions:[enable,{type:"property.set",locator:before.properties[1].locator,value:9}]}).error.code,"disabled_effect");
    fx.canSetEnabled=false;
    assert.equal(f.call("preflight",{actions:[enable]}).error.code,"unsupported_effect");fx.canSetEnabled=true;
    f.lyr.locked=true;
    assert.equal(f.call("preflight",{actions:[enable]}).error.code,"locked_layer");f.lyr.locked=false;
    assert.ok(f.call("preflight",{actions:[{...enable,enabled:"true"}]}).error);
    assert.ok(f.call("preflight",{actions:[{...enable,value:9}]}).error);
    const approved=f.plan([enable]);
    assert.equal(enableWrites,0);assert.equal(dataWrites,0);assert.equal(fx.enabled,false);
    const result=f.call("execute",{actions:approved});
    assert.ok(result.result,JSON.stringify(result));
    assert.equal(fx.enabled,true);assert.equal(sibling.enabled,false);
    assert.equal(enableWrites,1);assert.equal(dataWrites,0);
    const after=f.call("inspect").result.items[0].layers[0].properties[0].properties[0];
    assert.deepEqual(after.properties.map(({locator,...data})=>data),before.properties.map(({locator,...data})=>data));
    assert.equal(f.call("preflight",{actions:[{type:"property.set",locator:before.properties[1].locator,value:9}]}).error.code,"stale_locator");
    assert.equal(f.call("preflight",{actions:[{type:"property.set",locator:after.properties[0].locator,value:9}]}).error.code,"invalid_target");
    assert.equal(f.call("preflight",{actions:[{type:"property.set",locator:after.properties[1].locator,value:[9,1]}]}).error.code,"invalid_payload");
    assert.ok(f.run([{type:"property.set",locator:after.properties[1].locator,value:9}]).result);
    assert.equal(plain.value,9);assert.equal(dataWrites,1);
});
test("re-enable refuses missing effects and retains exact transaction identity pins",()=>{
    const missing=fixture(),absent=missing.lyr.effects.addProperty("Absent Plugin");absent.enabled=false;
    const loc=missing.call("inspect").result.items[0].layers[0].properties[0].properties[0].locator;
    assert.equal(missing.call("preflight",{actions:[{type:"effect.enable",locator:loc,enabled:true}]}).error.code,"missing_effect");
    assert.equal(absent.enabled,false);assert.equal(missing.begins,0);
    for(const change of ["swap","replace"]){
        const f=fixture(),a=f.lyr.effects.addProperty("ADBE Slider Control"),b=f.lyr.effects.addProperty("ADBE Slider Control");
        a.enabled=false;b.enabled=false;
        const snapshot=f.call("inspect").result,transaction={id:change,sessionID:"s",bindingID:"b"};
        const actions=f.plan([{type:"effect.enable",locator:snapshot.items[0].layers[0].properties[0].properties[0].locator,enabled:true}]);
        assert.equal(f.call("execute",{phase:"begin",transaction,actions}).result.status,"prepared");
        if(change==="swap")f.lyr.effects.children.reverse();
        else{
            const replacement=f.lyr.effects.addProperty("ADBE Slider Control");replacement.enabled=false;
            f.lyr.effects.children.pop();f.lyr.effects.children[0]=replacement;
        }
        assert.deepEqual(f.call("inspect").result,snapshot);
        assert.equal(f.call("execute",{phase:"chunk",transaction,offset:0,count:1,expected:snapshot}).error.code,"uncertain_outcome");
        assert.equal(a.enabled,false);assert.equal(b.enabled,false);
        assert.ok(f.lyr.effects.children.every(effect=>effect.enabled===false));
    }
});
test("transaction chunks reject replay, foreign owners and identical sibling replacement",()=>{
    const f=fixture(),actions=animation(f),transaction={id:"one",sessionID:"session",bindingID:"binding"};
    f.plan(actions);
    assert.equal(f.call("execute",{phase:"begin",transaction,actions}).result.status,"prepared");
    const before=f.call("inspect").result,first={phase:"chunk",transaction,offset:0,count:1,expected:before};
    const next=f.call("execute",first).result;
    assert.equal(next.offset,1);
    assert.equal(f.call("execute",first).error.code,"stale_plan");
    const second={phase:"chunk",transaction,offset:1,count:1,expected:next.snapshot};
    assert.equal(f.call("execute",{...second,transaction:{...transaction,bindingID:"other"}}).error.code,"stale_plan");
    const old=f.lyr.transform.children[1],replacement=new f.Property(old.name,old.value,old.propertyValueType);
    replacement.parentProperty=old.parentProperty;f.lyr.transform.children[1]=replacement;
    assert.equal(f.call("execute",second).error.code,"uncertain_outcome");
    assert.equal(replacement.numKeys,0);
});
test("multi-property keys, easing and expression preflight is immutable and executes as one revision-safe chunk",()=>{
    const f=fixture(),actions=animation(f),original=structuredClone(actions),revision=f.project.revision;
    const approved=f.plan(actions);
    assert.equal(f.project.revision,revision);assert.equal(f.project.dirty,false);
    assert.equal(f.lyr.transform.property(1).numKeys,0);assert.deepEqual(actions,original);
    const result=f.call("execute",{actions:approved});
    assert.ok(result.result,JSON.stringify(result));
    assert.equal(result.result.results.length,6);assert.equal(f.begins,1);assert.equal(f.ends,1);
    assert.deepEqual(f.lyr.transform.property(1).keys[1].inEase,[{speed:5,influence:60}]);
    assert.deepEqual(f.lyr.transform.property(1).keys[1].interpolation,[2,2]);
    assert.equal(f.lyr.transform.property(2).expression,"value + [10, 20]");
    assert.ok(f.project.revision>revision);
    assert.equal(f.call("preflight",{actions:approved}).error.code,"stale_locator","old locators cannot authorize a new chunk");
});
test("partial native failure returns a stopped snapshot; unverified dirty recovery refuses",()=>{
    const f=fixture(),actions=animation(f);actions.at(-1).source="bad(";
    const result=f.run(actions);
    assert.equal(result.result.status,"stopped");assert.equal(result.result.failure.actionIndex,5);
    assert.equal(result.result.failure.code,"expression_error");
    assert.deepEqual(result.result.recovery.snapshot,f.call("inspect").result);
    assert.equal(f.lyr.transform.property(1).numKeys,2);assert.equal(f.lyr.transform.property(2).numKeys,2);
    assert.equal(f.lyr.transform.property(2).expression,"bad(");assert.equal(f.project.dirty,true);
    assert.equal(f.ends,1);assert.equal(f.call("status").result.uncertain,false);
    assert.equal(f.call("open",{path:"C:/Project/checkpoint.aep"}).error.code,"unsafe_state");
    assert.equal(f.lyr.transform.property(1).numKeys,2,"failed rollback attempt cannot discard partial state");
    // Model explicit artist recovery, not an automatic rollback or a fabricated AE undo API.
    for(const p of f.lyr.transform.children){p.keys=[];p.numKeys=0;p.expression="";p.expressionEnabled=false;}
    f.project.dirty=false;f.call("reconcile");
    assert.equal(f.call("status").result.uncertain,false);
    assert.equal(f.call("execute",{actions}).error.code,"stale_plan","reconciliation never retries the old plan");
});
test("chunk owner must match the expected snapshot and re-inspect locators rather than reusing old revisions",()=>{
    const f=fixture(),actions=animation(f),first=actions[0],next=actions[2];
    const expectedBefore=JSON.stringify(f.call("inspect").result);
    assert.equal(JSON.stringify(f.call("inspect").result),expectedBefore);
    const result=f.run([first]);assert.ok(result.result,JSON.stringify(result));
    const expectedAfter=f.call("inspect").result;
    assert.equal(f.call("preflight",{actions:[next]}).error.code,"stale_locator");
    assert.deepEqual(f.call("inspect").result,expectedAfter);
    const fresh=expectedAfter.items[0].layers[0].properties.find(p=>p.matchName==="ADBE Transform Group").properties[0].locator;
    assert.deepEqual({...fresh,revision:next.locator.revision},next.locator,"only the proof-backed revision can change");
    assert.ok(f.run([{...next,locator:fresh}]).result);
    const expected=f.call("inspect").result.fingerprint;
    f.lyr.transform.property(1).value=17;f.project.revision++;
    assert.notEqual(f.call("inspect").result.fingerprint,expected,"parent must stop/re-propose on external drift, not rebase it");
});
test("execution pins reject changed siblings even when names and types remain identical",()=>{
    for(const change of ["swap","replace","rename","append"]){
        const f=fixture(),a=f.lyr.effects.addProperty("ADBE Slider Control"),b=f.lyr.effects.addProperty("ADBE Slider Control");
        const loc=f.call("inspect").result.items[0].layers[0].properties[0].properties[0].properties[0].locator;
        const p=f.lyr.transform.property(1),first=f.locator(),original=p.setValue.bind(p);
        p.setValue=value=>{
            original(value);f.project.revision++;
            if(change==="swap")f.lyr.effects.children.reverse();
            if(change==="replace")f.lyr.effects.children[0]=new f.Group(a.name,a.children);
            if(change==="rename")b.name="Renamed sibling";
            if(change==="append")f.lyr.effects.addProperty("ADBE Slider Control");
        };
        const result=f.run([{type:"property.set",locator:first,value:20},{type:"property.set",locator:loc,value:70}]);
        assert.equal(result.error.code,"uncertain_outcome",change);assert.match(result.error.message,/identity changed/);
        assert.equal(a.property(1).value,0);assert.equal(p.value,20);assert.equal(f.ends,1);
    }
});
test("inspection of disabled and missing effects never calls plugin setters or creates effect instances",()=>{
    const f=fixture(),fx=f.lyr.effects.addProperty("ADBE Slider Control"),missing=f.lyr.effects.addProperty("Absent Plugin");
    let writes=0;
    for(const e of [fx,missing]){
        Object.defineProperty(e,"enabled",{get(){return false;},set(){writes++;throw new Error("licensing setter");}});
        const p=e.property(1);
        for(const method of ["setValue","setValueAtTime","setInterpolationTypeAtKey"])p[method]=()=>{writes++;throw new Error("plugin write");};
        Object.defineProperty(p,"expression",{get(){return "";},set(){writes++;throw new Error("expression setter");}});
    }
    f.lyr.effects.addProperty=()=>{writes++;throw new Error("plugin creation");};
    f.lyr.effects.canAddProperty=()=>{writes++;throw new Error("capability probe not needed for inspection");};
    const a=f.call("inspect"),b=f.call("inspect");
    assert.ok(a.result,JSON.stringify(a));assert.deepEqual(a,b);assert.equal(writes,0);
    const effects=a.result.items[0].layers[0].properties[0].properties;
    assert.equal(effects[0].enabled,false);assert.equal(effects[1].missing,true);
});
test("actual bridge and panel transport dispatch host source, unlock after reply, and suspend on reconnect (AE doubled)",async()=>{
    const parent=mkdtempSync(path.join(os.tmpdir(),"cm-panel-http-")),dir=path.join(parent,"bridge"),f=fixture();
    f.project.file.fsName=path.join(dir,"example.aep");
    const bridge=await createBridge({dataDir:dir,heartbeatMs:30000,timeoutMs:5000});
    const store={state:{panelId:"integration-panel",credential:null,uncertain:false},save(){},descriptor(){return JSON.parse(readFileSync(path.join(dir,"descriptor.json"),"utf8"));}};
    const host=new transport.HostRPC({evalScript(code,cb){cb(vm.runInContext(code,f.context));}},3000);
    const client=new transport.Client({store,host});
    try{
        await client.pair(bridge.pairingCode("integration-session").code);
        await client.connect();
        const connection=(await bridge.connections())[0];
        assert.equal(connection.activeCompId,f.comp.id,"connect publishes the active composition before inspection");
        await bridge.bind("integration-session",connection.id);
        const bindingId=bridge.binding("integration-session").id;
        for(const active of [,new f.FootageItem(new f.File("C:/Project/asset.png")),f.comp]){
            f.project.activeItem=active;
            await client.tick();
            assert.equal((await bridge.connections())[0].activeCompId,active===f.comp ? f.comp.id : null);
            assert.equal(bridge.binding("integration-session").id,bindingId,"selection changes do not suspend the binding");
        }
        async function rpc(method,params={}){
            let completed=false;
            const pending=bridge.call("integration-session",method,params,{allowLocked:true}).then(result=>{completed=true;return {result};},error=>{completed=true;return {error};});
            for(let i=0;i<100 && !completed;i++){await client.tick();await new Promise(r=>setTimeout(r,5));}
            const response=await pending;
            if(response.error)throw response.error;
            return response.result;
        }
        const snapshot=await rpc("inspect");
        assert.equal(snapshot.items[0].id,f.comp.id);
        await bridge.lock("integration-session",{kind:"structured"});
        const approved=await rpc("preflight",{actions:[{type:"comp.create",name:"HTTP Scene",width:640,height:480,pixelAspect:1,duration:2,frameRate:25}]});
        const result=await rpc("execute",{actions:approved.actions});
        assert.equal(result.results.length,1);assert.equal(f.project.list[1].name,"HTTP Scene");
        await bridge.unlock("integration-session");
        assert.equal(bridge.binding("integration-session").lock,null);
        await client.connect();
        assert.throws(()=>bridge.binding("integration-session"),{code:"binding_suspended"});
        assert.equal(store.state.uncertain,false);
    }finally{client.stop();await bridge.close();rmSync(dir,{recursive:true,force:true});}
});
test("preflight refuses deleted targets, indirect cycles and invalidated dependent actions without mutation",()=>{
    const f=fixture(),loc=f.locator();
    for(const actions of [
        [{type:"layer.delete",compId:f.comp.id,layerId:f.lyr.id},{type:"property.set",locator:loc,value:10}],
        [{type:"comp.delete",compId:f.comp.id},{type:"comp.delete",compId:f.comp.id}],
        [{type:"comp.update",compId:f.comp.id,changes:{duration:1}},{type:"keyframe.set",locator:loc,time:4,value:10}],
        [{type:"keyframe.set",locator:loc,time:1,value:10},{type:"property.set",locator:loc,value:10}],
        [{type:"comp.create",ref:"a",name:"A",width:64,height:64,pixelAspect:1,duration:2,frameRate:25},{type:"layer.create",compId:{$ref:"a"},kind:"precomp",name:"Nested",sourceId:f.comp.id},{type:"layer.create",compId:f.comp.id,kind:"precomp",name:"Cycle",sourceId:{$ref:"a"}}]
    ]) assert.ok(f.call("preflight",{actions}).error,JSON.stringify(actions));
    assert.equal(f.begins,0);assert.equal(f.comp.duration,5);assert.equal(f.comp.numLayers,1);
});
test("same-name effects swapped after inspection are rejected by revision and catalog changes stale plans",()=>{
    const f=fixture();
    f.lyr.effects.addProperty("ADBE Slider Control");f.lyr.effects.addProperty("ADBE Slider Control");
    const effect=f.call("inspect").result.items[0].layers[0].properties[0].properties[0];
    f.lyr.effects.children.reverse();f.project.revision++;
    assert.equal(f.call("preflight",{actions:[{type:"effect.enable",locator:effect.locator,enabled:false}]}).error.code,"stale_locator");
    const actions=f.plan([{type:"effect.add",compId:f.comp.id,layerId:f.lyr.id,matchName:"ADBE Slider Control"}]);
    f.app.effects[0].version="2";
    assert.equal(f.call("execute",{actions}).error.code,"stale_plan");
});
test("execution reacquires and validates properties after each action while allowing host revision increments",()=>{
    const f=fixture(),loc=f.locator(),p=f.lyr.transform.property(1),set=p.setValueAtTime.bind(p);
    p.setValueAtTime=(time,value)=>{set(time,value);f.project.revision++;};
    assert.ok(f.run([{type:"keyframe.set",locator:loc,time:0,value:0},{type:"keyframe.set",locator:loc,time:2,value:100}]).result);
    assert.equal(p.numKeys,2);assert.equal(f.begins,1);assert.equal(f.ends,1);
});
test("native layer creation families, deletion and explicit reordering use collection APIs",()=>{
    const f=fixture();
    const sourceId=f.run([{type:"comp.create",name:"Source",width:64,height:64,pixelAspect:1,duration:2,frameRate:25}]).result.results[0].id;
    for(const kind of ["text","shape","solid","camera","light","nu"+"ll","precomp"]){
        const action={type:"layer.create",compId:f.comp.id,kind,name:"Created"};
        if(kind==="solid")Object.assign(action,{color:[.1,.2,.3],width:64,height:64,pixelAspect:1});
        if(kind==="precomp")action.sourceId=sourceId;
        const result=f.run([action]);assert.ok(result.result,JSON.stringify(result));
        const layerId=result.result.results[0].id;
        assert.ok(f.run([{type:"layer.reorder",compId:f.comp.id,layerId,beforeLayerId:null}]).result);
        assert.equal(f.comp.list.at(-1).id,layerId);
        assert.ok(f.run([{type:"layer.delete",compId:f.comp.id,layerId}]).result);
    }
    assert.equal(f.comp.numLayers,1);
});
test("live effects add/enable/reorder/remove and expression errors preserve explicit failure state",()=>{
    const f=fixture();
    assert.ok(f.run([{type:"effect.add",compId:f.comp.id,layerId:f.lyr.id,matchName:"ADBE Slider Control"}]).result);
    const fx=f.lyr.effects.property(1);
    fx.moveTo=index=>{fx.moved=index;};fx.remove=()=>f.lyr.effects.children.splice(0,1);
    function locator(){return f.call("inspect").result.items[0].layers[0].properties[0].properties[0].locator;}
    assert.ok(f.run([{type:"effect.enable",locator:locator(),enabled:false}]).result);assert.equal(fx.enabled,false);
    assert.equal(f.call("preflight",{actions:[{type:"effect.reorder",locator:locator(),index:1}]}).error.code,"disabled_effect");
    assert.ok(f.run([{type:"effect.enable",locator:locator(),enabled:true}]).result);assert.equal(fx.enabled,true);
    assert.ok(f.run([{type:"effect.reorder",locator:locator(),index:1}]).result);assert.equal(fx.moved,1);
    assert.ok(f.run([{type:"effect.remove",locator:locator()}]).result);assert.equal(f.lyr.effects.numProperties,0);
    const p=f.lyr.transform.property(1),loc=f.locator();
    Object.defineProperty(p,"expression",{get(){return "";},set(){p.expressionError="Syntax error";}});
    const result=f.run([{type:"expression.set",locator:loc,source:"bad(",enabled:true}]);
    assert.equal(result.result.status,"stopped");assert.equal(result.result.failure.code,"expression_error");
    assert.equal(f.call("status").result.uncertain,false);
});
test("panel pins project identity through evalScript and refuses a switch before a write",async()=>{
    const f=fixture(),expected=f.call("status").result.project;
    const host=new transport.HostRPC({evalScript(code,cb){
        f.project.file.fsName="C:/Project/switched.aep";
        cb(vm.runInContext(code,f.context));
    }},1000);
    await assert.rejects(host.call("raw",{source:"app.project.revision = 999"},expected),{code:"stale_project"});
    assert.equal(f.project.revision,1);assert.equal(f.begins,0);
});
test("manual restore host close requires exact owner, saved snapshot, clean state and verified backup", t => {
    for(const mode of ["success","owner","snapshot","dirty","unknown","proof","mode","callback","close_refused","open_edit"]){
        const base=process.platform==="win32" ? path.join(os.tmpdir(),"opencode") : os.tmpdir();
        const dir=mkdtempSync(path.join(base,"cm-manual-host-"));
        t.after(()=>rmSync(dir,{recursive:true,force:true}));
        const canonical=path.join(dir,"original.aep"),h=hostDouble(canonical);
        h.props[0].setValue(42);
        const transaction={id:"restore",sessionID:"session",bindingID:"binding"};
        const saved=h.call("execute",{phase:"restore_prepare",transaction,recoveryId:"restore",
            expected:h.call("inspect").result,path:path.join(dir,"emergency.aep")});
        assert.ok(saved.result,JSON.stringify(saved));
        assert.equal(saved.result.status,"recovery_saved");
        const finish={phase:"restore_finish",transaction,recoveryId:"restore",expected:saved.result.snapshot,
            path:canonical,verifiedCheckpoint:{id:"backup",hash:"a".repeat(64),size:100}};
        if(mode==="owner")finish.transaction={...transaction,sessionID:"other"};
        if(mode==="snapshot")h.props[0].setValue(19);
        if(mode==="dirty")h.project.dirty=true;
        if(mode==="unknown")delete h.project.dirty;
        if(mode==="proof")finish.verifiedCheckpoint.hash="not-verified";
        if(mode==="mode"){finish.phase="recovery_finish";delete finish.path;}
        if(mode==="callback")h.app.onError="artistCallback";
        if(mode==="close_refused")h.project.close=()=>false;
        if(mode==="open_edit"){
            const open=h.app.open.bind(h.app);
            h.app.open=file=>{const result=open(file);h.props[0].setValue(19);return result;};
        }
        const result=h.call("execute",finish);
        if(mode==="success"){
            assert.equal(result.result.status,"recovered");
            assert.equal(h.closes,1);
            assert.equal(h.project.file.fsName,canonical);
            assert.equal(h.props[0].value,100);
            assert.ok(h.call("execute",finish).error,"finish cannot replay");
        }else{
            assert.equal(result.error.code,"uncertain_outcome",mode);
            assert.equal(h.closes,mode==="open_edit" ? 1 : 0,mode);
            assert.equal(h.props[0].value,mode==="snapshot" || mode==="open_edit" ? 19 : 42);
            assert.equal(h.call("status").result.uncertain,true);
        }
    }
});

test("dirty or unknown project state refuses open without discarding changes",()=>{
    const f=fixture();
    for(const dirty of [true,undefined]){f.project.dirty=dirty;assert.equal(f.call("open",{path:"C:/Project/recovery.aep"}).error.code,"unsafe_state");}
    assert.equal(f.project.file.fsName,"C:/Project/demo.aep");
});
test("actual ES3 host loads; strict parser rejects executable, duplicate, trailing and prototype input",()=>{
    const f=fixture();
    assert.ok(f.call("inspect").result);
    for(const raw of ['{"method":"inspect","params":{},"method":"raw"}','{"method":"inspect","params":{}};evil()','{"method":"inspect","params":{"__proto__":{}}}','{"method":"inspect","params":}']){
        assert.equal(JSON.parse(f.context.CookieMonsterAE.dispatch(raw)).error.code,"invalid_payload");
    }
});
test("project identity is stable on save/open, changes on Save As, unsaved projects cannot write",()=>{
    const f=fixture(),before=f.call("inspect").result.project;
    assert.deepEqual(f.call("save").result.project,before);
    assert.deepEqual(f.call("open",{path:"C:/Project/demo.aep"}).result.project,before);
    f.project.file.fsName="C:/Project/other.aep";assert.notEqual(f.call("inspect").result.project.id,before.id);
    f.project.file=null;assert.equal(f.call("preflight",{actions:[{type:"comp.delete",compId:f.comp.id}]}).error.code,"unsaved_project");
    assert.equal(f.call("inspect").result.project.saved,false);
});
test("snapshot has named properties, persistent IDs, values, keys and expressions; manual edits invalidate immutable plan",()=>{
    const f=fixture(),loc=f.locator(),p=f.lyr.transform.property(1);
    assert.equal(loc.layerId,f.lyr.id);assert.equal(loc.path[0].index,0);
    const actions=f.plan([{type:"property.set",locator:loc,value:40}]),fp=f.call("inspect").result.fingerprint;
    p.value=41;
    assert.notEqual(f.call("inspect").result.fingerprint,fp);
    assert.equal(f.call("execute",{actions}).error.code,"stale_plan");assert.equal(f.begins,0);
});
test("strict validation rejects bad dimensions, unknown fields, forward refs and unsupported capabilities before undo",()=>{
    const f=fixture();
    for(const actions of [
        [{type:"comp.create",name:"x",width:0,height:1080,pixelAspect:1,duration:1,frameRate:25}],
        [{type:"property.set",locator:f.locator(),value:[1,2]}],
        [{type:"layer.create",compId:f.comp.id,kind:"text",name:"x",bogus:1}],
        [{type:"layer.create",compId:{$ref:"later"},kind:"text",name:"x"}],
        [{type:"comp.reorder",compId:f.comp.id}]
    ]) assert.ok(f.call("preflight",{actions}).error);
    assert.equal(f.begins,0);f.app.version="27.0";assert.equal(f.call("inspect").error.code,"incompatible");
});
test("construct native comp and text/null layers using ordered local refs in a single undo group",()=>{
    const f=fixture(),r=f.run([
        {type:"comp.create",ref:"scene",name:"Scene",width:640,height:480,pixelAspect:1,duration:2,frameRate:25},
        {type:"layer.create",ref:"title",compId:{$ref:"scene"},kind:"text",name:"Title",text:"Hello",position:[30,40]},
        {type:"layer.update",compId:{$ref:"scene"},layerId:{$ref:"title"},changes:{name:"Updated"}},
        {type:"layer.create",compId:{$ref:"scene"},kind:"nu"+"ll",name:"Control"}
    ]);
    assert.ok(r.result,JSON.stringify(r));assert.equal(f.begins,1);assert.equal(f.ends,1);assert.equal(f.project.list[1].numLayers,2);
});
test("property writes and animation execute against explicit target, preserve key move metadata",()=>{
    const f=fixture(),loc=f.locator(),p=f.lyr.transform.property(1);
    assert.ok(f.run([{type:"property.set",locator:loc,value:22}]).result);assert.equal(p.value,22);
    assert.ok(f.run([{type:"keyframe.set",locator:loc,time:0,value:0},{type:"keyframe.set",locator:loc,time:2,value:100}]).result);
    assert.ok(f.run([{type:"keyframe.move",locator:loc,time:2,toTime:3}]).result);assert.equal(p.keyTime(2),3);
    assert.ok(f.run([{type:"keyframe.interpolation",locator:loc,time:3,inType:"bezier",outType:"hold",inEase:[{speed:0,influence:33}],outEase:[{speed:0,influence:33}]}]).result);
    assert.ok(f.run([{type:"keyframe.delete",locator:loc,time:3}]).result);assert.equal(p.numKeys,1);
});
test("missing effects are reported and preserved; renamed/reordered property locators are rejected",()=>{
    const f=fixture(),e=f.lyr.effects.addProperty("Missing Plugin");
    const snapshot=f.call("inspect").result;assert.equal(snapshot.items[0].layers[0].properties[0].properties[0].missing,true);
    assert.equal(f.call("preflight",{actions:[{type:"layer.delete",compId:f.comp.id,layerId:f.lyr.id}]}).error.code,"missing_effect");
    const loc=f.locator();f.lyr.transform.property(1).name="Renamed";
    assert.equal(f.call("preflight",{actions:[{type:"property.set",locator:loc,value:1}]}).error.code,"stale_locator");
    assert.equal(f.lyr.effects.numProperties,1);assert.equal(e.enabled,true);
});
test("acknowledged native exception closes undo group and restricts writes to verified recovery",()=>{
    const f=fixture(),loc=f.locator(),actions=f.plan([{type:"property.set",locator:loc,value:2}]);
    f.lyr.transform.property(1).setValue=()=>{throw new Error("Plugin failure");};
    assert.equal(f.call("execute",{actions}).result.status,"stopped");assert.equal(f.ends,1);
    assert.equal(f.call("preflight",{actions}).error.code,"unsafe_state");
});
test("template discovery preserves inert queue history and removes only its probe even on read failure",()=>{
    for(const fault of [,"renderSettings","outputModule","outputModules"]){
        const f=fixture();let writes=0,removed=0,added=0;
        const untouched=()=>{writes++;throw Error("Existing queue entry must remain untouched");};
        const prior=["DONE","USER_STOPPED","ERR_STOPPED","NEEDS_OUTPUT","QUEUED","UNQUEUED"].map((status,i)=>{
            const r=f.queue.items.add(f.comp);r.status=f.RQ[status];
            Object.assign(r,{skipFrames:i,timeSpanStart:0.5,timeSpanDuration:2,queueItemNotify:true,elapsedSeconds:12,startTime:new Date(0)});
            const om=r.outputModule(1);om.file=new f.File("C:/Project/history-"+i+".mov");
            om.setSettings=untouched;om.applyTemplate=untouched;
            Object.freeze(om.file);Object.freeze(om.templates);Object.freeze(om);
            r.remove=untouched;r.setSettings=untouched;
            Object.defineProperty(r,"render",{get(){return status==="QUEUED";},set:untouched});
            Object.freeze(r.templates);Object.freeze(r);return r;
        });
        const add=f.queue.items.add;
        f.queue.items.add=c=>{
            added++;const probe=add(c),remove=probe.remove;
            probe.remove=function(){removed++;return remove.call(this);};
            const fail=()=>{throw Error("Probe read failed");};
            if(fault==="renderSettings")Object.defineProperty(probe,"templates",{get:fail});
            if(fault==="outputModule")probe.outputModule=fail;
            if(fault==="outputModules")Object.defineProperty(probe.outputModule(1),"templates",{get:fail});
            return probe;
        };
        f.queue.render=untouched;
        const result=f.call("templates",{compId:f.comp.id});
        if(fault){assert.equal(result.error.code,"host_error");assert.match(result.error.message,/Probe read failed/);}
        else assert.deepEqual(result.result,{renderSettings:["Best Settings"],outputModules:["PNG"]});
        assert.equal(added,1);assert.equal(removed,1);assert.equal(writes,0);
        assert.equal(f.rqItems.length,prior.length);prior.forEach((r,i)=>assert.equal(f.rqItems[i],r));
        assert.deepEqual(prior.map(r=>r.status),["DONE","USER_STOPPED","ERR_STOPPED","NEEDS_OUTPUT","QUEUED","UNQUEUED"].map(s=>f.RQ[s]));
        assert.deepEqual(prior.map(r=>r.render),[false,false,false,false,true,false]);
        assert.equal(f.disk.size,0);
    }
});
test("template discovery rejects rendering, paused, unknown and callback queue states before adding a probe",()=>{
    for(const state of ["RENDERING","WILL_CONTINUE","UNKNOWN","missing","rendering","unknownRendering","itemCallback","appCallback"]){
        const f=fixture(),r=f.queue.items.add(f.comp);r.status=f.RQ.DONE;
        if(state==="RENDERING" || state==="WILL_CONTINUE")r.status=f.RQ[state];
        if(state==="UNKNOWN")r.status=999;
        if(state==="missing")r.status=undefined;
        if(state==="rendering")f.queue.rendering=true;
        if(state==="unknownRendering")f.queue.rendering=undefined;
        if(state==="itemCallback")r.onStatusChanged="artistCallback";
        if(state==="appCallback")f.app.onError="artistError";
        let added=0;f.queue.items.add=()=>{added++;throw Error("Must not probe");};
        const result=f.call("templates",{compId:f.comp.id});
        assert.equal(result.error.code,state==="rendering" ? "busy" : "unsafe_state",state);
        assert.equal(added,0);assert.equal(f.rqItems.length,1);assert.equal(f.rqItems[0],r);
    }
});
test("capture refuses unqualified preview/modal safety even after explicit idle assertion without touching queue",()=>{
    const f=fixture(),params={compId:f.comp.id,time:0,alpha:true};
    assert.equal(f.call("capture",params).error.code,"unsafe_state");
    const prior=f.queue.items.add(f.comp);f.call("confirmIdle");
    assert.equal(f.call("confirmIdle").error.code,"unsafe_state");
    const result=f.call("capture",params);assert.equal(result.error.code,"unsafe_state");assert.equal(prior.render,true);assert.equal(f.rqItems.length,1);
    assert.equal(f.disk.size,0);
    f.queue.render=()=>{throw new Error("Render failed");};f.disk.clear();f.call("confirmIdle");
    assert.ok(f.call("capture",params).error);assert.equal(prior.render,true);assert.equal(f.rqItems.length,1);assert.equal(f.disk.size,0);
    prior.status=f.RQ.DONE;f.call("confirmIdle");assert.equal(f.call("capture",params).error.code,"unsafe_state");
});
test("preference is read-only and disabled files leave inspection available; oversized snapshot refuses",()=>{
    const f=fixture();f.app.preferences.getPrefAsLong=()=>0;
    assert.equal(f.call("inspect").result.capabilities.fileNetwork,false);assert.equal(f.call("save").error.code,"preference_disabled");
    f.comp.name="x".repeat(4*1024*1024);assert.equal(f.call("inspect").error.code,"response_too_large");
});
