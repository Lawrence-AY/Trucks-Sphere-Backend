const { db } = require('../../../config/firebase');
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
    };
  });
}

const warehouseJobsService = {
  findAll(query = {}) {
    const { search, vendorId, status, page = 1, limit = 50 } = query;
    let records = [...snapshotStore.getAll(COLLECTION_NAME)];

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

  async create(data = {}) {
    const purchaseOrder = data.purchaseOrderId
      ? findEntity('purchaseOrders', data.purchaseOrderId, ['poNumber'])
      : null;
    if (!purchaseOrder) {
      throw createValidationError('Choose a valid warehouse purchase order.');
    }

    const material = findEntity('materials', purchaseOrder.materialId);
    if (!material?.isWarehouseMaterial) {
      throw createValidationError('Choose a purchase order for a warehouse material.');
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
    if (!vendor) throw createValidationError('Select a valid vendor.');

    const driver = findEntity('drivers', data.driverId, ['driverId']);
    if (!driver || normalizeId(driver.vendorId) !== normalizeId(vendor.id)) {
      throw createValidationError('Select a driver from the selected vendor.');
    }

    const vehicle = findEntity('vehicles', data.vehicleId, ['vehicleId', 'registrationNumber', 'plateNumber']);
    if (!vehicle || normalizeId(vehicle.vendorId) !== normalizeId(vendor.id)) {
      throw createValidationError('Select a truck from the selected vendor.');
    }

    const items = normalizeItems(data.items);
    // Warehouse dispatches do not require a manually selected delivery site.
    // When a PO has one, retain it for downstream routing; otherwise the
    // warehouse job remains available without being hidden from the operator.
    const site = purchaseOrder?.siteId
      ? findEntity('sites', purchaseOrder.siteId, ['siteId'])
      : null;

    // Share the same atomic per-PO J-number sequence as quarry and site jobs.
    // This keeps every dispatch for one PO in one continuous J#### series.
    const warehouseReference = buildWarehouseReference(pomatReference, vendor, driver, vehicle);
    const { jobId } = await generateJobIdForPO(purchaseOrder.id, warehouseReference);

    return db.runTransaction(async (transaction) => {
      const docRef = collectionRef.doc(jobId.replace(/\//g, '-'));
      const deliveryOrderRef = deliveryOrdersCollection.doc(jobId.replace(/\//g, '-'));
      const existing = await transaction.get(docRef);
      const existingDeliveryOrder = await transaction.get(deliveryOrderRef);
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
        jobId,
        warehouseReference,
        pomatReference,
        poNumber: purchaseOrder.poNumber || pomatReference,
        vendorId: vendor.id,
        vendorName: vendor.companyName || vendor.name || '',
        driverId: driver.id,
        driverName: driver.fullName || driver.name || '',
        vehicleId: vehicle.id,
        plateNumber: vehicle.registrationNumber || vehicle.plateNumber || '',
        siteId: site?.id || '',
        siteName: site?.name || site?.location?.address || '',
        items,
        itemCount: items.length,
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
        deliveryOrigin: 'warehouse',
        // Populate the shared source fields used by downstream job views and
        // reports, which otherwise fall back to a quarry origin.
        materialSource: 'Warehouse',
        quarryName: 'Warehouse',
        warehouseReference,
        pomatReference,
        purchaseOrderId: purchaseOrder?.id || '',
        poNumber: purchaseOrder?.poNumber || pomatReference,
        vendorId: vendor.id,
        vendorName: item.vendorName,
        companyName: item.vendorName,
        driverId: driver.id,
        driverName: item.driverName,
        vehicleId: vehicle.id,
        plateNumber: item.plateNumber,
        materialId: `WAREHOUSE-${docRef.id}`,
        materialName: product.materialName,
        quantityOrdered: product.quantity,
        quantityDelivered: 0,
        unit: product.unit,
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

      transaction.set(docRef, item);
      transaction.set(deliveryOrderRef, deliveryOrder);
      return item;
    });
  },
};

module.exports = warehouseJobsService;
