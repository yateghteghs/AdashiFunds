'use strict';
// Trust score (0-100): a transparent, explainable credibility signal shown to group admins and used
// as the basis for future credit scoring. Every component is returned so users can see why.
const db = require('../db');

function trustScore(userId) {
  const user = db.get('SELECT kyc_status, kyc_tier, phone_verified FROM users WHERE id = ?', userId);
  if (!user) return { score: 0, components: {} };
  const c = db.get(`SELECT
      SUM(CASE WHEN status = 'paid' AND paid_on_time = 1 THEN 1 ELSE 0 END) AS on_time,
      SUM(CASE WHEN status = 'paid' AND paid_on_time = 0 AND defaulted_at IS NULL THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN defaulted_at IS NOT NULL AND status = 'paid' THEN 1 ELSE 0 END) AS recovered,
      SUM(CASE WHEN status = 'defaulted' THEN 1 ELSE 0 END) AS outstanding_defaults
    FROM contributions WHERE user_id = ?`, userId);
  const completed = db.get(`SELECT COUNT(*) AS n FROM group_members gm JOIN groups g ON g.id = gm.group_id
                            WHERE gm.user_id = ? AND g.status = 'completed' AND gm.status = 'active'`, userId).n;
  const loans = db.get(`SELECT SUM(CASE WHEN status = 'repaid' THEN 1 ELSE 0 END) AS repaid,
                               SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue
                        FROM loans WHERE borrower_id = ?`, userId);

  const components = {
    base: 50,
    identity: (user.phone_verified ? 5 : 0) + (user.kyc_status === 'verified' ? 5 * user.kyc_tier : 0),
    onTimeContributions: Math.min(30, (c.on_time || 0) * 2),
    lateContributions: -(c.late || 0) * 4,
    recoveredDefaults: -(c.recovered || 0) * 8,
    outstandingDefaults: -(c.outstanding_defaults || 0) * 15,
    completedGroups: Math.min(15, completed * 5),
    loansRepaid: Math.min(10, (loans.repaid || 0) * 5),
    loansOverdue: -(loans.overdue || 0) * 15,
  };
  const raw = Object.values(components).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, raw));
  const band = score >= 80 ? 'excellent' : score >= 65 ? 'good' : score >= 45 ? 'fair' : 'poor';
  return {
    score, band, components,
    stats: { onTime: c.on_time || 0, late: c.late || 0, recoveredDefaults: c.recovered || 0, outstandingDefaults: c.outstanding_defaults || 0, completedGroups: completed },
  };
}

module.exports = { trustScore };
