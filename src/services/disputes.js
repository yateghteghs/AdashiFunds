'use strict';
// Structured dispute resolution with an evidence trail. Parties: the person raising it, the member it
// is against (if any), the group admin, and platform admins. The group admin may resolve unless they
// are a party; otherwise it escalates to platform admins.
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');
const { bad, notFound, forbidden, conflict } = require('../lib/errors');
const groups = require('./groups');
const audit = require('./audit');
const { notify } = require('./notifications');

const CATEGORIES = ['missed_payout', 'wrong_amount', 'member_default', 'unauthorized_transaction', 'fraud', 'other'];

function create(userId, { groupId, againstUserId, transactionId, category, description }) {
  if (!CATEGORIES.includes(category)) throw bad('invalid_category', `Category must be one of ${CATEGORIES.join(', ')}`);
  if (groupId) groups.requireMember(groupId, userId);
  if (againstUserId && groupId && !groups.membership(groupId, againstUserId)) throw bad('invalid_party', 'That person is not in this group');
  if (transactionId) {
    const txn = db.get('SELECT * FROM transactions WHERE id = ? OR reference = ?', transactionId, transactionId);
    if (!txn) throw notFound('Transaction');
    const involved = txn.user_id === userId || txn.counterparty_user_id === userId || (groupId && txn.group_id === groupId);
    if (!involved) throw forbidden('You can only dispute transactions you are involved in');
    transactionId = txn.id;
  }
  const d = {
    id: uid(), group_id: groupId || null, raised_by: userId, against_user_id: againstUserId || null,
    transaction_id: transactionId || null, category, description, status: 'open', resolution: null,
    resolved_by: null, created_at: clock.iso(), resolved_at: null,
  };
  db.insert('disputes', d);
  if (groupId) {
    const g = groups.getGroupRow(groupId);
    if (g.admin_id !== userId) notify(g.admin_id, 'dispute_opened', 'dispute_update', { category, status: 'open' }, { data: { disputeId: d.id } });
  }
  if (againstUserId) notify(againstUserId, 'dispute_opened', 'dispute_update', { category, status: 'open' }, { data: { disputeId: d.id } });
  audit.record('dispute.created', { actorId: userId, entityType: 'dispute', entityId: d.id, data: { groupId, category, transactionId } });
  return get(d.id, userId);
}

function canView(d, userId) {
  const user = db.get('SELECT role FROM users WHERE id = ?', userId);
  if (user.role === 'admin') return true;
  if (d.raised_by === userId || d.against_user_id === userId) return true;
  return !!(d.group_id && groups.getGroupRow(d.group_id).admin_id === userId);
}

function canResolve(d, userId) {
  const user = db.get('SELECT role FROM users WHERE id = ?', userId);
  if (user.role === 'admin') return true;
  if (!d.group_id) return false;
  const g = groups.getGroupRow(d.group_id);
  return g.admin_id === userId && d.raised_by !== userId && d.against_user_id !== userId;
}

function load(id, userId) {
  const d = db.get('SELECT * FROM disputes WHERE id = ?', id);
  if (!d) throw notFound('Dispute');
  if (!canView(d, userId)) throw forbidden();
  return d;
}

function addMessage(id, userId, { body, evidenceRef }) {
  const d = load(id, userId);
  if (['resolved', 'rejected'].includes(d.status)) throw conflict('dispute_closed', 'This dispute is closed');
  db.insert('dispute_messages', { id: uid(), dispute_id: id, user_id: userId, body, evidence_ref: evidenceRef || null, created_at: clock.iso() });
  return get(id, userId);
}

function setStatus(id, userId, { status, resolution }) {
  const d = load(id, userId);
  if (!['under_review', 'resolved', 'rejected'].includes(status)) throw bad('invalid_status', 'Invalid status');
  if (!canResolve(d, userId)) throw forbidden('Only a neutral group admin or platform admin can decide this dispute');
  if (['resolved', 'rejected'].includes(d.status)) throw conflict('dispute_closed', 'This dispute is closed');
  if (status !== 'under_review' && !resolution) throw bad('resolution_required', 'Explain the decision');
  db.update('disputes', id, {
    status, resolution: resolution || d.resolution, resolved_by: status === 'under_review' ? null : userId,
    resolved_at: status === 'under_review' ? null : clock.iso(),
  });
  for (const party of [d.raised_by, d.against_user_id].filter(Boolean)) {
    notify(party, 'dispute_update', 'dispute_update', { category: d.category, status }, { data: { disputeId: id } });
  }
  audit.record('dispute.status_changed', { actorId: userId, entityType: 'dispute', entityId: id, data: { status, resolution } });
  return get(id, userId);
}

function get(id, userId) {
  const d = load(id, userId);
  const name = (uidv) => uidv && (db.get('SELECT full_name FROM users WHERE id = ?', uidv) || {}).full_name;
  return {
    id: d.id, groupId: d.group_id, category: d.category, description: d.description, status: d.status,
    resolution: d.resolution, createdAt: d.created_at, resolvedAt: d.resolved_at,
    raisedBy: { id: d.raised_by, name: name(d.raised_by) },
    against: d.against_user_id ? { id: d.against_user_id, name: name(d.against_user_id) } : null,
    transaction: d.transaction_id ? db.get('SELECT id, reference, type, amount, status, created_at FROM transactions WHERE id = ?', d.transaction_id) : null,
    canResolve: canResolve(d, userId),
    messages: db.all(`SELECT m.*, u.full_name FROM dispute_messages m JOIN users u ON u.id = m.user_id
                      WHERE m.dispute_id = ? ORDER BY m.created_at`, id)
      .map((m) => ({ id: m.id, userId: m.user_id, name: m.full_name, body: m.body, evidenceRef: m.evidence_ref, createdAt: m.created_at })),
    // Evidence: the tamper-evident audit history of the disputed transaction/group.
    auditTrail: db.all(`SELECT seq, action, actor_id, data, hash, created_at FROM audit_log
                        WHERE entity_id IN (?, ?) ORDER BY seq DESC LIMIT 50`, d.transaction_id || '', d.id),
  };
}

function list(userId) {
  const user = db.get('SELECT role FROM users WHERE id = ?', userId);
  const rows = user.role === 'admin'
    ? db.all('SELECT * FROM disputes ORDER BY created_at DESC LIMIT 200')
    : db.all(`SELECT d.* FROM disputes d LEFT JOIN groups g ON g.id = d.group_id
              WHERE d.raised_by = ? OR d.against_user_id = ? OR g.admin_id = ? ORDER BY d.created_at DESC`, userId, userId, userId);
  return rows.map((d) => ({
    id: d.id, groupId: d.group_id, category: d.category, description: d.description, status: d.status, createdAt: d.created_at,
    mine: d.raised_by === userId,
  }));
}

module.exports = { CATEGORIES, create, addMessage, setStatus, get, list };
