const delivery_ordersService = require('./service');
const { db } = require('../../../config/firebase');
const { normalizeRole, MANAGEMENT_ROLES } = require('../../middleware/authorizationMiddleware');
const { JOB_STATUS, normalizeJobStatus } = require('../../utils/jobLifecycle');
const snapshotStore = require('../../utils/snapshotStore');

async function getUserEntity(userOrEmail) {
  const user = typeof userOrEmail === 'string' ? null : userOrEmail;
  const email = typeof userOrEmail === 'string' ? userOrEmail : (user?.email || user?.user_email || '');

  // Newly registered accounts use their Firebase UID as the users document
  // ID and keep their sign-in address in `authEmail`. Legacy seeded accounts
  // use a separate document ID and retain `email`. Support both shapes so
  // site/quarry access is resolved from the authenticated operator's actual
  // assignment.
  if (user?.uid) {
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (userDoc.exists) return userDoc.data();
  }

  if (!email) return null;
  const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!userSnap.empty) return userSnap.docs[0].data();

  const authEmailSnap = await db.collection('users').where('authEmail', '==', email).limit(1).get();
  if (!authEmailSnap.empty) return authEmailSnap.docs[0].data();
  return null;
}

function withRoleDefaults(payload, user, userEntity, { isCreate = false } = {}) {
  const nextPayload = { ...payload };
  const email = user?.email || user?.user_email || '';

  if (!email && !userEntity) return nextPayload;

  // Creator and assignment fields belong to a new delivery only. On receipt,
  // retain the original dispatch details and rely on the authenticated actor
  // plus the site weigh-in fields to identify who received the load.
  if (isCreate && user?.uid && !nextPayload.createdByUid) {
    nextPayload.createdByUid = user.uid;
  }

  if (isCreate && user?.role === 'operator_quarry') {
    // The selected purchase order supplies the quarry for a new job. Retain
    // it and only fall back to the operator's assignment when it is missing.
    if (!nextPayload.quarryId && userEntity?.quarryId) {
      nextPayload.quarryId = userEntity.quarryId;
    }
    if (user?.uid && !nextPayload.quarryOperatorUid) {
      nextPayload.quarryOperatorUid = user.uid;
    }
    if (!nextPayload.quarryOperatorName) {
      nextPayload.quarryOperatorName = user?.displayName || user?.email || 'Quarry Operator';
    }
  }

  if (isCreate && user?.role === 'operator_site' && userEntity?.siteId) {
    nextPayload.siteId = userEntity.siteId;
  }

  if (isCreate && user?.role === 'vendor' && userEntity?.vendorId) {
    nextPayload.vendorId = userEntity.vendorId;
  }

  return nextPayload;
}

function isOwnedBy(item, uid) {
  return item?.createdBy?.uid === uid || item?.updatedBy?.uid === uid || item?.createdByUid === uid || item?.ownerUid === uid || item?.operatorUid === uid || item?.quarryOperatorUid === uid || item?.weighInByUid === uid || item?.weighOutByUid === uid;
}

function canAccessDelivery(item, user, userEntity) {
  const role = user?.role;
  const normalizedRole = normalizeRole(role);
  // Both full administrators and operational management editors can see the
  // live dispatch board. Restricting editors to `createdByUid` made the
  // management dashboard report zero trips unless that exact user created
  // every delivery order.
  if (
    normalizedRole === MANAGEMENT_ROLES.SUPER_ADMIN ||
    normalizedRole === MANAGEMENT_ROLES.EDIT
  ) return true;
  // Quarry history is shared by the operators assigned to that quarry. This
  // lets each shift see dispatches completed by the previous shift while
  // keeping records from every other quarry inaccessible.
  if (normalizedRole === 'operator_quarry') {
    return Boolean(
      (userEntity?.quarryId && item?.quarryId === userEntity.quarryId) ||
      (userEntity?.quarryLocation && String(item?.quarryName || '').trim().toLowerCase() === String(userEntity.quarryLocation).trim().toLowerCase()) ||
      (user?.uid && isOwnedBy(item, user.uid)),
    );
  }

  // Site operations use one shared receiving queue. The weigh-in workflow
  // records the authenticated operator who actually receives the load.
  if (normalizedRole === 'operator_site') {
    return true;
  }

  return Boolean(user?.uid && isOwnedBy(item, user.uid));
}

/** The optimized service returns a paged result; normalize it for controllers. */
function unwrapDeliveryResults(result) {
  if (Array.isArray(result)) return { data: result, page: 1, totalPages: 1 };
  return {
    ...result,
    data: Array.isArray(result?.data) ? result.data : [],
  };
}

exports.findAll = async (req, res, next) => {
  try {
    let scopedQuery = { ...req.query };

    // Scope delivery orders based on user role
    const userEntity = await getUserEntity(req.user);

    const result = unwrapDeliveryResults(await delivery_ordersService.findAll(scopedQuery));
    const data = result.data.filter((item) => canAccessDelivery(item, req.user, userEntity));
    if (process.env.API_DEBUG_LOGGING === 'true') {
      console.info('[Delivery orders debug] visibility', {
        role: normalizeRole(req.user?.role),
        cachedCount: result.data.length,
        visibleCount: data.length,
      });
    }
    res.json({ ...result, data, total: data.length, totalPages: 1 });
  } catch (err) { next(err); }
};

/**
 * Fuel operators can see only delivery jobs that have been finalized at site.
 * This keeps the general delivery-order board restricted to management while
 * giving the fuel-dispensing workflow the precise data it needs.
 */
exports.findFuelReady = async (req, res, next) => {
  try {
    const result = unwrapDeliveryResults(
      await delivery_ordersService.findAll({ ...req.query, fuelReady: true })
    );
    const vendorsById = new Map();
    snapshotStore.getAll('vendors').forEach((vendor) => {
      [vendor.id, vendor.vendorId]
        .filter(Boolean)
        .forEach((id) => vendorsById.set(String(id).trim().toLowerCase(), vendor));
    });

    const data = result.data
      .filter((item) => {
        const status = normalizeJobStatus(item.status);
        return status === JOB_STATUS.SITE_WEIGHED_OUT || status === JOB_STATUS.COMPLETED;
      })
      .map((item) => {
        const vendor = vendorsById.get(String(item.vendorId || '').trim().toLowerCase());
        return {
          ...item,
          vendorName: item.vendorName || vendor?.companyName || vendor?.name || '',
          // Only the contact needed for a fuel-authorization PIN is exposed
          // to the fuel workflow; vendor-directory access remains restricted.
          vendorPhone:
            item.vendorPhone ||
            item.vendorMobile ||
            item.vendorContactPhone ||
            vendor?.phone ||
            vendor?.mobile ||
            vendor?.contactPhone ||
            '',
        };
      });

    res.json({ ...result, data, total: data.length, totalPages: 1 });
  } catch (err) {
    next(err);
  }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await delivery_ordersService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const userEntity = await getUserEntity(req.user);
    if (!canAccessDelivery(item, req.user, userEntity)) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.findByJobId = async (req, res, next) => {
  try {
    // Wildcard route: jobId is captured in req.params[0] (Express 4)
    const jobId = (req.params[0] || '').replace(/^\/+/, '');
    const userEntity = await getUserEntity(req.user);
    const result = unwrapDeliveryResults(await delivery_ordersService.findAll({ jobId }));
    const data = result.data.filter((item) => canAccessDelivery(item, req.user, userEntity));
    res.json({ ...result, data, total: data.length, totalPages: 1 });
  } catch (err) { next(err); }
};

exports.findByPurchaseOrderId = async (req, res, next) => {
  try {
    const purchaseOrderId = (req.params[0] || '').replace(/^\/+/, '');
    const userEntity = await getUserEntity(req.user);
    const result = unwrapDeliveryResults(await delivery_ordersService.findAll({ purchaseOrderId }));
    const data = result.data.filter((item) => canAccessDelivery(item, req.user, userEntity));
    res.json({ ...result, data, total: data.length, totalPages: 1 });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const userEntity = await getUserEntity(req.user);
    const payload = withRoleDefaults(req.body, req.user, userEntity, { isCreate: true });
    const item = await delivery_ordersService.create(payload);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await delivery_ordersService.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const entity = await getUserEntity(req.user);
    if (!canAccessDelivery(existing, req.user, entity)) return res.status(404).json({ error: 'Not found' });
    const payload = withRoleDefaults(req.body, req.user, entity);
    const item = await delivery_ordersService.update(req.params.id, payload);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.receiveLot = async (req, res, next) => {
  try {
    const { deliveryOrderId, storageLot } = req.body;

    if (!deliveryOrderId || !storageLot) {
      return res.status(400).json({
        error: 'Both deliveryOrderId and storageLot are required.',
      });
    }

    if (typeof storageLot !== 'string' || storageLot.trim().length === 0) {
      return res.status(400).json({
        error: 'storageLot must be a non-empty string.',
      });
    }

    const updated = await delivery_ordersService.receiveLot(deliveryOrderId, storageLot.trim());
    if (!updated) {
      return res.status(404).json({ error: 'Delivery order not found.' });
    }

    res.json(updated);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    const existing = await delivery_ordersService.findById(req.params.id);
    if (!existing || !canAccessDelivery(existing, req.user)) return res.status(404).json({ error: 'Not found' });
    await delivery_ordersService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};
