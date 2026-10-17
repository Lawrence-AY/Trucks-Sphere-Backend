const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {planCompactFleet}=require('./lib/compactFleetNumbering');
async function main(){
 const args=process.argv.slice(2);
 if(args.some(arg=>arg!=='--apply'))throw Error('Usage: node scripts/compact-fleet-numbering.js [--apply]');
 const {db,admin}=require('../config/firebase');
 try{
  if(process.env.FIREBASE_PROJECT_ID!=='trucksphere')throw Error('Expected project trucksphere');
  const refs=(await db.listCollections()).filter(ref=>!['accessBridgeSources','integrationLocks','refreshTokenSessions'].includes(ref.id));
  for(const source of (await db.collection('accessBridgeSources').get()).docs)refs.push(source.ref.collection('events'));
  const read=async reader=>Object.fromEntries(await Promise.all(refs.map(async ref=>[ref.path,(await reader.get(ref)).docs.map(doc=>({...doc.data(),id:doc.id}))])));
  const state=await read({get:ref=>ref.get()}),plan=planCompactFleet(state);
  console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'dry-run',drivers:plan.mappings.drivers.length,trucks:plan.mappings.vehicles.length,
   counters:plan.counters,writes:plan.changes.length,byCollection:plan.changes.reduce((out,row)=>(out[row.collection]=(out[row.collection]||0)+1,out),{}),
   mappings:Object.fromEntries(Object.entries(plan.mappings).map(([name,rows])=>[name,rows.filter(row=>row.from!==row.to)])),issuedTripAndReceiptNumbersPreserved:true},null,2));
  if(!args.includes('--apply')||!plan.changes.length)return;
  if(plan.changes.length>450)throw Error('Repair exceeds 450-write atomic limit');
  const moved=Object.entries(plan.mappings).flatMap(([collection,rows])=>rows.filter(row=>row.from!==row.to).map(row=>({collection,...row})));
  const children=await Promise.all(moved.map(row=>db.collection(row.collection).doc(row.from).listCollections()));
  if(children.some(rows=>rows.length))throw Error('Entity subcollections require explicit migration');
  const directory=path.resolve('.po-repair-backups','compact-fleet-'+Date.now()+'-'+randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify({state,plan},null,2),{flag:'wx'});
  console.log('Backup: '+directory);
  await db.runTransaction(async tx=>{
   const current=await read(tx),fresh=planCompactFleet(current);
   const shape=value=>JSON.stringify({mappings:value.mappings,targets:value.changes.map(row=>[row.collection,row.id,!!row.after])});
   if(shape(plan)!==shape(fresh))throw Error('Numbering plan changed; rerun repair');
   fs.writeFileSync(path.join(directory,'transaction-'+randomUUID()+'.json'),JSON.stringify({state:current,plan:fresh},null,2),{flag:'wx'});
   for(const row of fresh.changes){
    const ref=db.collection(row.collection).doc(row.id);
    if(row.after)tx.set(ref,row.after);else tx.delete(ref);
   }
  });
  const final=await read({get:ref=>ref.get()}),remaining=planCompactFleet(final);
  const byId=(collection,id)=>final[collection]?.find(row=>row.id===id);
  const map=new Map([...plan.mappings.drivers,...plan.mappings.vehicles].map(row=>[row.from,row.to]));
  for(const old of state.deliveryOrders||[]){
   const row=byId('deliveryOrders',old.id);
   if(!row||row.driverId!==(map.get(old.driverId)||old.driverId)||row.vehicleId!==(map.get(old.vehicleId)||old.vehicleId)||row.jobId!==old.jobId||row.receiptNoteId!==old.receiptNoteId)throw Error('Delivery reference verification failed: '+old.id);
  }
  for(const [collection,rows] of Object.entries(plan.mappings))for(const mapping of rows){
   const old=state[collection].find(row=>row.id===mapping.from),now=byId(collection,mapping.to);
   for(const field of ['name','fullName','plateNumber','registrationNumber','vendorId','vendorIds'])if(JSON.stringify(now?.[field])!==JSON.stringify(old[field]))throw Error('Entity identity verification failed: '+mapping.from);
  }
  for(const collection of ['drivers','vehicles','deliveryOrders','stocks'])if((state[collection]||[]).length!==(final[collection]||[]).length)throw Error('Record count changed: '+collection);
  console.log(JSON.stringify({remainingWrites:remaining.changes.length,drivers:final.drivers.length,trucks:final.vehicles.length,trips:final.deliveryOrders.length,
   counters:final.counters.find(row=>row.id==='auto_ids'),nextDriver:'D'+String(final.drivers.length+1).padStart(3,'0'),nextTruck:'T'+String(final.vehicles.length+1).padStart(3,'0'),deliveryReferencesVerified:true}));
  if(remaining.changes.length)throw Error('Compaction verification failed');
 }finally{await Promise.all(admin.apps.map(app=>app.delete()));}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
