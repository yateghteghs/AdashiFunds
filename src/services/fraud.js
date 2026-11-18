'use strict';
// Rule-based risk engine. Each rule returns a score (0-100) and reason; the highest score decides:
//   >= 80 -> block the transaction, >= 50 -> allow but flag for review.
// The rules generate labelled data (flags confirmed/cleared by reviewers) that can later train an
// ML model; the `assess` interface stays the same when a model replaces or augments these rules.
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');
const { AppError } = require('../lib/errors');
const audit = require('./audit');

const BLOCK = 80;
const FLAG = 50;

const minutesAgo = (m) => new Date(clock.now().getTime() - m * 60_000).toISOString();

const OUTFLOW = "('transfer','withdrawal')";

const rules = {
  // Many outgoing transfers/withdrawals in a short window.
  velocity({ userId }) {
    const n = db.get(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND type IN ${OUTFLOW} AND created_at >= ?`,
      userId, minutesAgo(10)).n;
    if (n >= 10) return { score: 90, reason: `${n} outgoing transactions in 10 minutes` };
    if (n >= 5) return { score: 60, reason: `${n} outgoing transactions in 10 minutes` };
    return null;
  },
  // Amount far above the user's normal outflow.
  unusualAmount({ userId, amount }) {
    const row = db.get(`SELECT AVG(amount) AS avg, COUNT(*) AS n FROM transactions WHERE user_id = ? AND type IN ${OUTFLOW} AND status = 'success'`, userId);
    if (row.n >= 3 && amount > row.avg * 10 && amount > 100_000_00) {
      return { score: 60, reason: `Amount is ${Math.round(amount / row.avg)}x the user's average` };
    }
    return null;
  },
  // Large withdrawal from a brand-new account.
  newAccountLargeOutflow({ userId, amount, type }) {
    if (type !== 'withdrawal') return null;
    const u = db.get('SELECT created_at FROM users WHERE id = ?', userId);
    if (u && u.created_at >= minutesAgo(24 * 60) && amount >= 100_000_00) {
      return { score: 70, reason: 'Large withdrawal within 24h of sign-up' };
    }
    return null;
  },
  // Money deposited and immediately withdrawn (possible mule / laundering pattern).
  passThrough({ userId, amount, type }) {
    if (type !== 'withdrawal') return null;
    const dep = db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE (user_id = ? AND type = 'deposit' OR counterparty_user_id = ? AND type = 'transfer') AND status = 'success' AND created_at >= ?`,
      userId, userId, minutesAgo(60)).s;
    if (dep > 0 && amount >= dep * 0.9 && amount >= 50_000_00) {
      return { score: 65, reason: 'Funds withdrawn within an hour of being received' };
    }
    return null;
  },
  // Same device used by several accounts (multiple-account abuse).
  sharedDevice({ userId, deviceId }) {
    if (!deviceId) return null;
    const n = db.get('SELECT COUNT(DISTINCT user_id) AS n FROM devices WHERE device_id = ? AND user_id <> ?', deviceId, userId).n;
    if (n >= 3) return { score: 85, reason: `Device shared with ${n} other accounts` };
    if (n >= 1) return { score: 50, reason: `Device shared with ${n} other account(s)` };
    return null;
  },
};

function assess(ctx) {
  const hits = [];
  for (const [rule, fn] of Object.entries(rules)) {
    const r = fn(ctx);
    if (r) hits.push({ rule, ...r });
  }
  const top = hits.reduce((m, h) => (h.score > (m ? m.score : -1) ? h : m), null);
  return { score: top ? top.score : 0, hits, decision: !top ? 'allow' : top.score >= BLOCK ? 'block' : top.score >= FLAG ? 'flag' : 'allow' };
}

// Assess, persist flags, and throw if blocked. Call BEFORE moving money.
function guard(ctx) {
  const result = assess(ctx);
  if (result.decision === 'allow') return result;
  const action = result.decision === 'block' ? 'blocked' : 'flagged';
  for (const h of result.hits.filter((x) => x.score >= FLAG)) {
    db.insert('fraud_flags', {
      id: uid(), user_id: ctx.userId, transaction_id: ctx.reference || null, rule: h.rule, score: h.score,
      details: JSON.stringify({ reason: h.reason, amount: ctx.amount, type: ctx.type }), action,
      status: 'open', created_at: clock.iso(), reviewed_by: null, reviewed_at: null,
    });
  }
  audit.record(`fraud.${action}`, { actorId: ctx.userId, entityType: 'user', entityId: ctx.userId, data: { hits: result.hits, amount: ctx.amount, type: ctx.type } });
  if (result.decision === 'block') {
    require('./notifications').notify(ctx.userId, 'fraud_alert', 'fraud_alert', {}, { sms: true });
    throw new AppError(403, 'transaction_blocked', 'This transaction was blocked by our risk checks. Contact support if you believe this is a mistake.');
  }
  return result;
}

function trackDevice(userId, deviceId) {
  if (!deviceId) return;
  const now = clock.iso();
  const existing = db.get('SELECT 1 FROM devices WHERE device_id = ? AND user_id = ?', deviceId, userId);
  if (existing) db.run('UPDATE devices SET last_seen = ? WHERE device_id = ? AND user_id = ?', now, deviceId, userId);
  else db.insert('devices', { device_id: deviceId, user_id: userId, first_seen: now, last_seen: now });
}

function listFlags(status = 'open') {
  return db.all(`SELECT f.*, u.full_name, u.phone FROM fraud_flags f JOIN users u ON u.id = f.user_id
                 WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 200`, status)
    .map((f) => ({ ...f, details: f.details ? JSON.parse(f.details) : null }));
}

function reviewFlag(flagId, reviewerId, status) {
  db.update('fraud_flags', flagId, { status, reviewed_by: reviewerId, reviewed_at: clock.iso() });
  audit.record('fraud.reviewed', { actorId: reviewerId, entityType: 'fraud_flag', entityId: flagId, data: { status } });
}

module.exports = { assess, guard, trackDevice, listFlags, reviewFlag, rules };
