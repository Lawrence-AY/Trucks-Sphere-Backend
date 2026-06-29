const jwt = require('jsonwebtoken');
const { User, Role, Permission } = require('../database/models');
const ApiError = require('../shared/apiError');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_trucksphere_access_secret';

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(401, 'Authentication token required', 'AUTH_REQUIRED');
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(payload.sub, {
      include: [{ model: Role, include: [Permission] }],
    });

    if (!user || user.status !== 'active') {
      throw new ApiError(401, 'Invalid or inactive user', 'AUTH_INVALID_USER');
    }

    req.user = user;
    req.auth = {
      userId: user.id,
      role: user.Role?.name,
      permissions: user.Role?.Permissions?.map((permission) => permission.name) || [],
    };
    next();
  } catch (error) {
    next(error.statusCode ? error : new ApiError(401, 'Invalid authentication token', 'AUTH_INVALID_TOKEN'));
  }
}

function authorize(...permissions) {
  return (req, res, next) => {
    if (!permissions.length) return next();
    const userPermissions = req.auth?.permissions || [];
    const allowed = permissions.some((permission) => userPermissions.includes(permission));
    if (!allowed) {
      return next(new ApiError(403, 'Insufficient permission', 'FORBIDDEN'));
    }
    return next();
  };
}

module.exports = { authenticate, authorize };
