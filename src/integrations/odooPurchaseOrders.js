// Native Odoo Purchase Orders. App status stays separate from Odoo approval.
async function one(call, model, domain, fields) {
  const rows = await call(model, 'search_read', { domain, fields, limit: 2 });
  if (rows.length > 1) throw new Error('ODOO_AMBIGUOUS_MAPPING');
  return rows[0];
}
async function createdId(call, model, vals) {
  const ids = await call(model, 'create', { vals_list: [vals] });
  return ids[0];
}
async function syncPurchaseOrder(call, order, vendor = {}, materials = []) {
  if (!order.id || !order.vendorId) throw new Error('ODOO_PO_ID_REQUIRED');
  const existing = await one(call, 'purchase.order', [['x_trucksphere_source_id', '=', order.id]], ['id','state','x_trucksphere_payload']);
  const payload = JSON.stringify(order);
  if (existing?.x_trucksphere_payload === payload) return 'unchanged';
  const metadata = { x_trucksphere_source_id: order.id, x_trucksphere_status: order.status || '', x_trucksphere_payload: payload, partner_ref: order.poNumber || order.id, origin: `TruckSphere:${order.id}` };
  if (existing && !['draft','sent'].includes(existing.state)) {
    await call('purchase.order','write',{ ids: [existing.id], vals: metadata });
    return 'updated'; // Never rewrite approved financial lines or auto-confirm.
  }
  const partnerRef = `TruckSphere:${order.vendorId}`;
  const partner = await one(call,'res.partner',[['ref','=',partnerRef]],['id']);
  const partnerId = partner?.id || await createdId(call,'res.partner',{ name: vendor.companyName || vendor.name || order.vendorName || order.vendorId, ref: partnerRef, is_company: true, supplier_rank: 1, ...(vendor.email ? { email: vendor.email } : {}), ...(vendor.phone ? { phone: vendor.phone } : {}) });
  const sourceLines = order.materials?.length ? order.materials : [{ materialId: order.materialId, materialName: order.materialName, quantity: order.quantity, unit: order.unit, unitPrice: order.unitPrice }];
  const previousLines = existing ? await call('purchase.order.line','search_read',{domain:[['order_id','=',existing.id],['x_trucksphere_line_id','!=',false]],fields:['id','x_trucksphere_line_id','display_type']}) : [];
  const commands = [];
  const units = await call('uom.uom','search_read',{domain:[],fields:['id','name'],limit:1000});
  const unitNames = { tonnes: ['tonnes','ton','t','tons'], kilograms: ['kg','kilograms'], litres: ['l','liters','litres'], pieces: ['units','unit','pieces'], metres: ['m','meters','metres'], millimetres: ['mm','millimeters','millimetres'], 'cubic metres': ['m³','cubic meters','cubic metres'] };
  for (const [index, line] of sourceLines.entries()) {
    const key = `${order.id}:${index}`;
    const material = materials.find(item => [item.id,item.materialId].includes(line.materialId)) || {};
    const name = line.materialName || material.name || line.materialId || 'Material';
    const quantity = Number(line.quantity);
    let vals = { x_trucksphere_line_id: key, sequence: index + 1, name };
    if (line.quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
      vals = { ...vals, display_type: 'line_note', name: `${name} - quantity not specified in TruckSphere`, product_qty: 0, price_unit: 0 };
    } else {
      const unit = String(line.unit || material.defaultUnit || order.unit || 'Units');
      const aliases = unitNames[unit.toLowerCase()] || [unit.toLowerCase()];
      let uom = units.find(item => aliases.includes(item.name.toLowerCase()));
      if (!uom) { uom = { id: await createdId(call,'uom.uom',{name:unit,relative_factor:1}), name:unit }; units.push(uom); }
      const code = material.materialId || line.materialNumber || line.materialId || `TruckSphere:${order.id}:${index}`;
      const product = await one(call,'product.product',[['default_code','=',code]],['id']);
      const productId = product?.id || await createdId(call,'product.product',{ name, default_code: code, type:'consu', uom_id:uom.id, purchase_ok:true });
      vals = { ...vals, display_type:false, product_id:productId, product_qty:quantity, uom_id:uom.id, price_unit:Number(line.unitPrice ?? material.unitPrice ?? order.unitPrice ?? 0) || 0 };
    }
    const previous = previousLines.find(item => item.x_trucksphere_line_id === key);
    // Odoo does not permit changing a note into a product line in place.
    if (previous && (previous.display_type || false) !== vals.display_type) {
      commands.push([2,previous.id,0], [0,0,vals]);
    } else commands.push(previous ? [1,previous.id,vals] : [0,0,vals]);
  }
  // Only remove app-managed lines from editable drafts; manually added lines stay.
  for (const previous of previousLines) if (!sourceLines.some((_, index) => previous.x_trucksphere_line_id === `${order.id}:${index}`)) commands.push([2,previous.id,0]);
  const vals = { ...metadata, partner_id:partnerId, order_line:commands };
  if (existing) { await call('purchase.order','write',{ids:[existing.id],vals}); return 'updated'; }
  await createdId(call,'purchase.order',vals);
  return 'created';
}
module.exports = { syncPurchaseOrder };
