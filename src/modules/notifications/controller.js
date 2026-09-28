/**
 * Notifications Controller
 *
 * Retrieves notifications scoped to the authenticated user.
 * Used by the user-facing notifications screen.
 */

const { db } = require('../../../config/firebase');

exports.findAll = async (req, res, next) => {
  try {
    const { uid } = req.user;
    const snap = await db.collection('notifications')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const notifications = [];
    snap.forEach((doc) => {
      notifications.push({ id: doc.id, ...doc.data() });
    });

    res.json(notifications);
  } catch (err) {
    next(err);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    await db.collection('notifications').doc(req.params.id).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const { uid } = req.user;
    const snap = await db.collection('notifications')
      .where('userId', '==', uid)
      .where('read', '==', false)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.update(doc.ref, { read: true });
    });
    await batch.commit();

    res.json({ success: true, count: snap.size });
  } catch (err) {
    next(err);
  }
};