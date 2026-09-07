/**
 * Excel Workbook Builder
 *
 * Generates a multi-sheet .xlsx Master Audit report using exceljs.
 * Each sheet corresponds to a business entity for auditing and reconciliation.
 */

const ExcelJS = require('exceljs');

// ─── Style constants ───
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
const HEADER_FONT = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
const DATA_FONT = { name: 'Calibri', size: 10 };
const EXPIRED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
const EXPIRING_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
const GREEN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
const BORDER = { style: 'thin', color: { argb: 'FFD1D5DB' } };

function applyHeaderStyle(cell) {
  cell.fill = HEADER_FILL;
  cell.font = HEADER_FONT;
  cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  cell.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
}

function applyDataStyle(cell) {
  cell.font = DATA_FONT;
  cell.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
}

function autoFitColumns(worksheet, headers) {
  worksheet.columns = headers.map((h, i) => ({
    header: h,
    key: `col${i}`,
    width: Math.max(h.length + 6, 16),
  }));
}

function addSheet(wb, name, headers, rows) {
  const ws = wb.addWorksheet(name);
  autoFitColumns(ws, headers);

  // Write header row
  const headerRow = ws.getRow(1);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    applyHeaderStyle(cell);
  });

  // Write data rows
  rows.forEach((row, ri) => {
    const r = ws.getRow(ri + 2);
    headers.forEach((h, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = row[h] !== undefined && row[h] !== null ? row[h] : '';
      applyDataStyle(cell);

      // Conditional formatting: insurance status
      if (h === 'Insurance Status') {
        if (row[h] === 'expired') cell.fill = EXPIRED_FILL;
        else if (row[h] === 'expiring_soon') cell.fill = EXPIRING_FILL;
      }
      // Highlight net weight
      if ((h === 'Net Weight (T)' || h === 'Total Delivered (T)') && Number(row[h]) > 0) {
        cell.fill = GREEN_FILL;
      }
    });
  });

  // Freeze header row
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/**
 * Build the Master Audit Excel workbook.
 * @param {object} data - Object containing all report arrays
 * @param {string} titleSuffix - e.g., "2026-07-14 (Today)"
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function buildExcelWorkbook(data, titleSuffix = '') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TruckSphere Admin';
  wb.created = new Date();

  const suffix = titleSuffix ? ` — ${titleSuffix}` : '';

  // ─── Sheet 1: Master Audit ───
  addSheet(wb, `Master Audit${suffix}`, [
    'Job ID', 'PO Number', 'PO Qty (T)', 'Job Status', 'Vendor',
    'Vendor Insurance Company', 'Vendor Policy No', 'Vendor Insurance Start',
    'Vendor Insurance Commencing', 'Vendor Insurance Expiry', 'Vendor Insurance Supplier', 'Vendor Insurance Status',
    'Driver', 'License', 'Plate',
    'Truck Make', 'Truck Model', 'Material', 'Warehouse Items', 'Origin', 'Material Source', 'Banker', 'Qty Ordered (T)',
    'Qty Delivered (T)', 'Quarry In (EAT)', 'Quarry Out (EAT)', 'Quarry W.In (T)', 'Quarry W.Out (T)',
    'Quarry Net (T)', 'Site In (EAT)', 'Site Out (EAT)', 'Site W.In (T)',
    'Site W.Out (T)', 'Site Net (T)', 'Fuel (L)',
    'Fuel Attendant', 'Auth PIN', 'Lot/Storage #', 'GRN/Receipt #',
    'Quarry Operator', 'Geolocation', 'MIF #', 'Inspector', 'Inspected At (EAT)', 'Material Inspection Details',
  ], data.masterAudit.map((r) => ({
    'Job ID': r.jobId,
    'PO Number': r.poNumber,
    'PO Qty (T)': r.poQuantity,
    'Job Status': r.jobStatus,
    'Vendor': r.vendorName,
    'Vendor Insurance Company': r.vendorInsuranceCompany,
    'Vendor Policy No': r.vendorInsuranceNumber,
    'Vendor Insurance Start': r.vendorInsuranceStartDate,
    'Vendor Insurance Commencing': r.vendorInsuranceCommencingDate,
    'Vendor Insurance Expiry': r.vendorInsuranceExpiryDate,
    'Vendor Insurance Supplier': r.vendorInsuranceSupplier,
    'Vendor Insurance Status': r.vendorInsuranceStatus,
    'Driver': r.driverName,
    'License': r.driverLicense,
    'Plate': r.plateNumber,
    'Truck Make': r.truckMake,
    'Truck Model': r.truckModel,
    'Material': r.materialName,
    'Warehouse Items': r.warehouseItems,
    'Warehouse Receipt Status': r.warehouseReceiptStatus,
    'Accepted at Site (EAT)': r.warehouseAcceptedAt,
    'Accepted By': r.warehouseAcceptedBy,
    'Warehouse Received Items': r.warehouseReceivedItems,
    'Origin': r.origin,
    'Material Source': r.materialSource,
    'Banker': r.banker,
    'Qty Ordered (T)': r.quantityOrdered,
    'Qty Delivered (T)': r.quantityDelivered,
    'Quarry In (EAT)': r.quarryInTimeEAT || r.quarryInTime,
    'Quarry Out (EAT)': r.quarryOutTimeEAT || r.quarryOutTime,
    'Quarry W.In (T)': r.quarryWeighIn,
    'Quarry W.Out (T)': r.quarryWeighOut,
    'Quarry Net (T)': r.quarryNet,
    'Site In (EAT)': r.siteInTimeEAT || r.siteInTime,
    'Site Out (EAT)': r.siteOutTimeEAT || r.siteOutTime,
    'Site W.In (T)': r.siteWeighIn,
    'Site W.Out (T)': r.siteWeighOut,
    'Site Net (T)': r.siteNet,
    'Fuel (L)': r.totalFuelLitres,
    'Fuel Attendant': r.fuelAttendant,
    'Auth PIN': r.fuelOTP,
    'Lot/Storage #': r.lotNumber,
    'GRN/Receipt #': r.grnNumber,
    'Quarry Operator': r.quarryOperator,
    'Geolocation': r.geolocation,
    'MIF #': r.mrfNumber,
    'Inspector': r.inspectorName,
    'Inspected At (EAT)': r.inspectionAtEAT,
    'Material Inspection Details': r.inspectionMaterialReceipts,
  })));

  // ─── Sheet 2: Drivers ───
  addSheet(wb, `Drivers${suffix}`, [
    'Driver Name', 'National ID', 'License Number', 'NTSA Status', 'Insurance Company',
    'Policy No', 'Insurance Start', 'Insurance Commencing', 'Insurance Expiry', 'Insurance Supplier',
    'Insurance Status', 'Vendor', 'Phone', 'Status',
  ], data.drivers.map((r) => ({
    'Driver Name': r.driverName,
    'National ID': r.nationalId,
    'License Number': r.licenseNumber,
    'NTSA Status': r.ntsaStatus,
    'Insurance Company': r.insuranceCompany,
    'Policy No': r.insuranceNumber,
    'Insurance Start': r.insuranceStartDate,
    'Insurance Commencing': r.insuranceCommencingDate,
    'Insurance Expiry': r.insuranceExpiryDate,
    'Insurance Supplier': r.insuranceSupplier,
    'Insurance Status': r.insuranceStatus,
    'Vendor': r.vendorName,
    'Phone': r.phone,
    'Status': r.status,
  })));

  // ─── Sheet 3: Materials ───
  addSheet(wb, `Materials${suffix}`, [
    'Material Name', 'Category', 'Sizes/Grades', 'Unit', 'Total Delivered (T)',
  ], data.materials.map((r) => ({
    'Material Name': r.materialName,
    'Category': r.category,
    'Sizes/Grades': r.sizes,
    'Unit': r.unit,
    'Total Delivered (T)': r.totalDelivered,
  })));

  // ─── Sheet 4: Fuel ───
  addSheet(wb, `Fuel${suffix}`, [
    'Timestamp (EAT)', 'Driver', 'Plate', 'Litres', 'Attendant',
    'Auth PIN', 'Authorizing Vendor', 'Job ID',
  ], data.fuel.map((r) => ({
    'Timestamp (EAT)': r.transactionDate,
    'Driver': r.driverName,
    'Plate': r.plateNumber,
    'Litres': r.litres,
    'Attendant': r.attendantName,
    'Auth PIN': r.otp,
    'Authorizing Vendor': r.authorizingVendor,
    'Job ID': r.jobId,
  })));

  // ─── Sheet 5: Trucks ───
  addSheet(wb, `Trucks${suffix}`, [
    'Plate Number', 'Make', 'Model', 'NTSA Status', 'Insurance Company',
    'Policy No', 'Insurance Start', 'Insurance Commencing', 'Insurance Expiry', 'Insurance Supplier', 'Insurance Status',
    'Vendor', 'Status',
  ], data.trucks.map((r) => ({
    'Plate Number': r.plateNumber,
    'Make': r.make,
    'Model': r.model,
    'NTSA Status': r.ntsaStatus,
    'Insurance Company': r.insuranceCompany,
    'Policy No': r.insuranceNumber,
    'Insurance Start': r.insuranceStartDate,
    'Insurance Commencing': r.insuranceCommencingDate,
    'Insurance Expiry': r.insuranceExpiryDate,
    'Insurance Supplier': r.insuranceSupplier,
    'Insurance Status': r.insuranceStatus,
    'Vendor': r.vendorName,
    'Status': r.status,
  })));

  // ─── Sheet 6: Vendors ───
  addSheet(wb, `Vendors${suffix}`, [
    'Vendor Name', 'Active POs', 'Fulfilled POs', 'Total POs',
    'Insurance Company', 'Policy No', 'Insurance Start', 'Insurance Commencing', 'Insurance Expiry', 'Insurance Supplier', 'Insurance Status', 'Status',
  ], data.vendors.map((r) => ({
    'Vendor Name': r.vendorName,
    'Active POs': r.activePOs,
    'Fulfilled POs': r.fulfilledPOs,
    'Total POs': r.totalPOs,
    'Insurance Company': r.insuranceCompany,
    'Policy No': r.insuranceNumber,
    'Insurance Start': r.insuranceStartDate,
    'Insurance Commencing': r.insuranceCommencingDate,
    'Insurance Expiry': r.insuranceExpiryDate,
    'Insurance Supplier': r.insuranceSupplier,
    'Insurance Status': r.insuranceStatus,
    'Status': r.status,
  })));

  // ─── Sheet 7: Purchase Orders ───
  addSheet(wb, `Purchase Orders${suffix}`, [
    'PO Number', 'Vendor', 'Material', 'Unit', 'Target Qty', 'Delivered Qty',
    'Remaining', 'Progress %', 'Status', 'Created At (EAT)',
  ], data.purchaseOrders.map((r) => ({
    'PO Number': r.poNumber,
    'Vendor': r.vendorName,
    'Material': r.materialName,
    'Unit': r.unit,
    'Target Qty': r.targetQuantity,
    'Delivered Qty': r.deliveredQuantity,
    'Remaining': r.remainingQuantity,
    'Progress %': r.progressPercent,
    'Status': r.status,
    'Created At (EAT)': r.createdAt,
  })));

  // ─── Sheet 8: Material Inspection Forms ───
  addSheet(wb, `Material Inspections${suffix}`, [
    'MIF #', 'Job ID', 'PO Number', 'Material', 'PO Qty', 'Received Qty',
    'Unit', 'Result', 'Failure Reason', 'Deficiency', 'Inspector',
    'Inspected At (EAT)',
  ], (data.materialInspections || []).map((r) => ({
    'MIF #': r.mifNumber,
    'Job ID': r.jobId,
    'PO Number': r.poNumber,
    'Material': r.materialName,
    'PO Qty': r.orderedQuantity,
    'Received Qty': r.receivedQuantity,
    'Unit': r.unit,
    'Result': r.result,
    'Failure Reason': r.failureReason,
    'Deficiency': r.deficiency,
    'Inspector': r.inspectorName,
    'Inspected At (EAT)': r.inspectedAtEAT,
  })));

  addSheet(wb, `Flagged${suffix}`, [
    'Job ID', 'PO Number', 'Vendor', 'Driver', 'Plate', 'Source', 'Status',
    'Reason', 'Flagged By', 'Flagged At (EAT)', 'Cleared By', 'Cleared At (EAT)', 'Clear Reason',
  ], (data.flagged || []).map((r) => ({
    'Job ID': r.jobId, 'PO Number': r.poNumber, 'Vendor': r.vendorName,
    'Driver': r.driverName, 'Plate': r.plateNumber, 'Source': r.source,
    'Status': r.status, 'Reason': r.reason, 'Flagged By': r.flaggedBy,
    'Flagged At (EAT)': r.flaggedAtEAT, 'Cleared By': r.clearedBy,
    'Cleared At (EAT)': r.clearedAtEAT, 'Clear Reason': r.resolutionReason,
  })));

  const stockColumns = ['siteName', 'jobId', 'poNumber', 'materialName', 'origin', 'unit', 'receiptStatus', 'dispatchedQuantity', 'receivedQuantity', 'usableQuantity', 'quarantinedQuantity', 'excessQuantity', 'shortageQuantity', 'consumedQuantity', 'remainingQuantity', 'unitCost', 'currency', 'receivedValue', 'remainingValue', 'valuationStatus', 'acceptedBy', 'acceptedAt', 'inspectorName', 'inspectedAt', 'mifNumber'];
  addSheet(wb, 'Stocks - Current Balances', stockColumns, data.stocks || []);
  addSheet(wb, 'Stock Movements - All Time', ['stockId', 'jobId', 'siteName', 'materialName', 'unit', 'type', 'quantity', 'previousUnitCost', 'unitCost', 'currency', 'remainingQuantity', 'reason', 'actorName', 'createdAt'], data.stockMovements || []);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { buildExcelWorkbook };
