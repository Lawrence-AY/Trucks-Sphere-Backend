const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function planCompactFleet(state) {
  const mappings = { drivers:[],vehicles:[] }, map = new Map();
  for (const [collection,prefix] of [['drivers','D'],['vehicles','T']]) {
    const rows=[...(state[collection] || [])];
    if(rows.some(row=>!new RegExp('^'+prefix+'\\d+$','i').test(row.id))) throw Error('Noncanonical ID in '+collection);
    rows.sort((a,b)=>Number(a.id.slice(1))-Number(b.id.slice(1)) || a.id.localeCompare(b.id));
    rows.forEach((row,i)=>{
      const to=prefix+String(i+1).padStart(3,'0');
      mappings[collection].push({from:row.id,to});
      map.set(row.id,to);
    });
  }
  const counters={driver_counter:mappings.drivers.length,truck_counter:mappings.vehicles.length,vehicle_counter:mappings.vehicles.length};
  const rewrite=(value,field='')=>{
    if(typeof value==='string') {
      // Issued trip/receipt identifiers and document links remain permanent.
      if(['jobId','receiptNoteId','deliveryOrderId','deliveryId','originalPayload','payload'].includes(field)) return value;
      if(field==='jobKey') return value.split('/').map(part=>map.get(part)||part).join('/');
      return map.get(value)||value;
    }
    if(Array.isArray(value)) return value.map(item=>rewrite(item,field));
    if(plain(value)) return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item,key)]));
    return value;
  };
  const changes=[], counts={};
  for(const [collection,rows] of Object.entries(state)) {
    if(['numberingMigrations','materialMerges','purchaseOrderMerges'].includes(collection) || collection.endsWith('/snapshots')) continue;
    const desired=new Map(), originals=new Map(rows.map(row=>[row.id,row]));
    for(const row of rows) {
      const id=['drivers','vehicles'].includes(collection)?map.get(row.id):row.id;
      let after={...rewrite(row),id};
      if(collection==='counters' && id==='auto_ids') after={...row,...counters};
      if(desired.has(id)) throw Error('Duplicate target '+collection+'/'+id);
      desired.set(id,after);
    }
    if(collection==='counters' && !desired.has('auto_ids')) desired.set('auto_ids',{id:'auto_ids',...counters});
    for(const [id,after] of desired) if(!same(originals.get(id),after)) changes.push({collection,id,before:originals.get(id)||null,after});
    for(const [id,before] of originals) if(!desired.has(id)) changes.push({collection,id,before,after:null});
    counts[collection]=desired.size;
  }
  if(!state.counters) changes.push({collection:'counters',id:'auto_ids',before:null,after:{id:'auto_ids',...counters}});
  // A reference to a removed driver/truck cannot be inferred from numbering alone.
  const validDriver=new Set((state.drivers||[]).map(row=>row.id)),validTruck=new Set((state.vehicles||[]).map(row=>row.id));
  for(const trip of [...(state.deliveryOrders||[]),...(state.warehouseJobs||[])]) {
    if(trip.driverId && !validDriver.has(trip.driverId)) throw Error('Unknown driver on '+trip.id);
    if((trip.vehicleId||trip.truckId) && !validTruck.has(trip.vehicleId||trip.truckId)) throw Error('Unknown truck on '+trip.id);
  }
  return {mappings,counters,changes,counts};
}
module.exports={planCompactFleet};
