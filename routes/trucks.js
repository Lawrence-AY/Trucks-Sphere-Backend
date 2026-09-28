// routes/trucks.js
const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../src/middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../src/middleware/authorizationMiddleware');
const managementOnly = requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE);

// GET all trucks (public for now, but you can add authentication if needed)
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('trucks').get();
    const trucks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(trucks);
  } catch (error) {
    console.error('Error fetching trucks:', error);
    res.status(500).json({ error: 'Failed to fetch trucks' });
  }
});

// GET a single truck by ID
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('trucks').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Truck not found' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error fetching truck:', error);
    res.status(500).json({ error: 'Failed to fetch truck' });
  }
});

// POST a new truck (authenticated)
router.post('/', authenticate, async (req, res) => {
  try {
    const { licensePlate, model, capacity, status } = req.body;
    // Basic validation
    if (!licensePlate || !model) {
      return res.status(400).json({ error: 'licensePlate and model are required' });
    }

    const newTruck = {
      licensePlate,
      model,
      capacity: capacity || 0,
      status: status || 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid, // track who created it
    };

    const docRef = await db.collection('trucks').add(newTruck);
    const created = await docRef.get();
    res.status(201).json({ id: docRef.id, ...created.data() });
  } catch (error) {
    console.error('Error creating truck:', error);
    res.status(500).json({ error: 'Failed to create truck' });
  }
});

// PUT (update) a truck (authenticated)
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { licensePlate, model, capacity, status } = req.body;
    const updateData = {};
    if (licensePlate !== undefined) updateData.licensePlate = licensePlate;
    if (model !== undefined) updateData.model = model;
    if (capacity !== undefined) updateData.capacity = capacity;
    if (status !== undefined) updateData.status = status;
    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    updateData.updatedBy = req.user.uid;

    await db.collection('trucks').doc(req.params.id).update(updateData);
    const updated = await db.collection('trucks').doc(req.params.id).get();
    if (!updated.exists) {
      return res.status(404).json({ error: 'Truck not found' });
    }
    res.json({ id: req.params.id, ...updated.data() });
  } catch (error) {
    console.error('Error updating truck:', error);
    res.status(500).json({ error: 'Failed to update truck' });
  }
});

// DELETE a truck (authenticated)
router.delete('/:id', authenticate, managementOnly, async (req, res) => {
  try {
    const docRef = db.collection('trucks').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Truck not found' });
    }
    await docRef.delete();
    res.status(204).send(); // No content
  } catch (error) {
    console.error('Error deleting truck:', error);
    res.status(500).json({ error: 'Failed to delete truck' });
  }
});

module.exports = router;
