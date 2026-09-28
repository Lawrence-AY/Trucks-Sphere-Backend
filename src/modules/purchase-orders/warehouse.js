function isWarehousePurchaseOrder(order, materials = []) {
  if (order?.isWarehouseMaterial || order?.isWarehouseDelivery || String(order?.materialSource || '').trim().toLowerCase() === 'warehouse') return true;
  const lines = [order, ...(order?.materials || [])].filter(Boolean);
  return lines.some((line) => line.isWarehouseMaterial || materials.some((material) =>
    material.isWarehouseMaterial && [material.id, material.materialId].filter(Boolean).some((id) => String(id).toLowerCase() === String(line.materialId || '').toLowerCase())));
}
module.exports = { isWarehousePurchaseOrder };
