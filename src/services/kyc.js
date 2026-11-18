'use strict';
// KYC verification. Providers (Smile Identity, VerifyMe, Prembly, Paystack identity) plug in behind
// `verify()`. The mock provider auto-verifies well-formed numbers and rejects numbers ending in 0000
// so both paths can be exercised in development.
const db = require('../db');
const clock = require('../lib/clock');
const { uid, encrypt } = require('../lib/crypto');
const { bad, conflict, notFound } = require('../lib/errors');
const config = require('../config');
const audit = require('./audit');
const { notify } = require('./notifications');

const FORMATS = {
  NIN: /^\d{11}$/,
  BVN: /^\d{11}$/,
  PASSPORT: /^[A-Z]\d{8}$/i,
  DRIVERS_LICENSE: /^[A-Z0-9]{8,18}$/i,
  VOTERS_CARD: /^[A-Z0-9]{19}$/i,
};

const providers = {
  mock: {
    async verify({ idNumber }) {
      if (idNumber.endsWith('0000')) return { status: 'rejected', reason: 'ID number could not be matched', ref: null };
      return { status: 'verified', ref: `mock_kyc_${Date.now()}` };
    },
  },
  // Placeholder for a manual back-office review queue: everything goes to pending.
  manual: { async verify() { return { status: 'pending', ref: null }; } },
};

async function submit(userId, { idType, idNumber, dateOfBirth }) {
  const fmt = FORMATS[idType];
  if (!fmt) throw bad('invalid_id_type', `ID type must be one of ${Object.keys(FORMATS).join(', ')}`);
  if (!fmt.test(idNumber)) throw bad('invalid_id_number', `That does not look like a valid ${idType}`);
  const user = db.get('SELECT kyc_status FROM users WHERE id = ?', userId);
  if (user.kyc_status === 'verified') throw conflict('already_verified', 'Your identity is already verified');

  const provider = providers[config.kycProvider] || providers.mock;
  const result = await provider.verify({ idType, idNumber, dateOfBirth, userId });

  const rec = {
    id: uid(), user_id: userId, id_type: idType, id_number_enc: encrypt(idNumber), id_last4: idNumber.slice(-4),
    date_of_birth: dateOfBirth || null, provider: config.kycProvider, provider_ref: result.ref,
    status: result.status, reason: result.reason || null, created_at: clock.iso(),
    reviewed_at: result.status === 'pending' ? null : clock.iso(),
  };
  db.tx(() => {
    db.insert('kyc_records', rec);
    applyResult(userId, idType, result.status, result.reason);
  });
  audit.record('kyc.submitted', { actorId: userId, entityType: 'user', entityId: userId, data: { idType, status: result.status } });
  return publicRecord(rec);
}

function applyResult(userId, idType, status, reason) {
  // BVN verification grants tier 2 (it is tied to a bank-verified identity); other IDs grant tier 1.
  const tier = status === 'verified' ? (idType === 'BVN' ? 2 : 1) : undefined;
  const fields = { kyc_status: status };
  if (tier !== undefined) {
    const cur = db.get('SELECT kyc_tier FROM users WHERE id = ?', userId).kyc_tier;
    fields.kyc_tier = Math.max(cur, tier);
  }
  db.update('users', userId, fields);
  if (status === 'verified') notify(userId, 'kyc_verified', 'kyc_verified');
  if (status === 'rejected') notify(userId, 'kyc_rejected', 'kyc_rejected', { reason: reason || 'unknown' });
}

// Back-office decision for records left pending (manual provider or provider callbacks).
function review(recordId, reviewerId, { status, reason }) {
  const rec = db.get('SELECT * FROM kyc_records WHERE id = ?', recordId);
  if (!rec) throw notFound('KYC record');
  if (rec.status !== 'pending') throw conflict('already_reviewed', 'This record has already been reviewed');
  db.tx(() => {
    db.update('kyc_records', recordId, { status, reason: reason || null, reviewed_at: clock.iso() });
    applyResult(rec.user_id, rec.id_type, status, reason);
  });
  audit.record('kyc.reviewed', { actorId: reviewerId, entityType: 'kyc_record', entityId: recordId, data: { status } });
}

const publicRecord = (r) => ({
  id: r.id, idType: r.id_type, idLast4: r.id_last4, status: r.status, reason: r.reason, createdAt: r.created_at,
});

const history = (userId) =>
  db.all('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY created_at DESC', userId).map(publicRecord);

const pending = () =>
  db.all(`SELECT k.*, u.full_name FROM kyc_records k JOIN users u ON u.id = k.user_id WHERE k.status = 'pending' ORDER BY k.created_at`)
    .map((r) => ({ ...publicRecord(r), userId: r.user_id, fullName: r.full_name }));

module.exports = { submit, review, history, pending, FORMATS };
