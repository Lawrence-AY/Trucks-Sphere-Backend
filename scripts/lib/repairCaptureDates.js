const { createHash } = require('node:crypto');
const { captureTime } = require('../../src/integrations/access-bridge/processor');
const { normalizeCaptureDates } = require('../../src/integrations/access-bridge/captureDates');
const plate = value => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
const key = (source,row,at) => createHash('sha256').update(JSON.stringify([source,plate(row.PLAKA),at])).digest('hex');
function planDates(state, offset = '+03:00') {
  const changes = new Map(), repairs = new Map(), issues = [];
  const add = (collection, row, patch) => {
    const path = collection + '/' + row.id;
    const previous = changes.get(path);
    changes.set(path, { collection, id:row.id, before:row, patch:{ ...previous?.patch,...patch } });
  };
  for (const [collection, events] of Object.entries(state)) {
    if (!collection.endsWith('/events')) continue;
    for (const event of events) {
      if (!['KAYITLAR','ICERIDEKI_ARACLAR'].includes(event.table_name)) continue;
      const row = JSON.parse(event.payload);
      const fixed = normalizeCaptureDates(row,event.observed_utc,offset);
      if (row.TARIH1 === fixed.TARIH1 && row.TARIH2 === fixed.TARIH2) continue;
      const oldFirst = captureTime(row,1,offset), first = captureTime(fixed,1,offset);
      const complete = Number(row.TARTIM2) > 0;
      const oldSecond = complete ? captureTime(row,2,offset) : null;
      const second = complete ? captureTime(fixed,2,offset) : null;
      if (second && second < first) { issues.push({event:event.id,reason:'CHRONOLOGY_STILL_INVALID'}); continue; }
      const source = event.source_id || collection.split('/')[1];
      const oldKey = key(source,row,oldFirst), newKey = key(source,fixed,first);
      const jobs = (state.deliveryOrders || []).filter(job => job.accessBridgeKey === oldKey
        || (job.id === event.jobId && job.accessBridgeSource === source && plate(job.plateNumber) === plate(row.PLAKA)));
      if (jobs.length > 1) throw Error('Ambiguous capture: ' + event.id);
      for (const job of jobs) {
        if (job.siteWeighInAt !== oldFirst && job.siteWeighInAt !== first) throw Error('Saved weigh-in conflicts with source: ' + job.id);
        if (job.siteWeighOutAt && complete && job.siteWeighOutAt !== oldSecond && job.siteWeighOutAt !== second) throw Error('Saved weigh-out conflicts with source: ' + job.id);
        if ((state.deliveryOrders || []).some(other => other.id !== job.id && other.accessBridgeKey === newKey)) throw Error('Corrected capture already exists: ' + job.id);
        const replacements = new Map([[oldFirst,first], ...(oldSecond ? [[oldSecond,second]] : [])].filter(([a,b]) => a !== b));
        const previous = repairs.get(job.id);
        if (previous && previous.newKey !== newKey) throw Error('Conflicting event corrections: ' + job.id);
        repairs.set(job.id,{job,newKey,replacements,oldFirst,first,oldSecond,second});
      }
      const patch = { payload:JSON.stringify(fixed), originalPayload:event.originalPayload || event.payload };
      // Requeue only chronology failures. Other validation and processed states stay intact.
      if (event.status === 'blocked' && event.reason === 'INVALID_CAPTURE_CHRONOLOGY') {
        Object.assign(patch,{status:'pending',reason:null,nextAttemptAt:'1970-01-01T00:00:00.000Z',details:null});
      }
      add(collection,event,patch);
    }
  }
  const replaceTimes = (value,replacements) => {
    if (typeof value === 'string') return replacements.get(value) || value;
    if (Array.isArray(value)) return value.map(item=>replaceTimes(item,replacements));
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceTimes(v,replacements)]));
    return value;
  };
  for (const repair of repairs.values()) {
    const { job,newKey,replacements } = repair;
    const patch = { accessBridgeKey:newKey };
    for (const field of ['siteWeighInAt','siteWeighOutAt','receivedAt','accessCapture','warehouseAcceptedAt']) {
      if (job[field] == null) continue;
      const fixed = replaceTimes(job[field],replacements);
      if (JSON.stringify(fixed) !== JSON.stringify(job[field])) patch[field] = fixed;
    }
    add('deliveryOrders',job,patch);
    for (const [collection,rows] of Object.entries(state)) {
      if (collection === 'deliveryOrders' || collection.includes('/')) continue;
      for (const row of rows) {
        if (![row.deliveryOrderId,row.deliveryId,row.jobId,row.receiptNoteId].some(value => value && [job.id,job.jobId,job.receiptNoteId].includes(value))) continue;
        const patch = {};
        for (const [field,value] of Object.entries(row)) {
          if (!/(At|Date)$/.test(field)) continue;
          const fixed = replaceTimes(value,replacements);
          if (JSON.stringify(fixed) !== JSON.stringify(value)) patch[field] = fixed;
        }
        if (Object.keys(patch).length) add(collection,row,patch);
      }
    }
  }
  const unresolved = (state.deliveryOrders || []).filter(job => {
    const observed = job.accessCapture?.observedAt || job.createdAt;
    return observed && [job.siteWeighInAt,job.siteWeighOutAt].some(at => at && at.slice(0,10) > observed.slice(0,10)) && !repairs.has(job.id);
  }).map(job=>job.id);
  return { changes:[...changes.values()].sort((a,b)=>Number(a.collection.includes('/events'))-Number(b.collection.includes('/events'))),
    repairs:[...repairs.values()].map(({job,newKey,oldFirst,first,oldSecond,second})=>({id:job.id,newKey,oldFirst,first,oldSecond,second})),issues,unresolved };
}
module.exports = { planDates };
