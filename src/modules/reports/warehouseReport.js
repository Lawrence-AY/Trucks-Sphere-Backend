const { isWarehouseReceipt } = require('../warehouse-jobs/receipt');

function warehouseReportFields(delivery, formatDate = (value) => value || '') {
  if (!isWarehouseReceipt(delivery)) return {
    warehouseAcceptedAt: '', warehouseAcceptedBy: '', warehouseReceiptStatus: '', warehouseReceivedItems: '',
    warehouseDeniedAt: '', warehouseDenialReason: '',
  };
  const items = delivery.materials?.length ? delivery.materials : delivery.items?.length ? delivery.items : [
    { materialName: delivery.materialName, quantity: delivery.quantityOrdered, unit: delivery.unit },
    ...(delivery.additionalItems || []),
  ];
  const sourceTags = [...new Set(items.flatMap(line => {
    const value = line.source || line.mrfSource || line.materialSource || '';
    return (Array.isArray(value) ? value : [value]).map(tag => String(tag).trim()).filter(Boolean);
  }))].join(' | ');
  const receipts = delivery.materialInspection?.materialReceipts || [];
  return {
    origin: 'Warehouse', materialSource: sourceTags || delivery.materialSource || 'Warehouse',
    mrfSource: sourceTags || delivery.mrfSource || '',
    warehouseMrf: [...new Set(items.map(line => line.mrfNo || line.mrfNumber).filter(Boolean))].join(' | ') || delivery.mrfNo || '',
    materialName: items.map((line) => line.materialName || line.productName || '').filter(Boolean).join(' | '),
    warehouseAcceptedAt: formatDate(delivery.warehouseAcceptedAt),
    warehouseAcceptedBy: delivery.warehouseAcceptedByName || '',
    mrfNumber: delivery.materialInspection?.mrfNumber || '',
    inspectorName: delivery.materialInspection?.inspectorName || '',
    inspectionAtEAT: formatDate(delivery.materialInspection?.inspectedAt),
    inspectionResult: delivery.materialInspection?.initialVisualInspection || '',
    warehouseDeniedAt: formatDate(delivery.warehouseDeniedAt),
    warehouseDenialReason: delivery.warehouseDenialReason || '',
    warehouseReceiptStatus: delivery.warehouseDeniedAt ? 'Denied' : String(delivery.status).toUpperCase() === 'CANCELLED' ? 'Cancelled' : delivery.materialInspection?.mrfNumber ? 'Inspected' : delivery.warehouseAcceptedAt ? 'Awaiting inspection' : 'Awaiting site acceptance',
    warehouseItems: items.map((line) => `${line.materialName || line.productName || line.description || ''}: ${line.quantity ?? ''} ${line.unit || ''}${line.source ? ` | MRF Source: ${line.source}` : ''}${line.mrfNo || line.mrfNumber ? ` | MRF: ${line.mrfNo || line.mrfNumber}` : ''}`.trim()).join(' | '),
    warehouseReceivedItems: receipts.map((line) => `${line.materialName || ''}: ${line.receivedQuantity ?? ''} ${line.unit || ''}`.trim()).join(' | '),
    poQuantity: '', quantityOrdered: '', quantityDelivered: '',
    quarryWeighIn: '', quarryWeighOut: '', netWeight: '', quarryNet: '',
    siteWeighIn: delivery.siteWeighInWeight ?? delivery.siteArrivalWeight ?? '', siteWeighOut: delivery.siteWeighOutWeight ?? '', siteNet: delivery.siteNetWeight ?? '',
    quarryInTime: '', quarryOutTime: '', siteInTime: '', siteOutTime: '',
    quarryInTimeEAT: '', quarryOutTimeEAT: '', siteInTimeEAT: formatDate(delivery.siteWeighInAt), siteOutTimeEAT: formatDate(delivery.siteWeighOutAt),
  };
}
module.exports = { warehouseReportFields };
