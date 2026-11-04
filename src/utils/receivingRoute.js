function isBulkMaterial(job) {
  if (job?.isWarehouseDelivery || job?.isWarehouseMaterial || job?.materials?.some(line => line.isWarehouseMaterial) || [job?.deliveryOrigin, job?.materialSource].some(v => String(v || '').trim().toLowerCase() === 'warehouse')) return false;
  const lines = (job?.materials?.length ? job.materials : [job]).filter(Boolean);
  return lines.some(line => {
    const category = String(line.materialCategory || line.category || '').trim().toLowerCase();
    const cementSubtype = String(line.cementSubtype || line.materialSubtype || line.subtype || '').trim().toLowerCase();
    if (cementSubtype === 'cement-bagged' || cementSubtype === 'bagged') return false;
    if (['other', 'steel', 'blocks', 'block', 'warehouse'].includes(category)) return false;
    if (['liquid', 'aggregate', 'aggregates', 'cement'].includes(category)) return true;
    const unit = String(line.measurementType || line.unit || '').trim().toLowerCase();
    const description = String(line.materialCategory || line.category || line.materialType || line.materialName || '');
    // The weighbridge records the truck weight in tonnes, but manufactured
    // items such as duct pipes are received by count/length at stores.
    if (/\b(pipe|pipes|duct|ducts|cable|conduit|fitting|valve|bolt|nut|screw|timber|steel|sheet|tile|block|brick)\b/i.test(description)) return false;
    if (line.isBagged || line.isCountable === true || line.countable === true || ['bags', 'pieces', 'sets', 'litres', 'liters', 'metres', 'millimetres'].includes(unit)) return false;
    if (!unit && !line.materialCategory && !line.category && !line.materialType && !line.materialName) return true;
    return line.isCountable === false || line.countable === false || ['tonnes', 'tonne', 'tons', 'ton', 't', 'kilograms', 'kilogram', 'kg', 'bulk', 'bulky'].includes(unit)
      || /\b(bulk|bulky|unbagged|murram|aggregate|sand|ballast)\b/i.test(description);
  });
}
function materialRoutingTag(material = {}) {
  return isBulkMaterial(material) ? 'bulky' : 'non-bulky';
}
module.exports = { isBulkMaterial, materialRoutingTag };
