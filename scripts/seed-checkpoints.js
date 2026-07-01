/**
 * TruckSphere Checkpoints Seed Script
 *
 * Adds checkpoint documents for each delivery order in Firestore.
 *
 * Usage:
 *   node backend/scripts/seed-checkpoints.js
 */

const { db } = require('../config/firebase');

const checkpointTypes = [
  'weigh_in',
  'loading',
  'weigh_out',
  'in_transit',
  'arrived_site',
  'received',
];

const deliveryOrderIds = [
  { id: 'do1', jobId: 'JOB-2025-0001', type: 'at_quarry' },
  { id: 'do2', jobId: 'JOB-2025-0002', type: 'delivered' },
  { id: 'do3', jobId: 'JOB-2025-0003', type: 'assigned' },
  { id: 'do4', jobId: 'JOB-2025-0004', type: 'delivered' },
  { id: 'do5', jobId: 'JOB-2025-0005', type: 'delivered' },
  { id: 'do6', jobId: 'JOB-2025-0006', type: 'delivered' },
  { id: 'do7', jobId: 'JOB-2025-0007', type: 'at_quarry' },
  { id: 'do8', jobId: 'JOB-2025-0008', type: 'in_transit' },
  { id: 'do9', jobId: 'JOB-2025-0009', type: 'assigned' },
];

function makeTimestamps(baseDate, offsetMs) {
  return new Date(new Date(baseDate).getTime() + offsetMs).toISOString();
}

const checkpoints = [];

// Build checkpoints for each delivery order based on its type
for (const del of deliveryOrderIds) {
  // Each DO gets 2-3 checkpoints based on its status

  const baseDate = '2025-06-25T06:00:00Z';

  if (del.type === 'delivered') {
    // Full lifecycle - delivered
    checkpoints.push({
      id: `cp-${del.id}-1`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_in',
      timestamp: makeTimestamps(baseDate, 60 * 60 * 1000), // +1h
      location: 'Quarry Gate',
      notes: 'Truck arrived at quarry',
    });
    checkpoints.push({
      id: `cp-${del.id}-2`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'loading',
      timestamp: makeTimestamps(baseDate, 2 * 60 * 60 * 1000), // +2h
      location: 'Quarry Loading Bay',
      notes: 'Loading material',
    });
    checkpoints.push({
      id: `cp-${del.id}-3`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_out',
      timestamp: makeTimestamps(baseDate, 3 * 60 * 60 * 1000), // +3h
      location: 'Quarry Exit',
      notes: 'Weigh-out completed',
    });
    checkpoints.push({
      id: `cp-${del.id}-4`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'in_transit',
      timestamp: makeTimestamps(baseDate, 3.5 * 60 * 60 * 1000), // +3.5h
      location: 'En route to site',
      notes: 'Departing quarry to site',
    });
    checkpoints.push({
      id: `cp-${del.id}-5`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'arrived_site',
      timestamp: makeTimestamps(baseDate, 5 * 60 * 60 * 1000), // +5h
      location: 'Construction Site',
      notes: 'Arrived at site',
    });
    checkpoints.push({
      id: `cp-${del.id}-6`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'received',
      timestamp: makeTimestamps(baseDate, 5.5 * 60 * 60 * 1000), // +5.5h
      location: 'Construction Site',
      notes: 'Material received by site operator',
    });
  } else if (del.type === 'at_quarry') {
    // At quarry - weigh-in done, loading
    checkpoints.push({
      id: `cp-${del.id}-1`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_in',
      timestamp: makeTimestamps(baseDate, 30 * 60 * 1000), // +30min
      location: 'Quarry Gate',
      notes: 'Weigh-in completed',
    });
    checkpoints.push({
      id: `cp-${del.id}-2`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'loading',
      timestamp: makeTimestamps(baseDate, 90 * 60 * 1000), // +1.5h
      location: 'Quarry Loading Bay',
      notes: 'Loading in progress',
    });
  } else if (del.type === 'in_transit') {
    // In transit - full weigh cycle done
    checkpoints.push({
      id: `cp-${del.id}-1`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_in',
      timestamp: makeTimestamps(baseDate, 60 * 60 * 1000),
      location: 'Quarry Gate',
      notes: 'Weigh-in completed',
    });
    checkpoints.push({
      id: `cp-${del.id}-2`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'loading',
      timestamp: makeTimestamps(baseDate, 2 * 60 * 60 * 1000),
      location: 'Quarry Loading Bay',
      notes: 'Loading completed',
    });
    checkpoints.push({
      id: `cp-${del.id}-3`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_out',
      timestamp: makeTimestamps(baseDate, 3 * 60 * 60 * 1000),
      location: 'Quarry Exit',
      notes: 'Weigh-out completed',
    });
    checkpoints.push({
      id: `cp-${del.id}-4`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'in_transit',
      timestamp: makeTimestamps(baseDate, 3.5 * 60 * 60 * 1000),
      location: 'En route to site',
      notes: 'Departing quarry to site',
    });
  } else {
    // assigned - just assigned
    checkpoints.push({
      id: `cp-${del.id}-1`,
      deliveryOrderId: del.id,
      jobId: del.jobId,
      type: 'weigh_in',
      timestamp: makeTimestamps(baseDate, 15 * 60 * 1000),
      location: 'Quarry Gate',
      notes: 'Assigned - waiting at quarry',
    });
  }
}

async function seedCheckpoints() {
  console.log('📍 Seeding checkpoints...\n');

  const batch = db.batch();
  const collectionRef = db.collection('checkpoints');

  for (const cp of checkpoints) {
    const docRef = collectionRef.doc(cp.id);
    batch.set(docRef, cp);
  }

  try {
    await batch.commit();
    console.log(`  ✅ checkpoints: ${checkpoints.length} documents`);
    console.log(`\n🎉 Checkpoint seeding complete! ${checkpoints.length} total checkpoints.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Checkpoint seed failed:', error);
    process.exit(1);
  }
}

seedCheckpoints();
