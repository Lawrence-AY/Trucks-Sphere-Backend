const { isBulkMaterial } = require('../../utils/receivingRoute');
const { isWarehouseReceipt } = require('../warehouse-jobs/receipt');

const METRICS = Object.freeze([
  'Material identity / grade verified',
  'No contamination or foreign material',
  'Acceptable moisture and physical condition',
]);
const PROTECTED_FIELDS = ['receivingStatus', 'storeReceiving', 'receivingEvidence', 'storeQualityInspection', 'receivingFlag', 'inventoryAddedAt'];
const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 409, code: 'STORE_RECEIVING_INVALID' }); };
const linesFor = (job) => job.materials?.length ? job.materials : [
  { materialId: job.materialId || '', materialName: job.materialName || '', quantity: job.quantityOrdered || 0, unit: job.unit || '' },
  ...(job.additionalItems || []),
];
const WEIGHT_UNITS = new Set(['tonne', 'tonnes', 'ton', 'tons', 't', 'kg', 'kilogram', 'kilograms']);
const GENERIC_UNITS = new Set(['unit', 'units', 'each', 'no', 'nos']);
function storeUnit(line, fallback = '') {
  const explicit = String(line.measurementType || line.defaultUnit || line.unit || fallback || '').trim();
  if (explicit && !WEIGHT_UNITS.has(explicit.toLowerCase()) && !GENERIC_UNITS.has(explicit.toLowerCase())) return explicit;
  const category = String(line.materialCategory || line.category || '').trim().toLowerCase();
  const name = String(line.materialName || line.productName || line.materialType || '').trim().toLowerCase();
  const subtype = String(line.cementSubtype || line.materialSubtype || line.subtype || '').trim().toLowerCase();
  if (category === 'cement' && (line.isBagged || ['bagged', 'cement-bagged'].includes(subtype) || /bagged|\bbag\b/.test(name))) return 'Bags';
  if (['aggregate', 'aggregates', 'liquid', 'liquids'].includes(category) || (category === 'cement' && !line.isBagged && !['bagged', 'cement-bagged'].includes(subtype))) return explicit || fallback || 'Tonnes';
  if (explicit && WEIGHT_UNITS.has(explicit.toLowerCase()) && isBulkMaterial(line)) return explicit;
  if (category === 'blocks' || /\b(blocks?|bricks?|pipes?|ducts?|fittings?|valves?|bolts?|nuts?|screws?)\b/.test(name)) return 'Pieces';
  if (/\b(cables?|conduits?|timber|pipes?)\b/.test(name) && /\b(metre|meter|length)\b/.test(name)) return 'Metres';
  if (explicit || ['steel', 'other', 'warehouse'].includes(category)) return 'Pieces';
  return fallback || 'Pieces';
}

function assertAccess(job, actor) {
  if (!['storeman', 'inspector', 'superadmin', 'admin', 'adminlite'].includes(actor.role)) {
    throw Object.assign(new Error('Store receiving access required.'), { statusCode: 403 });
  }
  if (actor.siteId && job.siteId && String(actor.siteId).trim().toLowerCase() !== String(job.siteId).trim().toLowerCase()) {
    throw Object.assign(new Error('Delivery not found.'), { statusCode: 404 });
  }
}
function assertIncoming(job) {
  if (job.receivingStatus || job.materialInspection?.materialReceipts?.length) fail('This delivery already has a receiving decision.');
  if (job.warehouseDeniedAt || String(job.status).toUpperCase() === 'CANCELLED') fail('This delivery was cancelled or denied.');
  if (isBulkMaterial(job)) fail('Bulk deliveries use the weighbridge receiving workflow.');
  if (isWarehouseReceipt(job)) {
    if (!job.warehouseAcceptedAt) fail('The site operator must accept this shipment first.');
    if ((job.siteWeighInWeight != null || job.siteArrivalWeight != null) && job.siteWeighOutWeight == null) fail('Complete site weigh-out before receiving.');
  } else if (!(job.siteWeighInWeight != null || job.siteArrivalWeight != null || job.arrivedAtSiteAt || job.siteInTime || ['ARRIVED_AT_SITE', 'SITE_WEIGHED_IN', 'SITE_WEIGHED_OUT', 'COMPLETED'].includes(String(job.status).toUpperCase()))) {
    fail('This delivery has not arrived at site.');
  }
}
function receiveUpdates(job, input, actor, now) {
  assertAccess(job, actor);
  if (actor.role === 'inspector') fail('A storeman must record receiving first.');
  assertIncoming(job);
  if (!['Pass', 'Failed'].includes(input.condition)) fail('Choose Pass or Failed for the initial condition.');
  const reason = String(input.reason || '').trim();
  const deliveredByName = String(input.deliveredByName || job.driverName || '').trim();
  if (!deliveredByName) fail('Record the personnel who delivered the materials.');
  if (input.condition === 'Failed' && !reason) fail('Enter the receiving rejection reason.');
  const lines = linesFor(job);
  if (!Array.isArray(input.quantities) || input.quantities.length !== lines.length) fail('Count every dispatched material.');
  const evidence = job.receivingEvidence || [];
  const materialReceipts = lines.map((line, index) => {
    const value = input.quantities[index];
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) fail('Enter valid received quantities.');
    const photoURLs = evidence.filter(photo => photo.lineIndex === index).map(photo => photo.url);
    if (!photoURLs.length) fail('Capture a photo for every received material before saving.');
    return { lineIndex: index, materialId: line.materialId || '', materialName: line.materialName || line.productName || '',
      orderedQuantity: Number(line.quantity || 0), receivedQuantity: Number(value), unit: storeUnit(line, input.units?.[index] || job.unit),
      materialCategory: line.materialCategory || line.category || '',
      initialVisualInspection: input.condition, failureReason: input.condition === 'Failed' ? reason : '', photoURLs };
  });
  const failed = input.condition === 'Failed';
  return {
    receivingStatus: failed ? 'receiving_rejected' : 'received_pending_inspection',
    storeReceiving: { condition: input.condition, reason: failed ? reason : '', materialReceipts, receivedAt: now,
      receivedByUid: actor.uid, receivedByName: actor.displayName || actor.email || '',
      vendorName: job.vendorName || '', vendorId: job.vendorId || '', driverName: job.driverName || '',
      driverId: job.driverId || '', plateNumber: job.plateNumber || '', vehicleId: job.vehicleId || '',
      deliveredByName },
    ...(failed ? { receivingFlag: { status: 'flagged', stage: 'receiving', reason, flaggedAt: now, flaggedByUid: actor.uid } } : {}),
    updatedAt: now,
  };
}
function inspectionUpdates(job, input, actor, now) {
  assertAccess(job, actor);
  if (job.receivingStatus !== 'received_pending_inspection' || job.storeReceiving?.condition !== 'Pass') fail('Only passed receiving records can be inspected.');
  if (!['Pass', 'Failed'].includes(input.result)) fail('Choose the quality inspection result.');
  const reason = String(input.reason || '').trim();
  const checks = Object.fromEntries(METRICS.map(metric => [metric, input.qualityChecks?.[metric] === true]));
  if (input.result === 'Pass' && !METRICS.every(metric => checks[metric])) fail('Verify every quality metric before adding inventory.');
  if (input.result === 'Failed' && !reason) fail('Enter the quality inspection rejection reason.');
  const passed = input.result === 'Pass';
  const sourceLines = job.storeReceiving.materialReceipts;
  const decisions = Array.isArray(input.lineDecisions) ? input.lineDecisions : [];
  if (decisions.length && decisions.length !== sourceLines.length) fail('Record accepted and rejected quantities for every material.');
  const decision = { result: input.result, qualityChecks: checks, reason: passed ? '' : reason,
    inspectedAt: now, inspectorUid: actor.uid, inspectorName: actor.displayName || actor.email || '' };
  const materialReceipts = sourceLines.map((line, index) => {
    const candidate = decisions[index];
    // Older clients may submit an empty line-decision object when the
    // inspector intends a normal Pass. Treat that as no split, rather than
    // converting both quantities to zero and rejecting a valid inspection.
    const hasAccepted = candidate && candidate.acceptedQuantity != null && String(candidate.acceptedQuantity).trim() !== '';
    const hasRejected = candidate && candidate.rejectedQuantity != null && String(candidate.rejectedQuantity).trim() !== '';
    const split = hasAccepted || hasRejected ? candidate : null;
    const received = Number(line.receivedQuantity) || 0;
    const rejected = split ? (hasRejected ? Number(split.rejectedQuantity) : 0) : (passed ? 0 : received);
    const accepted = split ? (hasAccepted ? Number(split.acceptedQuantity) : 0) : received - rejected;
    const counted = accepted + rejected;
    if (![accepted, rejected].every(Number.isFinite) || accepted < 0 || rejected < 0 || !Number.isFinite(counted) || (split && counted <= 0)) fail('Enter valid accepted and rejected quantities.');
    const failureReason = String(split?.failureReason || (passed ? '' : reason)).trim();
    if (rejected > 0 && !failureReason) fail('Enter a failure reason for rejected quantities.');
    return { ...line, ...(split ? { sourceReceivedQuantity: line.receivedQuantity, receivedQuantity: counted, unit: storeUnit({ ...line, unit: split.unit || line.unit }) } : {}), acceptedQuantity: accepted, rejectedQuantity: rejected,
      initialVisualInspection: rejected >= counted && counted > 0 ? 'Failed' : 'Pass', qualityChecks: checks,
      failureReason, damagedQuantity: rejected };
  });
  const hasAccepted = materialReceipts.some(line => line.acceptedQuantity > 0);
  const hasRejected = materialReceipts.some(line => line.rejectedQuantity > 0);
  return {
    receivingStatus: passed && hasAccepted ? 'inventory_added' : 'inspection_rejected', storeQualityInspection: { ...decision, hasRejected },
    materialInspection: { ...decision, initialVisualInspection: input.result, materialReceipts,
      mrfNumber: job.materialInspection?.mrfNumber || `${job.jobId || job.id}/MIF`,
      photoURLs: materialReceipts.flatMap(line => line.photoURLs), driverName: job.storeReceiving.driverName, plateNumber: job.storeReceiving.plateNumber },
    ...(passed ? { inventoryAddedAt: now } : { receivingFlag: { status: 'flagged', stage: 'inspection', reason, flaggedAt: now, flaggedByUid: actor.uid } }),
    updatedAt: now,
  };
}
function assertGenericUpdate(job, input) {
  if (PROTECTED_FIELDS.some(key => Object.hasOwn(input, key))) fail('Use the receiving or inspection action to update this workflow.');
  if (job.receivingStatus && ['materials', 'additionalItems', 'materialId', 'quantityOrdered', 'materialInspection', 'siteId'].some(key => Object.hasOwn(input, key))) fail('Received materials and inspection decisions are immutable.');
  if (input.materialInspection && !isBulkMaterial(job) && !job.materialInspection?.materialReceipts?.length) fail('Receive the materials first, then use the quality inspection action.');
}
module.exports = { METRICS, PROTECTED_FIELDS, linesFor, storeUnit, assertAccess, assertIncoming, receiveUpdates, inspectionUpdates, assertGenericUpdate };
