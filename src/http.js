'use strict';
const { z } = require('zod');
const db = require('./db');
const auth = require('./services/auth');
const { AppError, unauthorized, forbidden } = require('./lib/errors');

function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  const payload = auth.verifyAccessToken(token);
  const user = db.get('SELECT * FROM users WHERE id = ?', payload.sub);
  if (!user) return next(unauthorized());
  if (user.status !== 'active') return next(forbidden('This account is suspended'));
  req.user = user;
  req.deviceId = req.get('x-device-id') || null;
  next();
}

function requirePlatformAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') return next(forbidden('Platform admin only'));
  next();
}

// Validate req.body / req.query with a zod schema; parsed values replace the originals.
const validate = (schema, where = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[where] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new AppError(400, 'validation_error', details.map((d) => `${d.path || 'input'}: ${d.message}`).join('; '), details));
  }
  if (where === 'query') req.validQuery = result.data;
  else req.body = result.data;
  next();
};

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError || (err.status && err.code)) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
}

const publicUser = (u) => ({
  id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, phoneVerified: !!u.phone_verified,
  mfaEnabled: !!u.mfa_enabled, kycStatus: u.kyc_status, kycTier: u.kyc_tier, role: u.role, referralCode: u.referral_code,
  referralPoints: u.referral_points, language: u.language, displayCurrency: u.display_currency,
  hasUssdPin: !!u.ussd_pin_hash, autoWithdraw: !!u.auto_withdraw, defaultBankAccountId: u.default_bank_account_id,
  createdAt: u.created_at,
});

// Shared schema pieces. Amounts in the API are integer kobo.
const kobo = z.number().int().positive().max(100_000_000_00);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter').regex(/\d/, 'Password must contain a number');
const id = z.string().min(1).max(100);

module.exports = { authenticate, requirePlatformAdmin, validate, errorHandler, publicUser, z, kobo, password, id };
