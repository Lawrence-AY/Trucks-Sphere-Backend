const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planDates } = require('./lib/repairCaptureDates');
async function main() {
  const args=process.argv.slice(2);
  if (args.some(arg=>arg!=='--apply')) throw Error('Usage: node scripts/repair-capture-dates.js [--apply]');
  const {db,admin}=require('../config/firebase');
  try {
    if (process.env.FIREBASE_PROJECT_ID!=='trucksphere') throw Error('Expected project trucksphere');
    const refs=(await db.listCollections()).filter(ref=>ref.id!=='accessBridgeSources');
    for (const source of (await db.collection('accessBridgeSources').get()).docs) refs.push(source.ref.collection('events'));
    const read=async()=>Object.fromEntries(await Promise.all(refs.map(async ref=>[ref.path,(await ref.get()).docs.map(doc=>({...doc.data(),id:doc.id}))])));
    const state=await read(), plan=planDates(state);
    console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'dry-run',trips:plan.repairs.length,
      writes:plan.changes.length,byCollection:plan.changes.reduce((out,row)=>(out[row.collection]=(out[row.collection]||0)+1,out),{}),
      issues:plan.issues,unresolved:plan.unresolved,examples:plan.repairs.slice(0,3)},null,2));
    if (!args.includes('--apply') || !plan.changes.length) return;
    if (plan.issues.length || plan.unresolved.length) throw Error('Unresolved dates require review before repair');
    const directory=path.resolve('.po-repair-backups','capture-dates-'+Date.now()+'-'+randomUUID());
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify({state,plan},null,2),{flag:'wx'});
    console.log('Backup: '+directory);
    // Save all repaired jobs and linked stock dates before enabling event retries.
    for (let start=0;start<plan.changes.length;start+=180) {
      const batch=plan.changes.slice(start,start+180);
      await db.runTransaction(async tx=>{
        const docs=await tx.getAll(...batch.map(row=>db.collection(row.collection).doc(row.id)));
        for (let i=0;i<batch.length;i++) {
          const row=batch[i], current=docs[i].data();
          if (!docs[i].exists) throw Error('Record disappeared: '+row.id);
          for (const field of Object.keys(row.patch)) {
            if (field === 'nextAttemptAt' && current.status === 'blocked' && current.reason === 'INVALID_CAPTURE_CHRONOLOGY') continue;
            if (JSON.stringify(current[field])!==JSON.stringify(row.before[field]) && JSON.stringify(current[field])!==JSON.stringify(row.patch[field])) throw Error('Repair field changed: '+row.id+'/'+field);
          }
        }
        for (let i=0;i<batch.length;i++) tx.update(docs[i].ref,batch[i].patch);
      });
      console.log('Updated '+Math.min(start+180,plan.changes.length)+'/'+plan.changes.length);
    }
    const final=await read(), remaining=planDates(final);
    for (const change of plan.changes.filter(row=>!row.collection.includes('/events'))) {
      const actual=final[change.collection].find(row=>row.id===change.id);
      for (const [field,value] of Object.entries(change.patch)) if (JSON.stringify(actual?.[field])!==JSON.stringify(value)) throw Error('Saved repair verification failed: '+change.id+'/'+field);
    }
    const future=final.deliveryOrders.filter(job=>job.accessBridgeKey && [job.siteWeighInAt,job.siteWeighOutAt].some(at=>at && at.slice(0,10)>'2026-10-17')).length;
    console.log(JSON.stringify({remainingWrites:remaining.changes.length,futureBridgeTrips:future,tripsBefore:state.deliveryOrders.length,tripsAfter:final.deliveryOrders.length,
      stocksBefore:state.stocks?.length,stocksAfter:final.stocks?.length,issues:remaining.issues,unresolved:remaining.unresolved}));
    if (remaining.changes.length || future) throw Error('Date verification incomplete');
  } finally { await Promise.all(admin.apps.map(app=>app.delete())); }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
