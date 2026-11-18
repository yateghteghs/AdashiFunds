'use strict';
// Group voting. Proposal types:
//   rule_change   { changes: { latePenaltyBps: 1000, ... } }  -> groups.applyRuleChange
//   loan          { loanId }                                -> loans.disburse
//   remove_member { userId }                                -> groups.removeMember (forming groups only)
// A proposal passes when YES votes exceed the threshold share of eligible voters, and is rejected as
// soon as passing becomes impossible. Unresolved proposals expire after 72 hours.
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');
const { bad, notFound, conflict, forbidden } = require('../lib/errors');
const groups = require('./groups');
const audit = require('./audit');
const { notify } = require('./notifications');

const TTL_HOURS = 72;

function eligibleVoters(p) {
  return groups.activeMembers(p.group_id).filter((m) => m.user_id !== p.excluded_user_id);
}

function create(groupId, proposerId, { type, title, payload, excludedUserId = null }) {
  const group = groups.getGroupRow(groupId);
  groups.requireMember(groupId, proposerId);
  if (!['rule_change', 'loan', 'remove_member'].includes(type)) throw bad('invalid_type', 'Unknown proposal type');
  if (type === 'rule_change') {
    if (!payload || !payload.changes || !Object.keys(payload.changes).length) throw bad('invalid_payload', 'Describe at least one rule change');
    if (group.status === 'completed' || group.status === 'cancelled') throw conflict('group_closed', 'This group is closed');
  }
  if (type === 'remove_member') {
    if (group.status !== 'forming') throw conflict('group_active', 'Members can only be removed before the group starts');
    if (!groups.membership(groupId, payload.userId)) throw notFound('Member');
    excludedUserId = payload.userId;
  }
  const p = {
    id: uid(), group_id: groupId, proposer_id: proposerId, type, title, payload: JSON.stringify(payload),
    status: 'open', threshold_bps: group.approval_threshold_bps, excluded_user_id: excludedUserId,
    expires_at: new Date(clock.now().getTime() + TTL_HOURS * 3_600_000).toISOString(), resolved_at: null, created_at: clock.iso(),
  };
  db.insert('proposals', p);
  groups.systemMessage(groupId, `New vote: ${title}`);
  for (const m of eligibleVoters(p)) {
    if (m.user_id !== proposerId) notify(m.user_id, 'proposal_opened', 'proposal_opened', { group: group.name, title }, { data: { groupId, proposalId: p.id } });
  }
  audit.record('proposal.created', { actorId: proposerId, entityType: 'proposal', entityId: p.id, data: { groupId, type, payload } });
  // The proposer votes yes automatically (except for loans, where the borrower is excluded).
  if (proposerId !== excludedUserId) vote(p.id, proposerId, 'yes');
  return get(p.id, proposerId);
}

function vote(proposalId, userId, choice) {
  const p = db.get('SELECT * FROM proposals WHERE id = ?', proposalId);
  if (!p) throw notFound('Proposal');
  if (!['yes', 'no'].includes(choice)) throw bad('invalid_choice', 'Vote yes or no');
  groups.requireMember(p.group_id, userId);
  if (p.status !== 'open') throw conflict('proposal_closed', `This vote is ${p.status}`);
  if (p.expires_at < clock.iso()) { resolve(p.id); throw conflict('proposal_closed', 'This vote has expired'); }
  if (userId === p.excluded_user_id) throw forbidden('You cannot vote on a proposal about yourself');
  if (db.get('SELECT 1 FROM votes WHERE proposal_id = ? AND user_id = ?', proposalId, userId)) throw conflict('already_voted', 'You have already voted');
  db.insert('votes', { proposal_id: proposalId, user_id: userId, choice, created_at: clock.iso() });
  audit.record('proposal.voted', { actorId: userId, entityType: 'proposal', entityId: proposalId, data: { choice } });
  resolve(proposalId);
  return get(proposalId, userId);
}

function tally(p) {
  const eligible = eligibleVoters(p).length;
  const ids = new Set(eligibleVoters(p).map((m) => m.user_id));
  const votes = db.all('SELECT * FROM votes WHERE proposal_id = ?', p.id).filter((v) => ids.has(v.user_id));
  const yes = votes.filter((v) => v.choice === 'yes').length;
  const no = votes.length - yes;
  const needed = Math.floor((p.threshold_bps * eligible) / 10_000) + ((p.threshold_bps * eligible) % 10_000 === 0 ? 0 : 1);
  return { eligible, yes, no, needed: Math.max(1, needed) };
}

function resolve(proposalId) {
  const p = db.get('SELECT * FROM proposals WHERE id = ?', proposalId);
  if (!p || p.status !== 'open') return p;
  const t = tally(p);
  let status = null;
  if (t.yes >= t.needed) status = 'passed';
  else if (t.eligible - t.no < t.needed) status = 'rejected';
  else if (p.expires_at < clock.iso()) status = 'expired';
  if (!status) return p;

  let executionError = null;
  db.tx(() => {
    db.update('proposals', p.id, { status, resolved_at: clock.iso() });
    const payload = JSON.parse(p.payload);
    if (status === 'passed') {
      try {
        db.tx(() => execute(p, payload));
      } catch (err) {
        executionError = err.message;
        if (p.type === 'loan') require('./loans').markRejected(payload.loanId);
      }
    } else if (p.type === 'loan') {
      require('./loans').markRejected(payload.loanId);
    }
  });
  const group = groups.getGroupRow(p.group_id);
  const result = status === 'passed' ? (executionError ? `passed but could not be applied (${executionError})` : 'passed') : `was ${status}`;
  groups.systemMessage(p.group_id, `Vote "${p.title}" ${result}.`);
  for (const m of groups.activeMembers(p.group_id)) {
    notify(m.user_id, 'proposal_resolved', 'proposal_resolved', { group: group.name, title: p.title, result }, { data: { groupId: p.group_id, proposalId: p.id } });
  }
  audit.record('proposal.resolved', { entityType: 'proposal', entityId: p.id, data: { status, tally: t, executionError } });
  return db.get('SELECT * FROM proposals WHERE id = ?', p.id);
}

function execute(p, payload) {
  if (p.type === 'rule_change') groups.applyRuleChange(p.group_id, payload.changes, null);
  else if (p.type === 'loan') require('./loans').disburse(payload.loanId);
  else if (p.type === 'remove_member') groups.removeMember(p.group_id, payload.userId, null);
}

function expireDue() {
  const due = db.all("SELECT id FROM proposals WHERE status = 'open' AND expires_at < ?", clock.iso());
  for (const { id } of due) resolve(id);
  return due.length;
}

function present(p, viewerId) {
  const t = tally(p);
  const mine = viewerId ? db.get('SELECT choice FROM votes WHERE proposal_id = ? AND user_id = ?', p.id, viewerId) : null;
  const proposer = db.get('SELECT full_name FROM users WHERE id = ?', p.proposer_id);
  return {
    id: p.id, groupId: p.group_id, type: p.type, title: p.title, payload: JSON.parse(p.payload), status: p.status,
    proposerId: p.proposer_id, proposerName: proposer && proposer.full_name, thresholdBps: p.threshold_bps,
    excludedUserId: p.excluded_user_id, expiresAt: p.expires_at, resolvedAt: p.resolved_at, createdAt: p.created_at,
    tally: t, myVote: mine ? mine.choice : null, canVote: p.status === 'open' && viewerId !== p.excluded_user_id && !mine,
  };
}

function get(proposalId, viewerId) {
  const p = db.get('SELECT * FROM proposals WHERE id = ?', proposalId);
  if (!p) throw notFound('Proposal');
  return present(p, viewerId);
}

function listForGroup(groupId, viewerId) {
  groups.requireMember(groupId, viewerId);
  return db.all('SELECT * FROM proposals WHERE group_id = ? ORDER BY created_at DESC', groupId).map((p) => present(p, viewerId));
}

module.exports = { create, vote, resolve, tally, expireDue, get, listForGroup };
