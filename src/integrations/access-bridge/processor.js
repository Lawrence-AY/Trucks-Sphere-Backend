const { createHash } = require('node:crypto');
const { isActiveJob, normalizeJobStatus } = require('../../utils/jobLifecycle');
const { isWarehouseReceipt } = require('../../modules/warehouse-jobs/receipt');
const normalize = value => String(value ?? '').trim().toUpperCase();
const plate = value => normalize(value).replace(/[\s-]/g, '');
const blocked = code => Object.assign(new Error(code), { code });
const CAPTURE_CLOCK_SKEW_MS = 120000;

function scheduleExistedAtCapture(job, firstAt, observedAt) {
  if (!job.createdAt || Date.parse(job.createdAt) <= Date.parse(firstAt)) return true;
  if (job.siteWeighInAt && Math.abs(Date.parse(job.siteWeighInAt) - Date.parse(firstAt)) <= CAPTURE_CLOCK_SKEW_MS) return true;
  // Access retains the form's entered time. Allow a small clock/form-time
  // difference only when the server had already seen this scheduled job by
  // upload time. Historical captures must not attach to a later trip.
  return isActiveJob(job.status)
    && job.siteWeighInWeight == null
    && Date.parse(job.createdAt) - Date.parse(firstAt) <= CAPTURE_CLOCK_SKEW_MS
    && Date.parse(job.createdAt) <= Date.parse(observedAt);
}

function captureTime(row, index, offset) {
  const date = String(row[`TARIH${index}`] || '').slice(0, 10);
  const time = String(row[`SAAT${index}`] || '').match(/^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}:\d{2}:\d{2})/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) throw blocked('CAPTURE_TIME_REQUIRED');
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || date === '1899-12-30'
    || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time[1])) throw blocked('INVALID_CAPTURE_TIME');
  const value = new Date(`${date}T${time[1]}${offset}`);
  if (!Number.isFinite(value.getTime())) throw blocked('INVALID_CAPTURE_TIME');
  return value.toISOString();
}

function captureIdentity(row, config) {
  const firstAt = captureTime(row, 1, config.utcOffset);
  const key = createHash('sha256').update(JSON.stringify([config.sourceId, plate(row.PLAKA), firstAt])).digest('hex');
  return { key, firstAt };
}

function capture(row, config, weightUnit) {
  const { key, firstAt } = captureIdentity(row, config);
  if (!['kg', 'tonnes'].includes(String(weightUnit || '').toLowerCase())) throw blocked('WEIGHT_UNIT_REQUIRED');
  const divisor = String(weightUnit).toLowerCase() === 'kg' ? 1000 : 1;
  const first = Number(row.TARTIM1) / divisor;
  const second = row.TARTIM2 == null || row.TARTIM2 === '' || Number(row.TARTIM2) === 0 ? null : Number(row.TARTIM2) / divisor;
  if (!plate(row.PLAKA) || !Number.isFinite(first) || first <= 0 || (second !== null && (!Number.isFinite(second) || second <= 0 || second >= first))) throw blocked('INVALID_SITE_WEIGHT');
  const secondAt = second === null ? null : captureTime(row, 2, config.utcOffset);
  if (secondAt && Date.parse(secondAt) < Date.parse(firstAt)) throw blocked('INVALID_CAPTURE_CHRONOLOGY');
  return { key, first, second, firstAt, secondAt };
}

function unique(items, code) {
  if (items.length > 1) throw blocked(code);
  return items[0];
}

function matchesContext(job, row, config) {
  const reference = normalize(row[config.poField || 'DIGER5_ISIM']);
  if (reference && ![job.id, job.jobId, job.purchaseOrderId, job.poNumber].some(v => normalize(v) === reference)) return false;
  const checks = [
    [row[config.driverField || 'DIGER3_ISIM'], [job.driverId, job.driverName, job.licenseNumber]],
    [row.FIRMA_ADI, [job.vendorId, job.vendorName, job.companyName]],
    [row.DIGER1_ISIM, [job.materialSource, job.quarryLocation, job.quarryName]],
    [row.DIGER2_ISIM, [job.siteId, job.siteName]],
    [row.MALZEME_KODU, [job.materialId]],
    [row.MALZEME_ADI, [job.materialName]],
  ];
  return checks.every(([value, expected]) => !normalize(value)
    || !expected.some(v => normalize(v))
    || expected.some(v => normalize(v) === normalize(value)));
}

function isSiteSchedule(job) {
  return isActiveJob(job.status) && (job.weighInWeight != null && job.weighOutWeight != null
    || ['DISPATCHED', 'IN_TRANSIT', 'ARRIVED_AT_SITE', 'SITE_WEIGHED_IN'].includes(normalizeJobStatus(job.status)));
}

function customOrder(orders, row, config) {
  const reference = normalize(row[config.poField || 'DIGER5_ISIM']);
  const matches = orders.filter(order => {
    if (reference && ![order.id, order.poNumber].some(value => normalize(value) === reference)) return false;
    const checks = [
      [row.DIGER2_ISIM, [order.siteId, order.siteName]],
      [row.MALZEME_KODU, [order.materialId]],
      [row.MALZEME_ADI, [order.materialName]],
      [row.FIRMA_ADI, [order.vendorId, order.vendorName, order.companyName]],
    ];
    if (!reference && (!normalize(row.DIGER2_ISIM) || !(normalize(row.MALZEME_KODU) || normalize(row.MALZEME_ADI)))) return false;
    return checks.every(([value, expected]) => !normalize(value) || expected.some(v => normalize(v) === normalize(value)));
  });
  const closed = new Set(['COMPLETED', 'COMPLETE', 'DELIVERED', 'FULFILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'ARCHIVED', 'EXCESS', 'OVERDELIVERED', 'OVER_DELIVERED']);
  const order = unique(matches.filter(order => !closed.has(normalize(order.status))), 'AMBIGUOUS_PURCHASE_ORDER');
  if (!order) throw blocked(matches.length ? 'PURCHASE_ORDER_CLOSED' : 'PURCHASE_ORDER_REQUIRED');
  if (!order.poNumber || !order.vendorId) throw blocked('PURCHASE_ORDER_REFERENCES_REQUIRED');
  return order;
}

// Repository injection keeps matching testable without contacting production Firebase.
function createProcessor({ repository, deliveries, config }) {
  return async event => {
    if (['LEFT_WAITING', 'NO_LONGER_PRESENT'].includes(event.event_type) || (event.event_type === 'BASELINE' && event.table_name !== 'ICERIDEKI_ARACLAR')) return { status: 'ignored', reason: event.event_type };
    const row = JSON.parse(event.payload);
    const identity = captureIdentity(row, config);
    const vehicles = await repository.all('vehicles');
    const vehicle = unique(vehicles.filter(v => plate(v.registrationNumber || v.plateNumber) === plate(row.PLAKA)), 'AMBIGUOUS_TRUCK');
    if (!vehicle) throw blocked('UNKNOWN_TRUCK');
    const drivers = await repository.all('drivers');
    const driverValue = normalize(row[config.driverField || 'DIGER3_ISIM']);
    const capturedDriver = driverValue ? unique(drivers.filter(d =>
      [d.id, d.nationalId, d.licenseNumber, d.name, d.fullName].some(v => normalize(v) === driverValue)), 'AMBIGUOUS_DRIVER') : null;
    const jobs = await repository.all('deliveryOrders');
    const orders = await repository.all('purchaseOrders');
    const orderFor = job => orders.find(order => (job.purchaseOrderId && order.id === job.purchaseOrderId)
      || (job.poNumber && normalize(order.poNumber) === normalize(job.poNumber)));
    const contextMatches = job => matchesContext({ ...job, poNumber: job.poNumber || orderFor(job)?.poNumber },
      capturedDriver && capturedDriver.id === job.driverId
        ? { ...row, [config.driverField || 'DIGER3_ISIM']: job.driverId } : row, config);
    let job = unique(jobs.filter(j => j.accessBridgeKey === identity.key), 'DUPLICATE_CAPTURE');
    if (!job) {
      const candidates = jobs.filter(j => (isSiteSchedule(j) || (j.siteWeighInAt && Math.abs(Date.parse(j.siteWeighInAt) - Date.parse(identity.firstAt)) <= CAPTURE_CLOCK_SKEW_MS))
        && (plate(j.plateNumber) ? plate(j.plateNumber) === plate(row.PLAKA) : vehicle && j.vehicleId === vehicle.id)
        && scheduleExistedAtCapture(j, identity.firstAt, event.observed_utc));
      const contextual = candidates.length > 1 ? candidates.filter(contextMatches) : candidates;
      if (candidates.length && !contextual.length) throw blocked('SCHEDULE_CONTEXT_MISMATCH');
      job = unique(contextual, 'AMBIGUOUS_SCHEDULE');
    }
    let newOrder;
    if (!job) {
      // A different trip for a busy truck must never become a second custom job.
      if (jobs.some(j => isActiveJob(j.status) && (j.vehicleId === vehicle.id || plate(j.plateNumber) === plate(row.PLAKA)))) throw blocked('UNMATCHED_SCHEDULE');
      if (!capturedDriver) throw blocked('REGISTERED_DRIVER_REQUIRED');
      if (jobs.some(j => isActiveJob(j.status) && j.driverId === capturedDriver.id)) throw blocked('ACTIVE_JOB_RESOURCE_CONFLICT');
      newOrder = customOrder(orders, row, config);
      job = {
        purchaseOrderId: newOrder.id, poNumber: newOrder.poNumber,
        vendorId: newOrder.vendorId, vendorName: newOrder.vendorName || '', companyName: newOrder.companyName || newOrder.vendorName || '',
        driverId: capturedDriver.id, driverName: capturedDriver.name || capturedDriver.fullName || '',
        vehicleId: vehicle.id, plateNumber: vehicle.registrationNumber || vehicle.plateNumber,
        siteId: newOrder.siteId || '', siteName: newOrder.siteName || '',
        materialId: newOrder.materialId || '', materialName: newOrder.materialName || '',
        materialSource: String(row.DIGER1_ISIM || newOrder.materialSource || newOrder.quarryName || ''),
        quarryId: newOrder.quarryId || '', quarryName: newOrder.quarryName || '',
        unit: newOrder.unit || '', quantityOrdered: Number(newOrder.quantity || 0), quantityDelivered: 0,
        storageLot: newOrder.storageLot || '', banker: newOrder.banker || '',
        isUnscheduled: true, status: 'DISPATCHED', createdBy: 'access_bridge',
      };
      // Warehouse dispatches require their existing shipment/product references.
      if (isWarehouseReceipt(newOrder) || normalize(job.materialSource) === 'WAREHOUSE') throw blocked('WAREHOUSE_SHIPMENT_REQUIRED');
    }
    if ((plate(job.plateNumber) && plate(job.plateNumber) !== plate(row.PLAKA))
      || (job.vehicleId && job.vehicleId !== vehicle.id)
      || (job.accessCapture?.plateNumber && plate(job.accessCapture.plateNumber) !== plate(row.PLAKA))) throw blocked('CAPTURE_PLATE_MISMATCH');
    if (capturedDriver && job.driverId && capturedDriver.id !== job.driverId) throw blocked('SCHEDULE_DRIVER_MISMATCH');
    // Registered identifiers (including national ID) confirm the same driver.
    if (!contextMatches(job)) throw blocked('SCHEDULE_CONTEXT_MISMATCH');
    const po = orderFor(job);
    const siteId = job.siteId || po?.siteId || '';
    if (newOrder && !siteId) throw blocked('SITE_REQUIRED');
    if (!siteId && !(job && config.sourceWeightUnit)) throw blocked('SITE_REQUIRED');
    const site = (await repository.all('sites')).find(s => s.id === siteId);
    if (siteId && !site) throw blocked('UNKNOWN_SITE');
    const weights = capture(row, config, config.sourceWeightUnit || site?.weighbridgeWeightUnit);
    if (newOrder) {
      // Store identity on creation, so a failed first weighing can safely retry.
      const basePo = String(newOrder.poNumber).split('/')[0];
      job = await deliveries.create({ ...job,
        jobKey: `${basePo}/${newOrder.vendorId}/${capturedDriver.id}/${vehicle.id}`,
        accessBridgeKey: weights.key, accessBridgeSource: config.sourceId,
      });
    }
    if (job?.accessBridgeKey && job.accessBridgeKey !== weights.key) throw blocked('JOB_ALREADY_BOUND');
    // Save the cross-table identity before weighing. Recovery can find this job
    // even if the process dies between a job write and acknowledging the event.
    if (!job.accessBridgeKey) {
      if (job.siteWeighInWeight != null && Math.abs(Number(job.siteWeighInWeight) - weights.first) > 0.000001) throw blocked('APP_WEIGHT_CONFLICT');
      job = await repository.bind(job.id, weights.key, config.sourceId, siteId);
    } else if (job.accessBridgeKey !== weights.key) throw blocked('JOB_ALREADY_BOUND');
    if (job.siteWeighInWeight != null && Math.abs(Number(job.siteWeighInWeight) - weights.first) > 0.000001) throw blocked('FIRST_WEIGHT_CHANGED');
    if (job.siteWeighOutWeight != null) {
      if (weights.second !== null && Math.abs(Number(job.siteWeighOutWeight) - weights.second) > 0.000001) throw blocked('SECOND_WEIGHT_CHANGED');
      return { status: 'processed', jobId: job.id, receiptNoteId: job.receiptNoteId || null };
    }
    if (!isActiveJob(job.status)) throw blocked('JOB_CLOSED');
    const actor = String(row.OPERATOR_ADI || 'Access weighbridge');
    if (job.siteWeighInWeight == null) job = await deliveries.updateFresh(job.id, {
      siteWeighInWeight: weights.first, siteWeighInAt: weights.firstAt, siteWeighInByName: actor,
      accessCapture: { plateNumber: plate(row.PLAKA), driverName: String(row[config.driverField || 'DIGER3_ISIM'] || ''),
        company: String(row.FIRMA_ADI || ''), origin: String(row.DIGER1_ISIM || ''), destination: String(row.DIGER2_ISIM || ''),
        material: String(row.MALZEME_ADI || ''), reference: String(row[config.poField || 'DIGER5_ISIM'] || ''),
        explanation: String(row.DIGER4_ISIM || ''), capturedAt: weights.firstAt, observedAt: event.observed_utc || null },
    });
    if (weights.second !== null) {
      const net = weights.first - weights.second;
      job = await deliveries.updateFresh(job.id, {
        siteWeighOutWeight: weights.second, siteWeighOutAt: weights.secondAt, siteNetWeight: net,
        ...(isWarehouseReceipt(job) ? {} : { quantityDelivered: net }),
        receivedAt: weights.secondAt, receivedBy: actor, receivedLocation: job.siteName || '',
        siteWeighOutByName: actor, status: 'SITE_WEIGHED_OUT',
      });
    }
    return { status: 'processed', jobId: job.id, receiptNoteId: job.receiptNoteId || null };
  };
}
module.exports = { createProcessor, capture, captureTime };
