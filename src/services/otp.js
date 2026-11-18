'use strict';
const db = require('../db');
const clock = require('../lib/clock');
const config = require('../config');
const { uid, sha256, randomDigits, safeEqual } = require('../lib/crypto');
const { bad, AppError } = require('../lib/errors');
const { t } = require('../lib/i18n');
const notifier = require('./notifier');

// Issue a one-time code. Returns the plain code only so dev mode can surface it.
function issue({ userId = null, destination, purpose, language = 'en' }) {
  const recent = db.get(
    'SELECT COUNT(*) AS n FROM otp_codes WHERE destination = ? AND purpose = ? AND created_at >= ?',
    destination, purpose, new Date(clock.now().getTime() - 60 * 60_000).toISOString(),
  ).n;
  if (recent >= 5) throw new AppError(429, 'otp_rate_limited', 'Too many codes requested. Try again later.');

  // Invalidate any earlier unused code for the same purpose.
  db.run('UPDATE otp_codes SET consumed_at = ? WHERE destination = ? AND purpose = ? AND consumed_at IS NULL',
    clock.iso(), destination, purpose);

  const code = randomDigits(6);
  db.insert('otp_codes', {
    id: uid(), user_id: userId, destination, purpose, code_hash: sha256(`${destination}:${purpose}:${code}`),
    attempts: 0, expires_at: new Date(clock.now().getTime() + config.otpTtlMinutes * 60_000).toISOString(),
    consumed_at: null, created_at: clock.iso(),
  });
  const message = t(language, 'otp', { code, minutes: config.otpTtlMinutes });
  if (destination.includes('@')) notifier.email(destination, message);
  else notifier.sms(destination, message);
  return code;
}

function verify({ destination, purpose, code }) {
  const row = db.get(
    `SELECT * FROM otp_codes WHERE destination = ? AND purpose = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`, destination, purpose,
  );
  if (!row || row.expires_at < clock.iso()) throw bad('otp_invalid', 'The code is invalid or has expired');
  if (row.attempts >= config.otpMaxAttempts) throw bad('otp_locked', 'Too many wrong attempts. Request a new code.');
  if (!safeEqual(row.code_hash, sha256(`${destination}:${purpose}:${code}`))) {
    db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    throw bad('otp_invalid', 'The code is invalid or has expired');
  }
  db.run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', clock.iso(), row.id);
  return row;
}

module.exports = { issue, verify };
