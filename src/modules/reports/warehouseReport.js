const { isWarehouseReceipt } = require('../warehouse-jobs/receipt');

function warehouseReportFields(delivery, formatDate = (value) => value || '') {
  if (!isWarehouseReceipt(delivery)) return {
    warehouseAcceptedAt: '', warehouseAcceptedBy: '', warehouseReceiptStatus: '', warehouseReceivedItems: '',
  };
  const items = delivery.materials?.length ? delivery.materials : [
    { materialName: delivery.materialName, quantity: delivery.quantityOrdered, unit: delivery.unit },
    ...(delivery.additionalItems || []),
  ];
  const receipts = delivery.materialInspection?.materialReceipts || [];
  return {
    origin: 'Warehouse', materialSource: 'Warehouse',
    materialName: items.map((line) => line.materialName || line.productName || '').filter(Boolean).join(' | '),
    warehouseAcceptedAt: formatDate(delivery.warehouseAcceptedAt),
    warehouseAcceptedBy: delivery.warehouseAcceptedByName || '',
    mrfNumber: delivery.materialInspection?.mrfNumber || '',
    inspectorName: delivery.materialInspection?.inspectorName || '',
    inspectionAtEAT: formatDate(delivery.materialInspection?.inspectedAt),
    inspectionResult: delivery.materialInspection?.initialVisualInspection || '',
    warehouseReceiptStatus: delivery.materialInspection?.mrfNumber ? 'Inspected' : delivery.warehouseAcceptedAt ? 'Awaiting inspection' : 'Awaiting site acceptance',
    warehouseItems: items.map((line) => `${line.materialName || ''}: ${line.quantity ?? ''} ${line.unit || ''}`.trim()).join(' | '),
    warehouseReceivedItems: receipts.map((line) => `${line.materialName || ''}: ${line.receivedQuantity ?? ''} ${line.unit || ''}`.trim()).join(' | '),
    quantityOrdered: '', quantityDelivered: '',
    quarryWeighIn: '', quarryWeighOut: '', netWeight: '', quarryNet: '',
    siteWeighIn: '', siteWeighOut: '', siteNet: '',
    quarryInTime: '', quarryOutTime: '', siteInTime: '', siteOutTime: '',
    quarryInTimeEAT: '', quarryOutTimeEAT: '', siteInTimeEAT: '', siteOutTimeEAT: '',
  };
}
module.exports = { warehouseReportFields };
