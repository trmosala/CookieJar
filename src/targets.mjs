import { fail } from "./protocol.mjs"
const id=value=>Number.isSafeInteger(value)&&value>0
const name=value=>typeof value==="string"&&value.length>0&&value.length<=32768
export function references(value){
  if(value===undefined)return []
  if(!Array.isArray(value)||value.length>8)fail("invalid_target","Choose at most eight references")
  return value.map(r=>{
    if(!r||Object.keys(r).sort().join(",")!=="compId,compName,layerId,name,projectEpoch"||!id(r.compId)||!(r.layerId===null||id(r.layerId))||!name(r.name)||!name(r.compName)||!name(r.projectEpoch))fail("invalid_target","Invalid target reference")
    return {...r}
  })
}
export async function targetPage(workflow,sessionID,{compId=null,search="",cursor=null}={}){
  if(!(compId===null||id(compId))||typeof search!=="string"||search.length>256||!(cursor===null||typeof cursor==="string"&&cursor.length<=8192))fail("invalid_target","Invalid target search")
  const result=await workflow.inspectQuery(sessionID,{...(compId===null?{}:{compId}),depth:0,...(cursor?{cursor}:{})})
  if(!name(result.projectEpoch))fail("unsupported_host","Update the AE host to provide project identity")
  const comp=result.items.find(item=>item.id===compId&&item.kind==="comp")
  const rows=compId===null ? result.items.filter(item=>item.kind==="comp").map(c=>({compId:c.id,layerId:null,compName:c.name,name:c.name,projectEpoch:result.projectEpoch})) :
    (comp?.layers||[]).map(l=>({compId,layerId:l.id,compName:comp.name,name:l.name,projectEpoch:result.projectEpoch,selected:!!l.selected}))
  return {targets:rows.filter(row=>`${row.name} ${row.compId} ${row.layerId||""}`.toLowerCase().includes(search.toLowerCase())).slice(0,100),nextCursor:result.nextCursor||null,
    note:"Search applies to this bounded page. Continue to the next page for more matches."}
}
export async function resolveReferences(workflow,sessionID,value,before){
  const refs=references(value)
  for(const ref of refs){
    const data=await workflow.inspectQuery(sessionID,{compId:ref.compId,...(ref.layerId===null?{}:{layerId:ref.layerId}),depth:0})
    const comp=data.items.find(item=>item.id===ref.compId&&item.kind==="comp"),item=ref.layerId===null?comp:comp?.layers?.find(l=>l.id===ref.layerId)
    if(data.projectEpoch!==ref.projectEpoch||data.projectEpoch!==before.projectEpoch||data.revision!==before.revision||comp?.name!==ref.compName||item?.name!==ref.name)
      fail("stale_target","A referenced composition or layer changed. Search and select it again")
  }
  return refs
}
