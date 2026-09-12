const { db } = require('../../../config/firebase');
const ExcelJS = require('exceljs');
const snapshotStore = require('../../utils/snapshotStore');
const { JOB_STATUS } = require('../../utils/jobLifecycle');
const { buildWarehouseReference, normalizePomatReference } = require('./reference');
const { generateJobIdForPO } = require('../../utils/jobIdService');

const COLLECTION_NAME = 'warehouseJobs';
const collectionRef = db.collection(COLLECTION_NAME);
const deliveryOrdersCollection = db.collection('deliveryOrders');

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function splitCsvRecords(buffer) {
  const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      records.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    records.push(row);
  }
  return records;
}

function excelCellText(cell) {
  const value = cell.value;
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value.result !== undefined) return normalizeText(value.result);
  return cell.text || normalizeText(value);
}

async function spreadsheetRecords(buffer, file = {}) {
  const filename = String(file.originalname || file.name || '').toLowerCase();
  const mimeType = String(file.mimetype || file.mimeType || '').toLowerCase();
  const isXlsx = filename.endsWith('.xlsx') || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (!isXlsx) return splitCsvRecords(buffer);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const columnCount = worksheet.actualColumnCount;
  const records = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    records.push(Array.from({ length: columnCount }, (_value, index) => excelCellText(row.getCell(index + 1))));
  });
  return records;
}

const WAREHOUSE_COLUMN_ALIASES = {
  source: ['source', 'materialsource', 'origin'],
  description: ['description', 'productdescription', 'productname', 'materialname', 'itemdescription', 'item', 'material'],
  quantity: ['quantity', 'qty', 'amount'],
  unit: ['unit', 'uom', 'measure', 'measurement'],
  mrfNo: ['mrfno', 'mrfnumber', 'mrf'],
  additionalNotes: ['additionalnotes', 'notes', 'remarks'],
};

function statusSummary(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.status === 'READY') summary.ready += 1;
    if (row.status === 'INVALID') summary.invalid += 1;
    return summary;
  }, { total: 0, ready: 0, invalid: 0 });
}

function warehouseColumn(headers, aliases) {
  return aliases.map((alias) => headers.indexOf(alias)).find((index) => index >= 0) ?? -1;
}

function isShipmentHeading(record) {
  const values = record.map(normalizeText).filter(Boolean);
  if (!values.length) return true;
  const joined = values.join(' ').toLowerCase();
  if (/^date\s*:/.test(joined)) return true;
  if (/^(source|description|quantity|unit|mrf\s*no\.?|additional notes)$/.test(joined)) return true;
  return false;
}

function sourceRowData(headers, record) {
  return Object.fromEntries(headers.map((header, index) => [header || `Column ${index + 1}`, normalizeText(record[index])]));
}

function findEntity(collectionName, id, aliases = []) {
  const requested = normalizeId(id);
  if (!requested) return null;
  return snapshotStore.getAll(collectionName).find((item) =>
    [item.id, ...aliases.map((key) => item[key])]
      .filter(Boolean)
      .some((value) => normalizeId(value) === requested)
  ) || null;
}

function createValidationError(message, code = 'WAREHOUSE_JOB_INVALID') {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw createValidationError('Add at least one warehouse product.');
  }

  return rawItems.map((item, index) => {
    const productName = String(item?.productName || item?.materialName || '').trim();
    const quantity = Number(item?.quantity);
    const unit = String(item?.unit || 'units').trim();
    if (!productName) {
      throw createValidationError(`Enter a custom name for product ${index + 1}.`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw createValidationError(`Product ${index + 1} needs a positive quantity.`);
    }
    return {
      materialId: '',
      materialName: productName,
      quantity,
      unit: unit || 'units',
      source: String(item?.source || '').trim(),
      description: String(item?.description || '').trim(),
      mrfNo: String(item?.mrfNo || item?.mrfNumber || '').trim(),
      additionalNotes: String(item?.additionalNotes || item?.notes || '').trim(),
      sourceData: item?.sourceData && typeof item.sourceData === 'object' ? item.sourceData : {},
    };
  });
}

const warehouseJobsService = {
  findAll(query = {}) {
    const { search, vendorId, status, page = 1, limit = 50 } = query;
    let records = snapshotStore.getAll(COLLECTION_NAME).map((job) => {
      const receipt = snapshotStore.getById('deliveryOrders', job.deliveryOrderId || job.id);
      return { ...job, warehouseAcceptedAt: receipt?.warehouseAcceptedAt || null,
        warehouseAcceptedByName: receipt?.warehouseAcceptedByName || '',
        status: receipt?.materialInspection?.mrfNumber ? 'INSPECTED' : receipt?.warehouseAcceptedAt ? 'ACCEPTED' : job.status };
    });

    if (vendorId) records = records.filter((item) => normalizeId(item.vendorId) === normalizeId(vendorId));
    if (status) records = records.filter((item) => item.status === status);
    if (search) {
      const term = String(search).trim().toLowerCase();
      records = records.filter((item) =>
        [item.jobId, item.warehouseReference, item.vendorName, item.driverName, item.plateNumber]
          .some((value) => String(value || '').toLowerCase().includes(term)) ||
        (item.items || []).some((line) => String(line.materialName || '').toLowerCase().includes(term))
      );
    }

    records.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    const offset = (Math.max(Number(page) || 1, 1) - 1) * Math.max(Number(limit) || 50, 1);
    const pageSize = Math.max(Number(limit) || 50, 1);
    return {
      data: records.slice(offset, offset + pageSize),
      total: records.length,
      page: Math.max(Number(page) || 1, 1),
      totalPages: Math.ceil(records.length / pageSize),
    };
  },

  findById(id) {
    return snapshotStore.getById(COLLECTION_NAME, id) || null;
  },

  async preview(buffer, file) {
    const records = await spreadsheetRecords(buffer, file);
    if (records.length < 2) {
      throw createValidationError('No shipment rows were found.', 'WAREHOUSE_PREVIEW_ROWS_REQUIRED');
    }

    const originalHeaders = records[0].map(normalizeText);
    const headers = records[0].map(normalizeHeader);
    const indexes = Object.fromEntries(Object.entries(WAREHOUSE_COLUMN_ALIASES).map(([key, aliases]) => [key, warehouseColumn(headers, aliases)]));
    const fallbackTextIndexes = originalHeaders
      .map((_header, index) => index)
      .filter((index) => ![indexes.source, indexes.quantity, indexes.unit, indexes.mrfNo, indexes.additionalNotes].includes(index));

    const rows = records.slice(1)
      .filter((record) => record.some((value) => normalizeText(value)))
      .filter((record) => !isShipmentHeading(record))
      .map((record, index) => {
        const value = (key) => indexes[key] >= 0 ? normalizeText(record[indexes[key]]) : '';
        const fallbackDescription = fallbackTextIndexes.map((cellIndex) => normalizeText(record[cellIndex])).find(Boolean) || '';
        const fallbackQuantity = record.map(normalizeText).find((cell) => Number.isFinite(Number(cell)) && Number(cell) > 0) || '';
        const quantityText = value('quantity') || fallbackQuantity;
        const quantity = Number(quantityText);
        const item = {
          productName: value('description') || fallbackDescription,
          quantity: quantityText,
          unit: value('unit') || 'tonnes',
          source: value('source') || 'Warehouse',
          mrfNo: value('mrfNo'),
          additionalNotes: value('additionalNotes'),
          sourceData: sourceRowData(originalHeaders, record),
        };
        const ready = item.productName && Number.isFinite(quantity) && quantity > 0;
        return {
          rowNumber: index + 2,
          status: ready ? 'READY' : 'INVALID',
          code: ready ? 'READY' : 'WAREHOUSE_ROW_INVALID',
          label: item.productName || `Row ${index + 2}`,
          item,
        };
      })
      .filter((row) => row.status === 'READY');

    if (!rows.length) {
      throw createValidationError('No shipment rows were found.', 'WAREHOUSE_PREVIEW_ROWS_REQUIRED');
    }

    return { headers: originalHeaders, counts: statusSummary(rows), rows };
  },

  async create(data = {}) {
    const purchaseOrder = data.purchaseOrderId
      ? findEntity('purchaseOrders', data.purchaseOrderId, ['poNumber'])
      : null;
    if (!purchaseOrder) {
      throw createValidationError('Choose a valid warehouse purchase order.', 'WAREHOUSE_PURCHASE_ORDER_REQUIRED');
    }

    const orderMaterials = [purchaseOrder, ...(purchaseOrder.materials || [])]
      .map((line) => findEntity('materials', line.materialId, ['materialId']))
      .filter(Boolean);
    const material = orderMaterials.find((entry) => entry.isWarehouseMaterial) ||
      (purchaseOrder.isWarehouseMaterial ? orderMaterials[0] : null);
    if (!material) {
      throw createValidationError('Choose a purchase order for a warehouse material.', 'WAREHOUSE_MATERIAL_REQUIRED');
    }
    if (String(purchaseOrder.status || '').toLowerCase() === 'cancelled') {
      throw createValidationError('This purchase order is cancelled.', 'WAREHOUSE_PURCHASE_ORDER_CANCELLED');
    }

    const materialNumber = String(
      purchaseOrder.materialNumber || material.materialId || material.id || '',
    ).match(/(\d+)/)?.[1];
    const pomatReference = normalizePomatReference(purchaseOrder.poNumber) ||
      (materialNumber ? `POMAT${materialNumber.padStart(3, '0')}` : '');
    if (!pomatReference) {
      throw createValidationError('Enter a valid POMAT reference, for example POMAT077.', 'WAREHOUSE_POMAT_REQUIRED');
    }

    const vendor = findEntity('vendors', purchaseOrder?.vendorId || data.vendorId, ['vendorId']);
    if (!vendor) throw createValidationError('Select a valid vendor.', 'WAREHOUSE_VENDOR_REQUIRED');

    const items = normalizeItems(data.items);
    // Warehouse dispatches do not require a manually selected delivery site.
    // When a PO has one, retain it for downstream routing; otherwise the
    // warehouse job remains available without being hidden from the operator.
    const site = purchaseOrder?.siteId
      ? findEntity('sites', purchaseOrder.siteId, ['siteId'])
      : null;

    // Share the same atomic per-PO J-number sequence as quarry and site jobs.
    // This keeps every dispatch for one PO in one continuous J#### series.
    const warehouseReference = buildWarehouseReference(pomatReference, vendor);
    const { jobId } = await generateJobIdForPO(purchaseOrder.id, warehouseReference);

    return db.runTransaction(async (transaction) => {
      const docRef = collectionRef.doc(jobId.replace(/\//g, '-'));
      const deliveryOrderRef = deliveryOrdersCollection.doc(jobId.replace(/\//g, '-'));
      const existing = await transaction.get(docRef);
      const existingDeliveryOrder = await transaction.get(deliveryOrderRef);
      // Allocate the RN in the job transaction: concurrent creates cannot reuse
      // a number, and a failed job write does not consume one.
      const receiptCounterRef = db.collection('counters').doc('auto_ids');
      const receiptCounter = await transaction.get(receiptCounterRef);
      const receiptSequence = Number(receiptCounter.data()?.receipt_note_counter || 0) + 1;
      const receiptNoteId = `${purchaseOrder.poNumber || warehouseReference}/RN${String(receiptSequence).padStart(3, '0')}`;
      if (existing.exists || existingDeliveryOrder.exists) {
        const error = new Error('Could not allocate a unique warehouse job number. Please retry.');
        error.statusCode = 409;
        error.code = 'WAREHOUSE_JOB_NUMBER_CONFLICT';
        throw error;
      }

      const now = new Date().toISOString();
      const product = items[0];
      const item = {
        id: docRef.id,
        deliveryOrderId: deliveryOrderRef.id,
        receiptNoteId,
        jobId,
        warehouseReference,
        pomatReference,
        poNumber: purchaseOrder.poNumber || pomatReference,
        vendorId: vendor.id,
        vendorName: vendor.companyName || vendor.name || '',
        siteId: site?.id || '',
        siteName: site?.name || site?.location?.address || '',
        items,
        itemCount: items.length,
        workflowType: data.workflowType === 'bulk_upload' ? 'bulk_upload' : 'manual_purchase_order',
        goodsDeliveryNoteSource: String(data.goodsDeliveryNoteSource || '').trim() || 'manual',
        goodsDeliveryNoteFileName: String(data.goodsDeliveryNoteFileName || '').trim(),
        goodsDeliveryNoteHeaders: Array.isArray(data.goodsDeliveryNoteHeaders) ? data.goodsDeliveryNoteHeaders.map(normalizeText) : [],
        dispatchedToSiteAt: now,
        status: 'SUBMITTED',
        submittedAt: now,
        createdByUid: data.createdByUid || '',
        createdByName: data.createdByName || '',
        createdAt: now,
        updatedAt: now,
      };

      const deliveryOrder = {
        id: deliveryOrderRef.id,
        jobId,
        jobKey: warehouseReference,
        warehouseJobId: docRef.id,
        isWarehouseDelivery: true,
        receiptNoteId,
        deliveryOrigin: 'warehouse',
        // Populate the shared source fields used by downstream job views and
        // reports, which otherwise fall back to a quarry origin.
        materialSource: 'Warehouse',
        banker: 'Warehouse-banker',
        quarryName: 'Warehouse',
        warehouseReference,
        pomatReference,
        purchaseOrderId: purchaseOrder?.id || '',
        poNumber: purchaseOrder?.poNumber || pomatReference,
        vendorId: vendor.id,
        vendorName: item.vendorName,
        companyName: item.vendorName,
        materialId: material.id,
        materials: items.map((line, index) => ({ ...line, materialId: `WAREHOUSE-${docRef.id}-${index}` })),
        materialName: product.materialName,
        quantityOrdered: product.quantity,
        quantityDelivered: 0,
        unit: product.unit,
        goodsDeliveryNoteSource: String(data.goodsDeliveryNoteSource || '').trim() || 'manual',
        goodsDeliveryNoteFileName: String(data.goodsDeliveryNoteFileName || '').trim(),
        goodsDeliveryNoteHeaders: Array.isArray(data.goodsDeliveryNoteHeaders) ? data.goodsDeliveryNoteHeaders.map(normalizeText) : [],
        workflowType: data.workflowType === 'bulk_upload' ? 'bulk_upload' : 'manual_purchase_order',
        dispatchedToSiteAt: now,
        additionalItems: items.slice(1),
        siteId: item.siteId,
        siteName: item.siteName,
        status: JOB_STATUS.DISPATCHED,
        submittedAt: now,
        warehouseSubmittedAt: now,
        createdByUid: data.createdByUid || '',
        createdByName: data.createdByName || '',
        createdAt: now,
        updatedAt: now,
      };

      //const writeStocks = await require('../stocks/service').prepare(transaction, deliveryOrder);
      //writeStocks();
      transaction.set(receiptCounterRef, { receipt_note_counter: receiptSequence }, { merge: true });
      transaction.set(docRef, item);
      transaction.set(deliveryOrderRef, deliveryOrder);
      return item;
    });
  },
};

module.exports = warehouseJobsService;
