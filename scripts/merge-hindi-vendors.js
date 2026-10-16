#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeName } = require('../src/utils/vendorMatching');
const NAME = 'HINDI GENERAL AGENCIES LIMITED';
const KEEP = 'V001', SOURCE = 'V008';
const ALIASES = ['HINDI GEN AGENCY LIMITED','HINDI GEN AGENCY LTD','HINDI GENERAL AGENCIES LIMITED','HINDI GENERAL AGENCIES LTD'];
const collections = ['vendors','purchaseOrders','deliveryOrders','vehicles','drivers','stocks','stockMovements','warehouseJobs','accessBridgeTickets','users','vendorAliases','vendorUniqueKeys'];
const names = new Set(ALIASES.map(normalizeName));
function patchRecord(value) {
 if (!value || typeof value !== 'object' || value instanceof Date || typeof value.toDate === 'function') return value;
 if (Array.isArray(value)) return value.map(patchRecord);
 const out = {};
 for (const [key, item] of Object.entries(value)) {
  // Source captures and audit evidence retain what the operator actually entered.
  if (['raw','rawPayload','payload','sourceRecord','rawRecord','original','before','metadata'].includes(key)) { out[key] = item; continue; }
  if (['vendorId','vendorNumber','supplierId'].includes(key) && item === SOURCE) out[key] = KEEP;
  else if (key === 'vendorIds' && Array.isArray(item)) out[key] = [...new Set(item.map(id=>id===SOURCE?KEEP:id))].sort();
  else if (['vendorName','supplierName','companyName'].includes(key) && typeof item === 'string' && names.has(normalizeName(item))) out[key] = NAME;
  else out[key] = patchRecord(item);
 }
 return out;
}
function planMerge(state) {
 const keeper = state.vendors.find(v=>v.id===KEEP), source = state.vendors.find(v=>v.id===SOURCE);
 if (!keeper || !names.has(normalizeName(keeper.companyName || keeper.name))) throw Error('Unexpected keeper vendor');
 if (source && !names.has(normalizeName(source.companyName || source.name))) throw Error('Unexpected source vendor');
 if (keeper.userId && source?.userId && keeper.userId !== source.userId) throw Error('Two vendor account owners require review');
 const changes=[];
 for (const collection of collections) for (const row of state[collection] || []) {
  if(collection==='vendors' && row.id===SOURCE) continue;
  let after = patchRecord(row);
  if(collection==='vendors' && row.id===KEEP) {
   if(source) for(const [key,value] of Object.entries(source)) if(!['id','vendorId','createdAt','fleetSize','truckCount','tripCount','name','companyName'].includes(key) && (after[key]==null || after[key]==='')) after[key]=value;
   after={...after,name:NAME,companyName:NAME,vendorName:NAME,vendorId:KEEP,aliases:[...new Set([...(keeper.aliases||[]),...(source?.aliases||[]),...ALIASES])]};
  }
  if(JSON.stringify(after)!==JSON.stringify(row)) changes.push({collection,id:row.id,before:row,after});
 }
 for(const alias of ALIASES){
  const aliasNormalized=normalizeName(alias), id=createHash('sha256').update(aliasNormalized).digest('hex');
  const before=(state.vendorAliases||[]).find(row=>row.id===id);
  if(before && ![KEEP,SOURCE].includes(before.vendorId)) throw Error('Alias belongs to another vendor');
  if(!before || before.vendorId!==KEEP) {
   const existing=changes.find(c=>c.collection==='vendorAliases' && c.id===id);
   if(!existing) changes.push({collection:'vendorAliases',id,before:before||null,after:{...(before||{}),id,vendorId:KEEP,alias,aliasNormalized}});
  }
  const key='company:'+alias.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const previous=(state.vendorUniqueKeys||[]).find(row=>row.id===key);
  if(previous && ![KEEP,SOURCE].includes(previous.vendorId)) throw Error('Company reservation belongs to another vendor');
  if(!previous || previous.vendorId!==KEEP){
   const existing=changes.find(c=>c.collection==='vendorUniqueKeys' && c.id===key);
   if(!existing) changes.push({collection:'vendorUniqueKeys',id:key,before:previous||null,after:{...(previous||{}),id:key,key,vendorId:KEEP}});
  }
 }
 if(source) changes.push({collection:'vendors',id:SOURCE,before:source,after:null});
 return changes;
}
async function readState(reader, db){
 const snapshots=await Promise.all(collections.map(name=>reader.get(db.collection(name))));
 return Object.fromEntries(collections.map((name,i)=>[name,snapshots[i].docs.map(doc=>({...doc.data(),id:doc.id}))]));
}
async function main(){
 const args=process.argv.slice(2);if(args.some(arg=>arg!=='--apply'))throw Error('Usage: node scripts/merge-hindi-vendors.js [--apply]');
 const {db,admin}=require('../config/firebase');
 try{
  if(process.env.FIREBASE_PROJECT_ID!=='trucksphere')throw Error('Expected project trucksphere');
  const directory=path.resolve('.po-repair-backups',`vendor-merge-${Date.now()}-${randomUUID()}`);
  let changes;
  if(args.includes('--apply')) changes=await db.runTransaction(async tx=>{
   const state=await readState(tx,db); const rows=planMerge(state);
   if(rows.length>490)throw Error(`Too many writes: ${rows.length}`);
   if(rows.length){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${randomUUID()}.json`),JSON.stringify({project:'trucksphere',changes:rows},null,2),{flag:'wx'});}
   for(const row of rows){const ref=db.collection(row.collection).doc(row.id);if(row.after)tx.set(ref,row.after);else tx.delete(ref);}
   return rows;
  });else changes=planMerge(await readState({get:ref=>ref.get()},db));
  console.log(JSON.stringify({mode:args.includes('--apply')?'APPLY':'DRY RUN',keeper:KEEP,source:SOURCE,name:NAME,writes:changes.length,byCollection:changes.reduce((out,row)=>(out[row.collection]=(out[row.collection]||0)+1,out),{}),backup:args.includes('--apply')?directory:null},null,2));
  if(args.includes('--apply')){
   const final=await readState({get:ref=>ref.get()},db);
   console.log(JSON.stringify({remainingChanges:planMerge(final).length,vendors:final.vendors.length,trips:final.deliveryOrders.length,hindiTrips:final.deliveryOrders.filter(t=>t.vendorId===KEEP).length,hindiPOs:final.purchaseOrders.filter(po=>po.vendorId===KEEP).map(po=>({id:po.id,status:po.status,vendorName:po.vendorName})),sourceExists:final.vendors.some(v=>v.id===SOURCE)}));
  }
 }finally{await Promise.all(admin.apps.map(app=>app.delete()));}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={planMerge,patchRecord};
