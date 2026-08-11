const { getAuth } = require('firebase-admin/auth');

const VALID_ROLES = ['management', 'operator_quarry', 'operator_site', 'vendor', 'operator_fuel', 'operator_warehouse'];

class AuthService {
  /**
   * Create a new Firebase Auth user with custom claims
   */
  async createUser(email, password, name, role = 'management') {
    if (!VALID_ROLES.includes(role)) {
      throw Object.assign(new Error(`Invalid role: ${role}`), { statusCode: 400 });
    }

    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName: name,
    });

    await getAuth().setCustomUserClaims(userRecord.uid, { role });

    return {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
      role,
    };
  }

  /**
   * Verify a Firebase ID token
   */
  async verifyToken(idToken) {
    const decoded = await getAuth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      role: decoded.role || 'management',
    };
  }

  /**
   * Get user by UID
   */
  async getUser(uid) {
    const userRecord = await getAuth().getUser(uid);
    return {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
      phone: userRecord.phoneNumber,
      role: userRecord.customClaims?.role || 'management',
    };
  }

  /**
   * List all users
   */
  async listUsers(maxResults = 100) {
    const listUsersResult = await getAuth().listUsers(maxResults);
    return listUsersResult.users.map(user => ({
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      role: user.customClaims?.role || 'management',
    }));
  }
}

module.exports = new AuthService();
