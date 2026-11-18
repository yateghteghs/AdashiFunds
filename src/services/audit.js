'use strict';
// Hash-chained, append-only audit log. Each record's hash covers its own content plus the previous
// record's hash, so editing or deleting any historical row breaks verification from that point on.
// This gives the "tamper-proof records" property without requiring a blockchain; the head hash can
// additionally be anchored to a public chain periodically (see docs/DEVELOPMENT.md).
const db = require('../db');
const clock = require('../lib/clock');
const { sha256 } = require('../lib/crypto');

const GENESIS = '0'.repeat(64);

function digest(r) {
  return sha256(JSON.stringify([r.prev_hash, r.actor_id, r.action, r.entity_type, r.entity_id, r.data, r.created_at]));
}

function record(action, { actorId = null, entityType = null, entityId = null, data = null, ip = null } = {}) {
  const last = db.get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const row = {
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    data: data == null ? null : JSON.stringify(data),
    ip,
    prev_hash: last ? last.hash : GENESIS,
    created_at: clock.iso(),
  };
  row.hash = digest(row);
  db.insert('audit_log', row);
  return row;
}

function verify() {
  let prev = GENESIS;
  let count = 0;
  for (const r of db.all('SELECT * FROM audit_log ORDER BY seq ASC')) {
    if (r.prev_hash !== prev || digest(r) !== r.hash) {
      return { valid: false, brokenAtSeq: r.seq, checked: count };
    }
    prev = r.hash;
    count++;
  }
  return { valid: true, checked: count, headHash: prev };
}

function list({ entityType, entityId, limit = 100 } = {}) {
  if (entityType && entityId) {
    return db.all('SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT ?',
      entityType, entityId, limit);
  }
  return db.all('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?', limit);
}

module.exports = { record, verify, list };
