#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
async function main() {
 const args = process.argv.slice(2);
 if (args.some(arg => arg !== '--apply')) throw Error('Usage: node scripts/activate-purchase-orders.js [--apply]');
 require('dotenv').config();
 const {db,admin} = require('../config/firebase');
 try {
  if(process.env.FIREBASE_PROJECT_ID !== 'trucksphere') throw Error('Expected project trucksphere');
  const directory=path.resolve('.po-repair-backups',`po-status-${Date.now()}-${randomUUID()}`);
  const plan = docs => docs.filter(doc=>doc.data().status!=='active').map(doc=>({id:doc.id,before:doc.data()}));
  console.log(`Project trucksphere; database ${db.databaseId || '(default)'}; ${args.includes('--apply')?'APPLY':'DRY RUN'}`);
  let changes;
  if(args.includes('--apply')) changes=await db.runTransaction(async tx=>{
   const snapshot=await tx.get(db.collection('purchaseOrders'));
   const rows=plan(snapshot.docs);
   if(rows.length>450) throw Error('Too many POs for one transaction');
   if(rows.length){
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,`${randomUUID()}.json`),JSON.stringify(rows,null,2),{flag:'wx'});
    for(const row of rows) tx.update(db.collection('purchaseOrders').doc(row.id),{status:'active',updatedAt:new Date().toISOString()});
   }
   return rows;
  });
  else changes=plan((await db.collection('purchaseOrders').get()).docs);
  console.log(JSON.stringify({changes:changes.map(row=>({id:row.id,from:row.before.status,to:'active'})),backup:args.includes('--apply')?directory:null},null,2));
  const final=await db.collection('purchaseOrders').get();
  console.log(JSON.stringify({total:final.size,active:final.docs.filter(doc=>doc.data().status==='active').length,remaining:plan(final.docs).length}));
 }finally{await Promise.all(admin.apps.map(app=>app.delete()));}
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
