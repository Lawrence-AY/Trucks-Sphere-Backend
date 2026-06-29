const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const asyncHandler = require('../../shared/asyncHandler');
const ApiError = require('../../shared/apiError');
const { ok, created } = require('../../shared/response');
const { User, Role, UserProfile, RefreshToken } = require('../../database/models');
const { authenticate } = require('../../middleware/v1AuthMiddleware');
const { writeAudit } = require('../../services/auditService');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_trucksphere_access_secret';
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev_trucksphere_refresh_secret';

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, REFRESH_SECRET, { expiresIn: process.env.REFRESH_EXPIRES_IN || '7d' });
}

function sanitizeUser(user) {
  const json = user.toJSON ? user.toJSON() : user;
  delete json.passwordHash;
  return json;
}

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password, rememberMe } = req.body;
  if (!username || !password) throw new ApiError(400, 'Username and password are required', 'VALIDATION_ERROR');

  const user = await User.findOne({ where: { username: String(username).toLowerCase() }, include: [Role, UserProfile] });
  if (!user || user.status !== 'active') throw new ApiError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + (rememberMe ? 30 : 7) * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user_id: user.id, tokenHash, expiresAt });
  await user.update({ lastLoginAt: new Date() });
  await writeAudit({ req, userId: user.id, action: 'user.login', entityType: 'user', entityId: user.id });

  return ok(res, { user: sanitizeUser(user), accessToken, refreshToken });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ApiError(400, 'Refresh token is required', 'VALIDATION_ERROR');
  const payload = jwt.verify(refreshToken, REFRESH_SECRET);
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const stored = await RefreshToken.findOne({ where: { tokenHash, revokedAt: null } });
  if (!stored || stored.expiresAt < new Date()) throw new ApiError(401, 'Refresh token is invalid or expired', 'AUTH_INVALID_REFRESH');
  const user = await User.findByPk(payload.sub, { include: [Role, UserProfile] });
  return ok(res, { user: sanitizeUser(user), accessToken: signAccessToken(user) });
}));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await RefreshToken.update({ revokedAt: new Date() }, { where: { tokenHash } });
  }
  await writeAudit({ req, action: 'user.logout', entityType: 'user', entityId: req.auth.userId });
  return ok(res, { loggedOut: true });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.auth.userId, { include: [Role, UserProfile] });
  return ok(res, sanitizeUser(user));
}));

router.post('/complete-profile', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.auth.userId);
  await UserProfile.upsert({ user_id: user.id, ...req.body });
  await user.update({ mustCompleteProfile: false });
  await writeAudit({ req, action: 'user.profile_completed', entityType: 'user', entityId: user.id });
  return ok(res, { completed: true });
}));

router.post('/users', authenticate, asyncHandler(async (req, res) => {
  const admin = await User.findByPk(req.auth.userId, { include: [Role] });
  if (admin.Role?.name !== 'administrator') throw new ApiError(403, 'Only administrators can create users', 'FORBIDDEN');
  const role = await Role.findOne({ where: { name: req.body.role || 'operator' } });
  if (!role) throw new ApiError(400, 'Invalid role', 'VALIDATION_ERROR');
  const passwordHash = await bcrypt.hash(req.body.password || 'ChangeMe123', 12);
  const user = await User.create({
    username: String(req.body.username).toLowerCase(),
    email: req.body.email,
    fullName: req.body.fullName,
    phone: req.body.phone,
    passwordHash,
    role_id: role.id,
  });
  await UserProfile.create({ user_id: user.id, department: req.body.department, position: req.body.position });
  await writeAudit({ req, action: 'user.created', entityType: 'user', entityId: user.id });
  return created(res, sanitizeUser(user));
}));

module.exports = router;
