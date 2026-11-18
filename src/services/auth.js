'use strict';
const jwt = require('jsonwebtoken');
const db = require('../db');
const clock = require('../lib/clock');
const config = require('../config');
const {
  uid, sha256, randomToken, randomCode, hashPassword, verifyPassword, encrypt, decrypt,
  generateTotpSecret, verifyTotp,
} = require('../lib/crypto');
const { bad, unauthorized, conflict, forbidden } = require('../lib/errors');
const otp = require('./otp');
const audit = require('./audit');
const ledger = require('./ledger');
const fraud = require('./fraud');

// Normalise Nigerian numbers to E.164 (+234...). Other international numbers must already be E.164.
function normalizePhone(raw) {
  const p = String(raw || '').replace(/[\s()-]/g, '');
  if (/^\+\d{10,15}$/.test(p)) return p;
  if (/^0[789][01]\d{8}$/.test(p)) return `+234${p.slice(1)}`;
  if (/^234\d{10}$/.test(p)) return `+${p}`;
  throw bad('invalid_phone', 'Enter a valid phone number, e.g. 08012345678 or +2348012345678');
}

function findByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (id.includes('@')) return db.get('SELECT * FROM users WHERE email = ?', id.toLowerCase());
  let phone;
  try { phone = normalizePhone(id); } catch { return undefined; }
  return db.get('SELECT * FROM users WHERE phone = ?', phone);
}

function uniqueReferralCode() {
  for (;;) {
    const code = randomCode(7);
    if (!db.get('SELECT 1 FROM users WHERE referral_code = ?', code)) return code;
  }
}

function register({ fullName, phone, email, password, referralCode, language = 'en' }) {
  const normPhone = normalizePhone(phone);
  const normEmail = email ? String(email).trim().toLowerCase() : null;
  if (db.get('SELECT 1 FROM users WHERE phone = ?', normPhone)) throw conflict('phone_taken', 'This phone number is already registered');
  if (normEmail && db.get('SELECT 1 FROM users WHERE email = ?', normEmail)) throw conflict('email_taken', 'This email is already registered');

  let referrer = null;
  if (referralCode) {
    referrer = db.get('SELECT id FROM users WHERE referral_code = ?', String(referralCode).toUpperCase());
    if (!referrer) throw bad('invalid_referral', 'Referral code not found');
  }

  const user = {
    id: uid(), full_name: fullName.trim(), email: normEmail, phone: normPhone, password_hash: hashPassword(password),
    phone_verified: 0, email_verified: 0, mfa_enabled: 0, mfa_secret_enc: null, kyc_status: 'none', kyc_tier: 0,
    role: 'user', status: 'active', referral_code: uniqueReferralCode(), referred_by: referrer ? referrer.id : null,
    referral_points: 0, language, display_currency: 'NGN', ussd_pin_hash: null, auto_withdraw: 0,
    default_bank_account_id: null, created_at: clock.iso(),
  };
  db.tx(() => {
    db.insert('users', user);
    ledger.userAccount(user.id);
  });
  const code = otp.issue({ userId: user.id, destination: normPhone, purpose: 'verify_phone', language });
  audit.record('user.registered', { actorId: user.id, entityType: 'user', entityId: user.id, data: { referredBy: user.referred_by } });
  return { user, devOtp: config.exposeDevOtp ? code : undefined };
}

function verifyPhone({ phone, code }) {
  const normPhone = normalizePhone(phone);
  otp.verify({ destination: normPhone, purpose: 'verify_phone', code });
  db.run('UPDATE users SET phone_verified = 1 WHERE phone = ?', normPhone);
  const user = db.get('SELECT * FROM users WHERE phone = ?', normPhone);
  audit.record('user.phone_verified', { actorId: user.id, entityType: 'user', entityId: user.id });
  return user;
}

function resendVerification({ phone }) {
  const user = db.get('SELECT * FROM users WHERE phone = ?', normalizePhone(phone));
  if (!user || user.phone_verified) return {}; // don't reveal account state
  const code = otp.issue({ userId: user.id, destination: user.phone, purpose: 'verify_phone', language: user.language });
  return { devOtp: config.exposeDevOtp ? code : undefined };
}

function issueTokens(user, deviceId) {
  const accessToken = jwt.sign({ sub: user.id, role: user.role, typ: 'access' }, config.jwtSecret, { expiresIn: config.accessTokenTtl });
  const refreshToken = randomToken(48);
  db.insert('refresh_tokens', {
    id: uid(), user_id: user.id, token_hash: sha256(refreshToken), device_id: deviceId || null,
    expires_at: new Date(clock.now().getTime() + config.refreshTokenTtlDays * 86_400_000).toISOString(),
    revoked_at: null, created_at: clock.iso(),
  });
  fraud.trackDevice(user.id, deviceId);
  return { accessToken, refreshToken };
}

// Step 1 of login. Returns tokens, or an MFA challenge when MFA is enabled.
function login({ identifier, password, deviceId, ip }) {
  const user = findByIdentifier(identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit.record('auth.login_failed', { entityType: 'user', entityId: user ? user.id : null, ip });
    throw unauthorized('Incorrect phone/email or password');
  }
  if (user.status !== 'active') throw forbidden('This account is suspended. Contact support.');
  if (!user.phone_verified) {
    throw Object.assign(forbidden('Verify your phone number first'), { code: 'phone_not_verified' });
  }
  if (user.mfa_enabled) {
    const mfaToken = jwt.sign({ sub: user.id, typ: 'mfa' }, config.jwtSecret, { expiresIn: '5m' });
    return { mfaRequired: true, mfaToken, methods: ['totp', 'sms'] };
  }
  audit.record('auth.login', { actorId: user.id, entityType: 'user', entityId: user.id, ip });
  return { user, ...issueTokens(user, deviceId) };
}

function decodeMfaToken(mfaToken) {
  try {
    const p = jwt.verify(mfaToken, config.jwtSecret);
    if (p.typ !== 'mfa') throw new Error('wrong type');
    return db.get('SELECT * FROM users WHERE id = ?', p.sub);
  } catch {
    throw unauthorized('MFA session expired. Log in again.');
  }
}

function sendMfaSms({ mfaToken }) {
  const user = decodeMfaToken(mfaToken);
  const code = otp.issue({ userId: user.id, destination: user.phone, purpose: 'mfa', language: user.language });
  return { devOtp: config.exposeDevOtp ? code : undefined };
}

// Step 2 of login: TOTP code from an authenticator app, or an SMS code from sendMfaSms.
function completeMfa({ mfaToken, code, method = 'totp', deviceId, ip }) {
  const user = decodeMfaToken(mfaToken);
  if (method === 'sms') {
    otp.verify({ destination: user.phone, purpose: 'mfa', code });
  } else if (!verifyTotp(decrypt(user.mfa_secret_enc), code, clock.now().getTime())) {
    audit.record('auth.mfa_failed', { actorId: user.id, entityType: 'user', entityId: user.id, ip });
    throw unauthorized('Invalid authentication code');
  }
  audit.record('auth.login', { actorId: user.id, entityType: 'user', entityId: user.id, ip, data: { mfa: method } });
  return { user, ...issueTokens(user, deviceId) };
}

function refresh({ refreshToken, deviceId }) {
  const row = db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(refreshToken || ''));
  if (!row || row.revoked_at || row.expires_at < clock.iso()) throw unauthorized('Session expired. Log in again.');
  // Rotation: each refresh token is single-use.
  db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', clock.iso(), row.id);
  const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (user.status !== 'active') throw forbidden('This account is suspended');
  return { user, ...issueTokens(user, deviceId || row.device_id) };
}

function logout({ refreshToken }) {
  db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', clock.iso(), sha256(refreshToken || ''));
}

function verifyAccessToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    if (p.typ !== 'access') throw new Error('wrong type');
    return p;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

// --- MFA management ---
function beginMfaSetup(userId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (user.mfa_enabled) throw conflict('mfa_already_enabled', 'MFA is already enabled');
  const secret = generateTotpSecret();
  db.update('users', userId, { mfa_secret_enc: encrypt(secret) });
  const label = encodeURIComponent(`AdashiFunds:${user.email || user.phone}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=AdashiFunds&digits=6&period=30` };
}

function enableMfa(userId, code) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user.mfa_secret_enc) throw bad('mfa_not_started', 'Start MFA setup first');
  if (!verifyTotp(decrypt(user.mfa_secret_enc), code, clock.now().getTime())) throw bad('invalid_code', 'Invalid authentication code');
  db.update('users', userId, { mfa_enabled: 1 });
  audit.record('auth.mfa_enabled', { actorId: userId, entityType: 'user', entityId: userId });
}

function disableMfa(userId, { password, code }) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!verifyPassword(password, user.password_hash)) throw unauthorized('Incorrect password');
  if (!verifyTotp(decrypt(user.mfa_secret_enc), code, clock.now().getTime())) throw bad('invalid_code', 'Invalid authentication code');
  db.update('users', userId, { mfa_enabled: 0, mfa_secret_enc: null });
  audit.record('auth.mfa_disabled', { actorId: userId, entityType: 'user', entityId: userId });
}

// --- Password reset ---
function requestPasswordReset({ identifier }) {
  const user = findByIdentifier(identifier);
  if (!user) return {}; // don't reveal whether an account exists
  const code = otp.issue({ userId: user.id, destination: user.phone, purpose: 'reset_password', language: user.language });
  return { devOtp: config.exposeDevOtp ? code : undefined };
}

function resetPassword({ identifier, code, newPassword }) {
  const user = findByIdentifier(identifier);
  if (!user) throw bad('otp_invalid', 'The code is invalid or has expired');
  otp.verify({ destination: user.phone, purpose: 'reset_password', code });
  db.tx(() => {
    db.update('users', user.id, { password_hash: hashPassword(newPassword) });
    db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', clock.iso(), user.id);
  });
  audit.record('auth.password_reset', { actorId: user.id, entityType: 'user', entityId: user.id });
}

function changePassword(userId, { currentPassword, newPassword }) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!verifyPassword(currentPassword, user.password_hash)) throw unauthorized('Incorrect current password');
  db.update('users', userId, { password_hash: hashPassword(newPassword) });
  audit.record('auth.password_changed', { actorId: userId, entityType: 'user', entityId: userId });
}

function setUssdPin(userId, { password, pin }) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!verifyPassword(password, user.password_hash)) throw unauthorized('Incorrect password');
  if (!/^\d{4}$/.test(pin)) throw bad('invalid_pin', 'PIN must be 4 digits');
  db.update('users', userId, { ussd_pin_hash: hashPassword(pin) });
  audit.record('auth.ussd_pin_set', { actorId: userId, entityType: 'user', entityId: userId });
}

module.exports = {
  normalizePhone, findByIdentifier, register, verifyPhone, resendVerification, login, sendMfaSms, completeMfa,
  refresh, logout, verifyAccessToken, beginMfaSetup, enableMfa, disableMfa, requestPasswordReset, resetPassword,
  changePassword, setUssdPin, issueTokens,
};
