/**
 * TruckSphere Firebase Auth User Seed Script
 * 
 * Creates Firebase Authentication users with email/password and custom claims (roles).
 * These are the accounts used by the frontend app for login.
 * 
 * Usage:
 *   node scripts/seed-auth-users.js
 */

const { admin, auth } = require('../config/firebase');

// Firebase requires passwords to be at least 6 characters
const USERS = [
  { email: 'admin@truck.com',    password: '123456', displayName: 'James Admin',  role: 'management' },
  { email: 'quarry@truck.com',   password: '123456', displayName: 'Peter Quarry',  role: 'operator_quarry' },
  { email: 'site@truck.com',     password: '123456', displayName: 'Anna Site',     role: 'operator_site' },
  { email: 'vendor@truck.com',   password: '123456', displayName: 'John Vendor',   role: 'vendor' },
  { email: 'fuel@truck.com',     password: '123456', displayName: 'Mike Fuel',    role: 'operator_fuel' },
];

async function seedAuthUsers() {
  console.log('🌱 Seeding Firebase Auth users...\n');

  for (const user of USERS) {
    try {
      // Try to create the user
      const userRecord = await auth.createUser({
        email: user.email,
        password: user.password,
        displayName: user.displayName,
        emailVerified: true,
      });

      // Set custom claims for role-based access
      await auth.setCustomUserClaims(userRecord.uid, { role: user.role });

      console.log(`  ✅ Created: ${user.email} (${user.role}) — uid: ${userRecord.uid}`);
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        // User already exists — update their password and claims
        const existingUser = await auth.getUserByEmail(user.email);
        await auth.updateUser(existingUser.uid, {
          password: user.password,
          displayName: user.displayName,
          emailVerified: true,
        });
        await auth.setCustomUserClaims(existingUser.uid, { role: user.role });
        console.log(`  🔄 Updated: ${user.email} (${user.role}) — uid: ${existingUser.uid}`);
      } else if (err.code === 'auth/uid-already-exists') {
        console.log(`  ⚠️  Skipped: ${user.email} — UID already exists`);
      } else {
        console.error(`  ❌ Failed: ${user.email} — ${err.message}`);
      }
    }
  }

  console.log('\n🎉 Auth user seeding complete!');
  console.log('\n📋 Login credentials (password must be >= 6 chars for Firebase):');
  USERS.forEach(u => console.log(`   ${u.email} / ${u.password}  (${u.role})`));
  
  process.exit(0);
}

seedAuthUsers().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});