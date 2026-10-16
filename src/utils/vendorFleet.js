const normalizeVendorId = value => {
  const text = String(value || '').trim().toUpperCase();
  return text.replace(/^V?0*(\d+)$/, (_, number) => `V${String(Number(number)).padStart(3, '0')}`);
};
const plate = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function tripVendorId(trip, purchaseOrders = []) {
  const order = purchaseOrders.find(po => (trip.purchaseOrderId && po.id === trip.purchaseOrderId) || (trip.poNumber && po.poNumber === trip.poNumber));
  return normalizeVendorId(order?.vendorId || trip.vendorId);
}
function buildFleetIndex(vehicles = [], trips = [], purchaseOrders = []) {
  const index = new Map(vehicles.map(vehicle => [vehicle.id, new Set([vehicle.vendorId, ...(vehicle.vendorIds || [])].map(normalizeVendorId).filter(Boolean))]));
  const plates = new Map();
  for (const vehicle of vehicles) {
    const key = plate(vehicle.registrationNumber || vehicle.plateNumber);
    if (key) plates.set(key, plates.has(key) ? null : vehicle.id);
  }
  const orders = new Map(purchaseOrders.flatMap(po => [[po.id, po], [po.poNumber, po]]).filter(([key]) => key));
  for (const trip of trips) {
    const vehicleId = trip.vehicleId || trip.truckId || plates.get(plate(trip.plateNumber));
    const order = orders.get(trip.purchaseOrderId) || orders.get(trip.poNumber);
    const vendorId = normalizeVendorId(order?.vendorId || trip.vendorId);
    if (vendorId && index.has(vehicleId)) index.get(vehicleId).add(vendorId);
  }
  return index;
}
function withVehicleVendors(vehicle, index) {
  const vendorIds = [...(index.get(vehicle.id) || [])].sort();
  return { ...vehicle, ...(!vehicle.vendorId && vendorIds.length === 1 ? { vendorId: vendorIds[0] } : {}), vendorIds };
}
function vehicleBelongsToVendor(vehicle, vendorId) {
  const id = normalizeVendorId(vendorId);
  return !!id && [vehicle?.vendorId, ...(vehicle?.vendorIds || [])].some(value => normalizeVendorId(value) === id);
}
function fleetStats(vehicles = [], trips = [], purchaseOrders = [], index = buildFleetIndex(vehicles, trips, purchaseOrders)) {
  const stats = new Map();
  const get = id => { if (!stats.has(id)) stats.set(id, { fleetSize: 0, truckCount: 0, tripCount: 0 }); return stats.get(id); };
  for (const ids of index.values()) for (const id of ids) { const row = get(id); row.fleetSize++; row.truckCount++; }
  for (const trip of trips) { const id = tripVendorId(trip, purchaseOrders); if (id) get(id).tripCount++; }
  return stats;
}
module.exports = { normalizeVendorId, tripVendorId, buildFleetIndex, withVehicleVendors, vehicleBelongsToVendor, fleetStats };
