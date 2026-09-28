function isBulkMaterial(job) {
  if (job?.isWarehouseDelivery || job?.isWarehouseMaterial || job?.materials?.some(line => line.isWarehouseMaterial) || [job?.deliveryOrigin, job?.materialSource].some(v => String(v || '').trim().toLowerCase() === 'warehouse')) return false;
  const lines = (job?.materials?.length ? job.materials : [job]).filter(Boolean);
  return lines.some(line => {
    const unit = String(line.measurementType || line.unit || '').trim().toLowerCase();
    if (line.isBagged || line.isCountable === true || line.countable === true || ['bags', 'pieces', 'litres', 'liters', 'metres', 'millimetres'].includes(unit)) return false;
    if (!unit && !line.materialCategory && !line.category && !line.materialType && !line.materialName) return true;
    return line.isCountable === false || line.countable === false || ['tonnes', 'tonne', 'tons', 'ton', 't', 'kilograms', 'kilogram', 'kg', 'bulk', 'bulky'].includes(unit)
      || /\b(bulk|bulky|unbagged|murram|aggregate|sand|ballast)\b/i.test(String(line.materialCategory || line.category || line.materialType || line.materialName || ''));
  });
}
module.exports = { isBulkMaterial };
