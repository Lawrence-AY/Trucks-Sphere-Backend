const { toTonnes } = require('../../utils/deliveryWeightUnits');
const { matchVendor } = require('../../utils/vendorMatching');
const { createHash } = require('node:crypto');
const { isActiveJob, normalizeJobStatus } = require('../../utils/jobLifecycle');
const { isWarehouseReceipt } = require('../../modules/warehouse-jobs/receipt');
const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const plate = value => normalize(value).replace(/[\s-]/g, '');
// "v11", "11" or "V011" → "V011" (matches purchase-orders normalizeVendorId).
const vendorShort = id => {
  const match = String(id ?? '').trim().match(/^[Vv]?(\d+)$/);
  return match ? `V${String(parseInt(match[1], 10)).padStart(3, '0')}` : String(id ?? '');
};
const blocked = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CAPTURE_CLOCK_SKEW_MS = 120000;
// A completed weigh-out is minutes after its weigh-in; allow a full day so the
// exit weigh still finds the job that recorded the entry weigh even when the
// source clock skews or the two rows store slightly different first-weigh times.
const WEIGH_OUT_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

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

// Duplicate driver records (a bridge-created stub plus a manually registered
// profile) share a name but must not stall the whole weighbridge. Prefer the
// most complete record, then a stable id, so unscheduled captures resolve.
function pickDriver(drivers, driverValue) {
  const matches = drivers.filter(d =>
    [d.id, d.nationalId, d.licenseNumber, d.name, d.fullName].some(v => normalize(v) === driverValue));
  if (matches.length <= 1) return matches[0] || null;
  return matches.slice().sort((a, b) => {
    const complete = d => (d.registrationIncomplete ? 0 : 1);
    return complete(b) - complete(a) || String(a.id).localeCompare(String(b.id));
  })[0];
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
  const closed = new Set(['COMPLETED', 'COMPLETE', 'DELIVERED', 'FULFILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'ARCHIVED', 'EXCESS', 'OVERDELIVERED', 'OVER_DELIVERED']);
  const matchesContext = order => {
    const vendor = normalize(row.FIRMA_ADI);
    const material = normalize(row.MALZEME_ADI || row.MALZEME_KODU);
    const vendorMatch = !vendor || [order.vendorId, order.vendorName, order.companyName].some(value => normalize(value) === vendor);
    const materialMatch = !material || [order.materialId, order.materialName, order.materialNumber].some(value => normalize(value) === material);
    const site = normalize(row.DIGER2_ISIM);
    const siteMatch = !site || [order.siteId, order.siteName].some(value => normalize(value) === site);
    return vendorMatch && materialMatch && siteMatch;
  };
  const referenced = reference && orders.filter(order => [order.id, order.poNumber].some(value => normalize(value) === reference));
  // The weighbridge reference is advisory. Vendor + material identifies the
  // commercial PO when Access sends a stale, blank, or differently formatted
  // reference. Only fall back to creating a PO when no existing PO matches.
  const matches = referenced?.length ? referenced.filter(matchesContext) : orders.filter(matchesContext);
  if (!matches.length && reference) {
    // A bad/stale reference must not force a duplicate PO.
    const fallback = orders.filter(matchesContext);
    if (fallback.length) return unique(fallback.filter(order => !closed.has(normalize(order.status))), 'AMBIGUOUS_PURCHASE_ORDER');
  }
  const order = unique(matches.filter(order => !closed.has(normalize(order.status))), 'AMBIGUOUS_PURCHASE_ORDER');
  if (!order) throw blocked(matches.length ? 'PURCHASE_ORDER_CLOSED' : 'PURCHASE_ORDER_REQUIRED');
  if (!order.poNumber || !order.vendorId) throw blocked('PURCHASE_ORDER_REFERENCES_REQUIRED');
  return order;
}

// A custom (unscheduled) capture still needs a truck, driver, vendor, site,
// material and an open purchase order before it can become a delivery order.
// Auto-provision whatever is missing so in-yard trucks flow through without
// manual data entry. IDs use the app's shared sequential counters (V/D/T/PO);
// name matching on retries keeps the flow idempotent without duplicate entities.
async function resolveCustomCapture(repository, row, config, vehicle, capturedDriver) {
  const toCreate = [];
  const now = new Date().toISOString();
  const stableId = (collection, value) => `AB-${hash([config.sourceId, collection, normalize(value)]).slice(0, 24)}`;

  if (!vehicle) {
    vehicle = { id: await repository.nextId('truck'), plateNumber: plate(row.PLAKA), registrationNumber: plate(row.PLAKA), status: 'active', bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId };
    toCreate.push(['vehicles', vehicle.id, vehicle]);
  }

  const vendors = (await repository.all('vendors')) || [];
  const vendorName = String(row.FIRMA_ADI || '').trim() || `Unspecified vendor (${config.sourceId})`;
  const aliases = (await repository.all('vendorAliases')) || [];
  const vendorMatch = matchVendor(vendorName, vendors, { ...(config.vendorMatching || {}), aliases });
  let vendor = vendorMatch.match || null;
  if (!vendor) {
    // Create only when there is no plausible existing vendor. A fuzzy review
    // or ambiguity still requires human confirmation to avoid mis-assignment.
    if (vendorMatch.status !== 'no_match') throw blocked('VENDOR_REVIEW_REQUIRED');
    const vendorId = await repository.nextId('vendor');
    vendor = {
      id: vendorId,
      vendorId,
      companyName: vendorName,
      name: vendorName,
      contactPerson: '',
      phone: '',
      email: '',
      status: 'active',
      fleetSize: 0,
      bridgeCreated: true,
      registrationIncomplete: true,
      createdBy: 'access_bridge',
      sourceId: config.sourceId,
      createdAt: now,
      updatedAt: now,
    };
    toCreate.push(['vendors', vendor.id, vendor]);
  }

  if (!capturedDriver) {
    const name = String(row[config.driverField || 'DIGER3_ISIM'] || '').trim();
    if (!name) throw blocked('DRIVER_NAME_REQUIRED');
    capturedDriver = { id: await repository.nextId('driver'), name, fullName: name, vendorId: vendor.id, status: 'active', registrationIncomplete: true, bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId };
    toCreate.push(['drivers', capturedDriver.id, capturedDriver]);
  }

  const sites = (await repository.all('sites')) || [];
  const siteName = String(row.DIGER2_ISIM || '').trim() || `Unspecified site (${config.sourceId})`;
  let site = sites.find(s => [s.id, s.name, s.siteName].some(n => normalize(n) === normalize(siteName)));
  if (!site) {
    site = { id: stableId('sites', siteName), name: siteName, siteName, weighbridgeWeightUnit: 'kg', bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId };
    toCreate.push(['sites', site.id, site]);
  }

  const materials = (await repository.all('materials')) || [];
  const materialName = String(row.MALZEME_ADI || row.MALZEME_KODU || '').trim() || 'Unspecified material';
  const materialCode = String(row.MALZEME_KODU || '').trim();
  let material = materials.find(m => (materialCode && [m.id, m.code, m.materialCode].some(n => normalize(n) === normalize(materialCode)))
    || [m.name, m.materialName].some(n => normalize(n) === normalize(materialName)));
  if (!material) {
    material = { id: await repository.nextId('material'), name: materialName, materialName, code: materialCode, unit: 'tonnes', bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId };
    toCreate.push(['materials', material.id, material]);
  }

  const orders = (await repository.all('purchaseOrders')) || [];
  let order;
  try { order = customOrder(orders, row, config); }
  catch (error) { if (error.code !== 'PURCHASE_ORDER_REQUIRED' && error.code !== 'PURCHASE_ORDER_CLOSED') throw error; }
  if (!order) {
    const poSeq = await repository.nextId('purchase_order_v2');
    const poNumber = `${poSeq}/${vendorShort(vendor.id)}`;
    const poId = poNumber.replace(/\//g, '-');
    order = { id: poId, poNumber, vendorId: vendor.id, vendorName: vendor.name || vendor.companyName,
      siteId: site.id, siteName: site.name || site.siteName,
      materialId: material.id, materialName: material.name || material.materialName,
      unit: 'tonnes', status: 'open', bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId, createdAt: now };
    toCreate.push(['purchaseOrders', order.id, order]);
  }
  return { vehicle, driver: capturedDriver, order, toCreate };
}

// Repository injection keeps matching testable without contacting production Firebase.
function createProcessor({ repository, deliveries, config }) {
  return async event => {
    if (['LEFT_WAITING', 'NO_LONGER_PRESENT'].includes(event.event_type) || (event.event_type === 'BASELINE' && event.table_name !== 'ICERIDEKI_ARACLAR')) return { status: 'ignored', reason: event.event_type };
    const row = JSON.parse(event.payload);
    const identity = captureIdentity(row, config);
    const vehicles = await repository.all('vehicles');
    let vehicle = unique(vehicles.filter(v => plate(v.registrationNumber || v.plateNumber) === plate(row.PLAKA)), 'AMBIGUOUS_TRUCK');
    const drivers = await repository.all('drivers');
    const driverValue = normalize(row[config.driverField || 'DIGER3_ISIM']);
    let capturedDriver = driverValue ? pickDriver(drivers, driverValue) : null;
    const jobs = (await repository.all('deliveryOrders')).map(toTonnes);
    const orders = await repository.all('purchaseOrders');
    const orderFor = job => orders.find(order => (job.purchaseOrderId && order.id === job.purchaseOrderId)
      || (job.poNumber && normalize(order.poNumber) === normalize(job.poNumber)));
    const contextMatches = job => matchesContext({ ...job, poNumber: job.poNumber || orderFor(job)?.poNumber },
      capturedDriver && capturedDriver.id === job.driverId
        ? { ...row, [config.driverField || 'DIGER3_ISIM']: job.driverId } : row, config);
    // A completed weigh-out must never be gated by schedule/PO/driver matching:
    // the truck physically left, so attach the exit weigh to whichever job
    // already recorded its weigh-in for this plate around the same first-weigh
    // time. Schedule matching stays as non-blocking enrichment for weigh-in only.
    const hasSecondWeigh = row.TARTIM2 != null && row.TARTIM2 !== '' && Number(row.TARTIM2) !== 0;
    if (hasSecondWeigh) {
      const weighOutTargets = jobs.filter(j =>
        plate(j.plateNumber) === plate(row.PLAKA)
        && j.siteWeighInWeight != null && j.siteWeighOutWeight == null
        && j.siteWeighInAt && Math.abs(Date.parse(j.siteWeighInAt) - Date.parse(identity.firstAt)) <= WEIGH_OUT_MATCH_WINDOW_MS);
      if (weighOutTargets.length) {
        const target = weighOutTargets.slice().sort((a, b) =>
          Math.abs(Date.parse(a.siteWeighInAt) - Date.parse(identity.firstAt))
          - Math.abs(Date.parse(b.siteWeighInAt) - Date.parse(identity.firstAt)))[0];
        const targetSiteId = target.siteId || '';
        const allSites = await repository.all('sites');
        const targetSite = allSites.find(s => s.id === targetSiteId);
        const weights = capture(row, config, config.sourceWeightUnit || targetSite?.weighbridgeWeightUnit);
        if (Math.abs(Number(target.siteWeighInWeight) - weights.first) > 0.000001) throw blocked('FIRST_WEIGHT_CHANGED');
        const actor = String(row.OPERATOR_ADI || 'Access weighbridge');
        const net = weights.first - weights.second;
        const updated = await deliveries.updateFresh(target.id, {
          siteWeighOutWeight: weights.second, siteWeighOutAt: weights.secondAt, siteNetWeight: net,
          ...(isWarehouseReceipt(target) ? {} : { quantityDelivered: net }),
          receivedAt: weights.secondAt, receivedBy: actor, receivedLocation: target.siteName || '',
          siteWeighOutByName: actor, status: 'SITE_WEIGHED_OUT',
        });
        return { status: 'processed', jobId: target.id, receiptNoteId: updated.receiptNoteId || null };
      }
    }
    let job = unique(jobs.filter(j => j.accessBridgeKey === identity.key), 'DUPLICATE_CAPTURE');
    if (!job) {
      const candidates = jobs.filter(j => (isSiteSchedule(j) || (j.siteWeighInAt && Math.abs(Date.parse(j.siteWeighInAt) - Date.parse(identity.firstAt)) <= CAPTURE_CLOCK_SKEW_MS))
        && (plate(j.plateNumber) ? plate(j.plateNumber) === plate(row.PLAKA) : vehicle && j.vehicleId === vehicle.id)
        && scheduleExistedAtCapture(j, identity.firstAt, event.observed_utc));
      const contextual = candidates.length > 1 ? candidates.filter(contextMatches) : candidates;
      // A completed two-weigh record is a physically completed trip. If it
      // does not match the context of a same-plate scheduled candidate, do
      // not attach it to that schedule; let it proceed as a custom job.
      // First-weigh records still block on a conflicting scheduled context.
      if (candidates.length && !contextual.length && !hasSecondWeigh) throw blocked('SCHEDULE_CONTEXT_MISMATCH');
      job = unique(contextual, 'AMBIGUOUS_SCHEDULE');
    }
    let newOrder;
    if (!job) {
      // Unmatched weighbridge captures are real trips. Record them as unscheduled
      // instead of parking them: schedule matching is enrichment, never a gate.
      const custom = await resolveCustomCapture(repository, row, config, vehicle, capturedDriver);
      vehicle = custom.vehicle;
      capturedDriver = custom.driver;
      newOrder = custom.order;
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
      // Persist auto-provisioned entities before the job references them.
      for (const [collection, id, record] of custom.toCreate) await repository.create(collection, id, record);
    } else if (!vehicle) {
      // A scheduled job matched by plate still needs its truck registered.
      throw blocked('UNKNOWN_TRUCK');
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
      job = toTonnes(await repository.bind(job.id, weights.key, config.sourceId, siteId));
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
