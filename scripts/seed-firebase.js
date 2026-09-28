/**
 * TruckSphere Firebase Seed Script
 * 
 * Populates Firestore with realistic sample data for development.
 * 
 * Usage:
 *   node backend/scripts/seed-firebase.js
 */

const { db } = require('../config/firebase');

// ============================================================
// SAMPLE DATA
// ============================================================

const vendors = [
  { id: 'v1', name: 'Mwangi Transport Ltd', phone: '+254712345601', email: 'info@mwangi.co.ke', address: 'Nairobi Industrial Area', status: 'active', fleetSize: 4, createdAt: '2025-01-10T08:00:00Z' },
  { id: 'v2', name: 'Kamau Trucking Co', phone: '+254712345602', email: 'info@kamauco.ke', address: 'Mombasa Road', status: 'active', fleetSize: 3, createdAt: '2025-02-15T09:00:00Z' },
  { id: 'v3', name: 'Ochieng Supplies Ltd', phone: '+254712345603', email: 'info@ochieng.co.ke', address: 'Kisumu Industrial Park', status: 'active', fleetSize: 2, createdAt: '2025-03-20T10:00:00Z' },
  { id: 'v4', name: 'Njoroge Heavy Haulage', phone: '+254712345604', email: 'info@njoroge.co.ke', address: 'Thika Road', status: 'active', fleetSize: 5, createdAt: '2025-04-10T11:00:00Z' },
  { id: 'v5', name: 'Wanjiku Logistics', phone: '+254712345605', email: 'info@wanjikulogistics.co.ke', address: 'Nakuru Highway', status: 'inactive', fleetSize: 1, createdAt: '2025-05-05T12:00:00Z' },
];

const drivers = [
  { id: 'd1', name: 'David Mwangi', phone: '+254712345678', email: 'david.m@example.com', licenseNumber: 'L12345', licenseExpiry: '2026-12-31', status: 'active', vendorId: 'v1', assignedTruckId: 't1', photoURL: '', totalTrips: 47, rating: 4.8, createdAt: '2025-01-15T08:00:00Z' },
  { id: 'd2', name: 'Sarah Wanjiku', phone: '+254723456789', email: 'sarah.w@example.com', licenseNumber: 'L12346', licenseExpiry: '2026-11-30', status: 'active', vendorId: 'v1', assignedTruckId: 't2', photoURL: '', totalTrips: 32, rating: 4.6, createdAt: '2025-02-20T09:00:00Z' },
  { id: 'd3', name: 'James Ochieng', phone: '+254734567890', email: 'james.o@example.com', licenseNumber: 'L12347', licenseExpiry: '2026-10-15', status: 'active', vendorId: 'v2', assignedTruckId: 't3', photoURL: '', totalTrips: 28, rating: 4.5, createdAt: '2025-03-10T10:00:00Z' },
  { id: 'd4', name: 'Grace Akinyi', phone: '+254745678901', email: 'grace.a@example.com', licenseNumber: 'L12348', licenseExpiry: '2026-09-20', status: 'inactive', vendorId: 'v2', photoURL: '', totalTrips: 15, rating: 4.2, createdAt: '2025-04-05T11:00:00Z' },
  { id: 'd5', name: 'Peter Kamau', phone: '+254756789012', email: 'peter.k@example.com', licenseNumber: 'L12349', licenseExpiry: '2026-08-01', status: 'active', vendorId: 'v1', assignedTruckId: 't4', photoURL: '', totalTrips: 53, rating: 4.9, createdAt: '2025-05-12T12:00:00Z' },
  { id: 'd6', name: 'Mary Njoroge', phone: '+254767890123', email: 'mary.n@example.com', licenseNumber: 'L12350', licenseExpiry: '2025-07-15', status: 'suspended', vendorId: 'v3', photoURL: '', totalTrips: 8, rating: 3.5, createdAt: '2025-06-01T13:00:00Z' },
  { id: 'd7', name: 'John Kiprop', phone: '+254778901234', email: 'john.k@example.com', licenseNumber: 'L12351', licenseExpiry: '2027-01-20', status: 'active', vendorId: 'v3', assignedTruckId: 't5', photoURL: '', totalTrips: 22, rating: 4.4, createdAt: '2025-07-10T14:00:00Z' },
  { id: 'd8', name: 'Esther Chebet', phone: '+254789012345', email: 'esther.c@example.com', licenseNumber: 'L12352', licenseExpiry: '2027-03-15', status: 'active', vendorId: 'v4', assignedTruckId: 't6', photoURL: '', totalTrips: 19, rating: 4.7, createdAt: '2025-08-05T08:00:00Z' },
  { id: 'd9', name: 'Samuel Maina', phone: '+254790123456', email: 'samuel.m@example.com', licenseNumber: 'L12353', licenseExpiry: '2026-06-30', status: 'active', vendorId: 'v4', assignedTruckId: 't7', photoURL: '', totalTrips: 41, rating: 4.3, createdAt: '2025-09-01T09:00:00Z' },
  { id: 'd10', name: 'Faith Wambui', phone: '+254701234567', email: 'faith.w@example.com', licenseNumber: 'L12354', licenseExpiry: '2027-05-10', status: 'active', vendorId: 'v4', assignedTruckId: 't8', photoURL: '', totalTrips: 12, rating: 4.1, createdAt: '2025-10-15T10:00:00Z' },
];

const vehicles = [
  { id: 't1', plateNumber: 'KCA 123A', model: 'FH 460', make: 'Volvo', year: 2023, color: 'White', capacity: 40, status: 'active', vendorId: 'v1', assignedDriverId: 'd1', insuranceExpiry: '2026-06-30', lastInspection: '2025-12-15', createdAt: '2025-01-10T08:00:00Z' },
  { id: 't2', plateNumber: 'KCB 456B', model: 'Actros 3348', make: 'Mercedes-Benz', year: 2022, color: 'Blue', capacity: 38, status: 'active', vendorId: 'v1', assignedDriverId: 'd2', insuranceExpiry: '2026-05-20', lastInspection: '2025-11-20', createdAt: '2025-02-15T09:00:00Z' },
  { id: 't3', plateNumber: 'KCC 789C', model: 'TGX 26.480', make: 'MAN', year: 2023, color: 'Red', capacity: 42, status: 'active', vendorId: 'v2', assignedDriverId: 'd3', insuranceExpiry: '2026-07-10', lastInspection: '2025-12-01', createdAt: '2025-03-20T10:00:00Z' },
  { id: 't4', plateNumber: 'KCD 012D', model: 'FMX 440', make: 'Volvo', year: 2021, color: 'Silver', capacity: 36, status: 'in_maintenance', vendorId: 'v1', assignedDriverId: 'd5', insuranceExpiry: '2026-04-15', lastInspection: '2025-10-05', createdAt: '2025-04-25T11:00:00Z' },
  { id: 't5', plateNumber: 'KCE 345E', model: 'Dumper FMX', make: 'Volvo', year: 2024, color: 'Yellow', capacity: 45, status: 'active', vendorId: 'v3', assignedDriverId: 'd7', insuranceExpiry: '2027-01-20', lastInspection: '2026-01-10', createdAt: '2025-07-01T12:00:00Z' },
  { id: 't6', plateNumber: 'KCF 678F', model: 'FH 500', make: 'Volvo', year: 2024, color: 'White', capacity: 44, status: 'active', vendorId: 'v4', assignedDriverId: 'd8', insuranceExpiry: '2027-02-28', lastInspection: '2026-01-15', createdAt: '2025-08-01T08:00:00Z' },
  { id: 't7', plateNumber: 'KCG 901G', model: 'Actros 3363', make: 'Mercedes-Benz', year: 2023, color: 'Black', capacity: 40, status: 'active', vendorId: 'v4', assignedDriverId: 'd9', insuranceExpiry: '2026-09-30', lastInspection: '2025-12-20', createdAt: '2025-08-15T09:00:00Z' },
  { id: 't8', plateNumber: 'KCH 234H', model: 'TGX 28.560', make: 'MAN', year: 2025, color: 'Green', capacity: 46, status: 'active', vendorId: 'v4', assignedDriverId: 'd10', insuranceExpiry: '2027-06-15', lastInspection: '2026-02-01', createdAt: '2025-11-01T10:00:00Z' },
  { id: 't9', plateNumber: 'KCJ 567J', model: 'FMX 460', make: 'Volvo', year: 2022, color: 'Red', capacity: 38, status: 'out_of_service', vendorId: 'v2', insuranceExpiry: '2025-08-31', lastInspection: '2025-06-01', createdAt: '2025-03-25T11:00:00Z' },
];

const materials = [
  { id: 'm1', name: 'Ballast 3/4"', description: 'Crushed stone 3/4 inch for concrete mix', unit: 'tonnes', unitPrice: 1800, category: 'aggregates', active: true },
  { id: 'm2', name: 'Ballast 1/2"', description: 'Crushed stone 1/2 inch for concrete mix', unit: 'tonnes', unitPrice: 1900, category: 'aggregates', active: true },
  { id: 'm3', name: 'Sand (River)', description: 'Natural river sand for plastering', unit: 'tonnes', unitPrice: 1500, category: 'sand', active: true },
  { id: 'm4', name: 'Sand (Quarry)', description: 'Quarry dust / Manufactured sand', unit: 'tonnes', unitPrice: 1300, category: 'sand', active: true },
  { id: 'm5', name: 'Hardcore', description: 'Large stones for foundation filling', unit: 'tonnes', unitPrice: 1200, category: 'aggregates', active: true },
  { id: 'm6', name: 'Murram', description: 'Laterite soil for road grading', unit: 'tonnes', unitPrice: 800, category: 'earth', active: true },
  { id: 'm7', name: 'Cement (Portland)', description: 'Portland cement 50kg bags', unit: 'bags', unitPrice: 650, category: 'cement', active: true },
  { id: 'm8', name: 'Concrete Mix (Grade 25)', description: 'Ready-mix concrete Grade 25', unit: 'm³', unitPrice: 8500, category: 'concrete', active: true },
  { id: 'm9', name: 'Concrete Mix (Grade 30)', description: 'Ready-mix concrete Grade 30', unit: 'm³', unitPrice: 9500, category: 'concrete', active: true },
  { id: 'm10', name: 'Building Stone', description: 'Machine-cut building stones 6x9x18', unit: 'pieces', unitPrice: 45, category: 'stone', active: true },
];

const quarries = [
  { id: 'q1', name: 'Kisumu Quarry', location: { address: 'Kisumu Industrial Area, Kisumu', latitude: -0.0917, longitude: 34.7680 }, status: 'active', contact: '+254700111001', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'q2', name: 'River Sand Quarry', location: { address: 'Athi River, Machakos', latitude: -1.4567, longitude: 36.9782 }, status: 'active', contact: '+254700111002', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'q3', name: 'Cement Depot', location: { address: 'Bamburi, Mombasa Road', latitude: -1.3456, longitude: 36.7845 }, status: 'active', contact: '+254700111003', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'q4', name: 'Nairobi Quarry', location: { address: 'Kasarani, Nairobi', latitude: -1.2156, longitude: 36.8956 }, status: 'active', contact: '+254700111004', createdAt: '2025-01-02T08:00:00Z' },
  { id: 'q5', name: 'Nakuru Stone Quarry', location: { address: 'Njoro, Nakuru', latitude: -0.3456, longitude: 36.0123 }, status: 'active', contact: '+254700111005', createdAt: '2025-01-03T08:00:00Z' },
];

const sites = [
  { id: 's1', name: 'Site 1', location: { address: 'Ruiru, Kiambu', latitude: -1.1556, longitude: 36.8956 }, status: 'active', contact: '+254711001001', createdAt: '2025-01-05T08:00:00Z' },
];

const purchaseOrders = [
  { id: 'po1', poNumber: 'PO-2025-001', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', materialId: 'm1', materialName: 'Ballast 3/4"', quantity: 200, unit: 'tonnes', unitPrice: 1800, totalAmount: 360000, status: 'approved', quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'City Centre Site B', requestedBy: 'u1', approvedBy: 'u2', notes: '', createdAt: '2025-06-01T08:00:00Z', updatedAt: '2025-06-02T10:00:00Z' },
  { id: 'po2', poNumber: 'PO-2025-002', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', materialId: 'm3', materialName: 'Sand (River)', quantity: 150, unit: 'tonnes', unitPrice: 1500, totalAmount: 225000, status: 'in_progress', quarryId: 'q2', quarryName: 'River Sand Quarry', siteId: 's1', siteName: 'City Centre Site B', requestedBy: 'u1', notes: 'Urgent - needed for foundation', createdAt: '2025-06-10T09:00:00Z', updatedAt: '2025-06-11T11:00:00Z' },
  { id: 'po3', poNumber: 'PO-2025-003', vendorId: 'v2', vendorName: 'Kamau Trucking Co', materialId: 'm2', materialName: 'Ballast 1/2"', quantity: 100, unit: 'tonnes', unitPrice: 1900, totalAmount: 190000, status: 'pending', quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'Site 1', requestedBy: 'u3', notes: '', createdAt: '2025-06-15T10:00:00Z', updatedAt: '2025-06-15T10:00:00Z' },
  { id: 'po4', poNumber: 'PO-2025-004', vendorId: 'v3', vendorName: 'Ochieng Supplies Ltd', materialId: 'm5', materialName: 'Hardcore', quantity: 80, unit: 'tonnes', unitPrice: 1200, totalAmount: 96000, status: 'completed', quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'Site 1', requestedBy: 'u1', approvedBy: 'u2', notes: '', createdAt: '2025-05-20T08:00:00Z', updatedAt: '2025-06-05T16:00:00Z' },
  { id: 'po5', poNumber: 'PO-2025-005', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', materialId: 'm7', materialName: 'Cement (Portland)', quantity: 500, unit: 'bags', unitPrice: 650, totalAmount: 325000, status: 'pending', quarryId: 'q3', quarryName: 'Cement Depot', siteId: 's1', siteName: 'Site 1', requestedBy: 'u3', notes: '', createdAt: '2025-06-18T14:00:00Z', updatedAt: '2025-06-18T14:00:00Z' },
  { id: 'po6', poNumber: 'PO-2025-006', vendorId: 'v4', vendorName: 'Njoroge Heavy Haulage', materialId: 'm4', materialName: 'Sand (Quarry)', quantity: 300, unit: 'tonnes', unitPrice: 1300, totalAmount: 390000, status: 'approved', quarryId: 'q4', quarryName: 'Nairobi Quarry', siteId: 's1', siteName: 'Site 1', requestedBy: 'u1', approvedBy: 'u2', notes: 'Phased delivery over 2 weeks', createdAt: '2025-06-20T08:00:00Z', updatedAt: '2025-06-20T10:00:00Z' },
  { id: 'po7', poNumber: 'PO-2025-007', vendorId: 'v4', vendorName: 'Njoroge Heavy Haulage', materialId: 'm5', materialName: 'Hardcore', quantity: 120, unit: 'tonnes', unitPrice: 1200, totalAmount: 144000, status: 'pending', quarryId: 'q5', quarryName: 'Nakuru Stone Quarry', siteId: 's1', siteName: 'Site 1', requestedBy: 'u3', notes: '', createdAt: '2025-06-22T09:00:00Z', updatedAt: '2025-06-22T09:00:00Z' },
];

const deliveryOrders = [
  { id: 'do1', jobId: 'JOB-2025-0001', purchaseOrderId: 'po1', poNumber: 'PO-2025-001', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', driverId: 'd1', driverName: 'David Mwangi', vehicleId: 't1', plateNumber: 'KCA 123A', materialId: 'm1', materialName: 'Ballast 3/4"', quantityOrdered: 20, quantityDelivered: 0, quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'City Centre Site B', status: 'at_quarry', weighInWeight: 42.5, weighInAt: '2025-06-20T08:30:00Z', weighInLocation: 'Kisumu Quarry Gate', createdBy: 'u1', createdAt: '2025-06-19T10:00:00Z', updatedAt: '2025-06-20T08:30:00Z' },
  { id: 'do2', jobId: 'JOB-2025-0002', purchaseOrderId: 'po1', poNumber: 'PO-2025-001', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', driverId: 'd2', driverName: 'Sarah Wanjiku', vehicleId: 't2', plateNumber: 'KCB 456B', materialId: 'm1', materialName: 'Ballast 3/4"', quantityOrdered: 20, quantityDelivered: 20, quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'City Centre Site B', status: 'delivered', weighInWeight: 40.2, weighOutWeight: 18.5, netWeight: 21.7, weighInAt: '2025-06-19T08:00:00Z', weighOutAt: '2025-06-19T09:15:00Z', weighInLocation: 'Kisumu Quarry Gate', weighOutLocation: 'Kisumu Quarry Exit', deliveredAt: '2025-06-19T11:30:00Z', receivedAt: '2025-06-19T11:30:00Z', receivedLocation: 'City Centre Site B', receivedBy: 'Anna Site', createdBy: 'u1', createdAt: '2025-06-18T10:00:00Z', updatedAt: '2025-06-19T11:30:00Z' },
  { id: 'do3', jobId: 'JOB-2025-0003', purchaseOrderId: 'po2', poNumber: 'PO-2025-002', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', driverId: 'd5', driverName: 'Peter Kamau', vehicleId: 't4', plateNumber: 'KCD 012D', materialId: 'm3', materialName: 'Sand (River)', quantityOrdered: 20, quantityDelivered: 0, quarryId: 'q2', quarryName: 'River Sand Quarry', siteId: 's1', siteName: 'Site 1', status: 'assigned', createdBy: 'u1', createdAt: '2025-06-18T11:00:00Z', updatedAt: '2025-06-18T11:00:00Z' },
  { id: 'do4', jobId: 'JOB-2025-0004', purchaseOrderId: 'po4', poNumber: 'PO-2025-004', vendorId: 'v3', vendorName: 'Ochieng Supplies Ltd', driverId: 'd3', driverName: 'James Ochieng', vehicleId: 't3', plateNumber: 'KCC 789C', materialId: 'm5', materialName: 'Hardcore', quantityOrdered: 20, quantityDelivered: 20, quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'Site 1', status: 'delivered', weighInWeight: 44.0, weighOutWeight: 22.3, netWeight: 21.7, weighInAt: '2025-06-05T07:00:00Z', weighOutAt: '2025-06-05T08:30:00Z', deliveredAt: '2025-06-05T10:00:00Z', receivedAt: '2025-06-05T10:00:00Z', receivedBy: 'Site Manager', createdBy: 'u1', createdAt: '2025-06-04T10:00:00Z', updatedAt: '2025-06-05T10:00:00Z' },
  { id: 'do5', jobId: 'JOB-2025-0005', purchaseOrderId: 'po1', poNumber: 'PO-2025-001', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', driverId: 'd1', driverName: 'David Mwangi', vehicleId: 't1', plateNumber: 'KCA 123A', materialId: 'm1', materialName: 'Ballast 3/4"', quantityOrdered: 20, quantityDelivered: 20, quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'Site 1', status: 'delivered', weighInWeight: 43.1, weighOutWeight: 19.8, netWeight: 23.3, weighInAt: '2025-06-17T07:00:00Z', weighOutAt: '2025-06-17T08:20:00Z', deliveredAt: '2025-06-17T10:15:00Z', receivedAt: '2025-06-17T10:15:00Z', receivedBy: 'Anna Site', createdBy: 'u1', createdAt: '2025-06-16T10:00:00Z', updatedAt: '2025-06-17T10:15:00Z' },
  { id: 'do6', jobId: 'JOB-2025-0006', purchaseOrderId: 'po1', poNumber: 'PO-2025-001', vendorId: 'v1', vendorName: 'Mwangi Transport Ltd', driverId: 'd2', driverName: 'Sarah Wanjiku', vehicleId: 't2', plateNumber: 'KCB 456B', materialId: 'm1', materialName: 'Ballast 3/4"', quantityOrdered: 20, quantityDelivered: 20, quarryId: 'q1', quarryName: 'Kisumu Quarry', siteId: 's1', siteName: 'Site 1', status: 'delivered', weighInWeight: 39.8, weighOutWeight: 17.9, netWeight: 21.9, weighInAt: '2025-06-15T08:00:00Z', weighOutAt: '2025-06-15T09:10:00Z', deliveredAt: '2025-06-15T11:00:00Z', receivedAt: '2025-06-15T11:00:00Z', receivedBy: 'Anna Site', createdBy: 'u1', createdAt: '2025-06-14T10:00:00Z', updatedAt: '2025-06-15T11:00:00Z' },
  { id: 'do7', jobId: 'JOB-2025-0007', purchaseOrderId: 'po6', poNumber: 'PO-2025-006', vendorId: 'v4', vendorName: 'Njoroge Heavy Haulage', driverId: 'd8', driverName: 'Esther Chebet', vehicleId: 't6', plateNumber: 'KCF 678F', materialId: 'm4', materialName: 'Sand (Quarry)', quantityOrdered: 30, quantityDelivered: 0, quarryId: 'q4', quarryName: 'Nairobi Quarry', siteId: 's1', siteName: 'Site 1', status: 'at_quarry', weighInWeight: 45.2, weighInAt: '2025-06-25T07:30:00Z', weighInLocation: 'Nairobi Quarry Gate', createdBy: 'u1', createdAt: '2025-06-24T10:00:00Z', updatedAt: '2025-06-25T07:30:00Z' },
  { id: 'do8', jobId: 'JOB-2025-0008', purchaseOrderId: 'po6', poNumber: 'PO-2025-006', vendorId: 'v4', vendorName: 'Njoroge Heavy Haulage', driverId: 'd9', driverName: 'Samuel Maina', vehicleId: 't7', plateNumber: 'KCG 901G', materialId: 'm4', materialName: 'Sand (Quarry)', quantityOrdered: 30, quantityDelivered: 0, quarryId: 'q4', quarryName: 'Nairobi Quarry', siteId: 's1', siteName: 'Site 1', status: 'in_transit', weighInWeight: 41.5, weighOutWeight: 18.2, netWeight: 23.3, weighInAt: '2025-06-25T08:00:00Z', weighOutAt: '2025-06-25T09:00:00Z', weighInLocation: 'Nairobi Quarry Gate', weighOutLocation: 'Nairobi Quarry Exit', createdBy: 'u1', createdAt: '2025-06-24T10:00:00Z', updatedAt: '2025-06-25T09:00:00Z' },
  { id: 'do9', jobId: 'JOB-2025-0009', purchaseOrderId: 'po6', poNumber: 'PO-2025-006', vendorId: 'v4', vendorName: 'Njoroge Heavy Haulage', driverId: 'd10', driverName: 'Faith Wambui', vehicleId: 't8', plateNumber: 'KCH 234H', materialId: 'm4', materialName: 'Sand (Quarry)', quantityOrdered: 30, quantityDelivered: 0, quarryId: 'q4', quarryName: 'Nairobi Quarry', siteId: 's1', siteName: 'Site 1', status: 'assigned', createdBy: 'u1', createdAt: '2025-06-24T11:00:00Z', updatedAt: '2025-06-24T11:00:00Z' },
];

const weighRecords = [
  { id: 'w1', deliveryOrderId: 'do1', jobId: 'JOB-2025-0001', type: 'weigh_in', weight: 42.5, unit: 'tonnes', location: 'Kisumu Quarry Gate', latitude: -0.0917, longitude: 34.7680, operatorId: 'op1', operatorName: 'Peter Quarry', notes: 'Truck loaded with ballast', timestamp: '2025-06-20T08:30:00Z' },
  { id: 'w2', deliveryOrderId: 'do2', jobId: 'JOB-2025-0002', type: 'weigh_in', weight: 40.2, unit: 'tonnes', location: 'Kisumu Quarry Gate', latitude: -0.0917, longitude: 34.7680, operatorId: 'op1', operatorName: 'Peter Quarry', notes: '', timestamp: '2025-06-19T08:00:00Z' },
  { id: 'w3', deliveryOrderId: 'do2', jobId: 'JOB-2025-0002', type: 'weigh_out', weight: 18.5, unit: 'tonnes', location: 'Kisumu Quarry Exit', latitude: -0.0918, longitude: 34.7682, operatorId: 'op1', operatorName: 'Peter Quarry', notes: 'Net: 21.7 tonnes', timestamp: '2025-06-19T09:15:00Z' },
  { id: 'w4', deliveryOrderId: 'do4', jobId: 'JOB-2025-0004', type: 'weigh_in', weight: 44.0, unit: 'tonnes', location: 'Kisumu Quarry Gate', latitude: -0.0917, longitude: 34.7680, operatorId: 'op1', operatorName: 'Peter Quarry', notes: '', timestamp: '2025-06-05T07:00:00Z' },
  { id: 'w5', deliveryOrderId: 'do4', jobId: 'JOB-2025-0004', type: 'weigh_out', weight: 22.3, unit: 'tonnes', location: 'Kisumu Quarry Exit', latitude: -0.0918, longitude: 34.7682, operatorId: 'op1', operatorName: 'Peter Quarry', notes: 'Net: 21.7 tonnes', timestamp: '2025-06-05T08:30:00Z' },
  { id: 'w6', deliveryOrderId: 'do5', jobId: 'JOB-2025-0005', type: 'weigh_in', weight: 43.1, unit: 'tonnes', location: 'Kisumu Quarry Gate', latitude: -0.0917, longitude: 34.7680, operatorId: 'op1', operatorName: 'Peter Quarry', notes: '', timestamp: '2025-06-17T07:00:00Z' },
  { id: 'w7', deliveryOrderId: 'do5', jobId: 'JOB-2025-0005', type: 'weigh_out', weight: 19.8, unit: 'tonnes', location: 'Kisumu Quarry Exit', latitude: -0.0918, longitude: 34.7682, operatorId: 'op1', operatorName: 'Peter Quarry', notes: 'Net: 23.3 tonnes', timestamp: '2025-06-17T08:20:00Z' },
  { id: 'w8', deliveryOrderId: 'do6', jobId: 'JOB-2025-0006', type: 'weigh_in', weight: 39.8, unit: 'tonnes', location: 'Kisumu Quarry Gate', latitude: -0.0917, longitude: 34.7680, operatorId: 'op1', operatorName: 'Peter Quarry', notes: '', timestamp: '2025-06-15T08:00:00Z' },
  { id: 'w9', deliveryOrderId: 'do6', jobId: 'JOB-2025-0006', type: 'weigh_out', weight: 17.9, unit: 'tonnes', location: 'Kisumu Quarry Exit', latitude: -0.0918, longitude: 34.7682, operatorId: 'op1', operatorName: 'Peter Quarry', notes: 'Net: 21.9 tonnes', timestamp: '2025-06-15T09:10:00Z' },
  { id: 'w10', deliveryOrderId: 'do7', jobId: 'JOB-2025-0007', type: 'weigh_in', weight: 45.2, unit: 'tonnes', location: 'Nairobi Quarry Gate', latitude: -1.2156, longitude: 36.8956, operatorId: 'op2', operatorName: 'Quarry Op 2', notes: '', timestamp: '2025-06-25T07:30:00Z' },
  { id: 'w11', deliveryOrderId: 'do8', jobId: 'JOB-2025-0008', type: 'weigh_in', weight: 41.5, unit: 'tonnes', location: 'Nairobi Quarry Gate', latitude: -1.2156, longitude: 36.8956, operatorId: 'op2', operatorName: 'Quarry Op 2', notes: '', timestamp: '2025-06-25T08:00:00Z' },
  { id: 'w12', deliveryOrderId: 'do8', jobId: 'JOB-2025-0008', type: 'weigh_out', weight: 18.2, unit: 'tonnes', location: 'Nairobi Quarry Exit', latitude: -1.2157, longitude: 36.8958, operatorId: 'op2', operatorName: 'Quarry Op 2', notes: 'Net: 23.3 tonnes', timestamp: '2025-06-25T09:00:00Z' },
];

// Users data
const users = [
  { id: 'u1', email: 'admin@trucksphere.com', displayName: 'James Admin', role: 'management', phone: '+254700000001', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'u2', email: 'quarry@trucksphere.com', displayName: 'Peter Quarry', role: 'operator_quarry', phone: '+254700000002', quarryId: 'q1', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'u3', email: 'site@trucksphere.com', displayName: 'Anna Site', role: 'operator_site', phone: '+254700000003', siteId: 's1', createdAt: '2025-01-01T08:00:00Z' },
  { id: 'u4', email: 'vendor@trucksphere.com', displayName: 'John Vendor', role: 'vendor', phone: '+254700000004', vendorId: 'v1', createdAt: '2025-01-01T08:00:00Z' },
];

// ============================================================
// SEED FUNCTION
// ============================================================

async function seed() {
  console.log('🌱 Seeding TruckSphere Firebase with sample data...\n');

  const collections = [
    { name: 'vendors', data: vendors },
    { name: 'drivers', data: drivers },
    { name: 'vehicles', data: vehicles },
    { name: 'materials', data: materials },
    { name: 'quarries', data: quarries },
    { name: 'sites', data: sites },
    { name: 'purchaseOrders', data: purchaseOrders },
    { name: 'deliveryOrders', data: deliveryOrders },
    { name: 'weighRecords', data: weighRecords },
    { name: 'users', data: users },
  ];

  let total = 0;

  for (const collection of collections) {
    const batch = db.batch();
    const collectionRef = db.collection(collection.name);

    for (const item of collection.data) {
      const docRef = collectionRef.doc(item.id);
      batch.set(docRef, item);
    }

    try {
      await batch.commit();
      total += collection.data.length;
      console.log(`  ✅ ${collection.name}: ${collection.data.length} documents`);
    } catch (error) {
      console.error(`  ❌ ${collection.name}: Failed - ${error.message}`);
    }
  }

  console.log(`\n🎉 Seeding complete! ${total} total documents written to Firestore.`);
  process.exit(0);
}

seed().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});
