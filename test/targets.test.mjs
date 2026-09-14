import test from "node:test"
import assert from "node:assert/strict"
import {targetPage,resolveReferences,references} from "../src/targets.mjs"
const comp={id:1,kind:"comp",name:"Duplicate",layers:[{id:10,name:"Title",selected:true},{id:11,name:"Title"}]}
const data={projectEpoch:"epoch",revision:1,items:[comp,{id:2,kind:"comp",name:"Duplicate"}],nextCursor:"next"}
test("bounded target pages disambiguate duplicate names by ID and expose selected layers",async()=>{
 const queries=[],workflow={inspectQuery:async(s,q)=>{queries.push(q);return data}}
 const comps=await targetPage(workflow,"s",{search:"duplicate"});assert.deepEqual(comps.targets.map(r=>r.compId),[1,2])
 const layers=await targetPage(workflow,"s",{compId:1,search:"Title",cursor:"page"});assert.deepEqual(layers.targets.map(r=>r.layerId),[10,11]);assert.equal(layers.targets[0].selected,true)
 assert.equal(queries[1].cursor,"page");assert.equal(queries[1].depth,0);assert.equal(layers.nextCursor,"next")
 assert.equal((await targetPage(workflow,"s",{compId:1,search:"11"})).targets[0].layerId,11)
})
test("references reject renamed, deleted and other-project targets before dispatch",async()=>{
 const ref={compId:1,layerId:10,compName:"Duplicate",name:"Title",projectEpoch:"epoch"}
 assert.throws(()=>references(Array(9).fill(ref)),{code:"invalid_target"})
 for(const changed of [{...data,projectEpoch:"other"},{...data,revision:2},{...data,items:[{...comp,layers:[]}]},{...data,items:[{...comp,layers:[{id:10,name:"Renamed"}]}]}]){
  await assert.rejects(resolveReferences({inspectQuery:async()=>changed},"s",[ref],data),{code:"stale_target"})
 }
 assert.deepEqual(await resolveReferences({inspectQuery:async()=>data},"s",[ref],data),[ref])
})
