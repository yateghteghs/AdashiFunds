'use strict';
const db = require('../db');
const config = require('../config');
const ledger = require('./ledger');
const audit = require('./audit');
const { notify } = require('./notifications');

// Reward the referrer once, when the referred user makes their first contribution
// (rewarding on sign-up alone invites fake accounts).
function onFirstContribution(userId) {
  const user = db.get('SELECT id, full_name, referred_by FROM users WHERE id = ?', userId);
  if (!user || !user.referred_by) return;
  const paid = db.get("SELECT COUNT(*) AS n FROM contributions WHERE user_id = ? AND status = 'paid'", userId).n;
  if (paid !== 1) return;
  const already = db.get("SELECT 1 FROM audit_log WHERE action = 'referral.rewarded' AND entity_id = ?", userId);
  if (already) return;

  db.tx(() => {
    db.run('UPDATE users SET referral_points = referral_points + ? WHERE id = ?', config.referralPoints, user.referred_by);
    if (config.referralBonusKobo > 0) {
      ledger.transfer(ledger.systemAccount(ledger.SYSTEM.promotions).id, ledger.userAccount(user.referred_by).id, config.referralBonusKobo, {
        type: 'referral_bonus', user_id: user.referred_by, counterparty_user_id: userId, description: `Referral bonus for inviting ${user.full_name}`,
      });
    }
    audit.record('referral.rewarded', { actorId: user.referred_by, entityType: 'user', entityId: userId, data: { points: config.referralPoints, bonus: config.referralBonusKobo } });
  });
  notify(user.referred_by, 'referral_reward', 'referral_reward', { name: user.full_name, points: config.referralPoints });
}

function summary(userId) {
  const u = db.get('SELECT referral_code, referral_points FROM users WHERE id = ?', userId);
  const referred = db.all(`SELECT u.full_name, u.created_at,
      EXISTS (SELECT 1 FROM contributions c WHERE c.user_id = u.id AND c.status = 'paid') AS active
    FROM users u WHERE u.referred_by = ? ORDER BY u.created_at DESC`, userId);
  return {
    code: u.referral_code, points: u.referral_points,
    link: `${config.publicBaseUrl}/#/register?ref=${u.referral_code}`,
    referred: referred.map((r) => ({ name: maskName(r.full_name), joinedAt: r.created_at, active: !!r.active })),
  };
}

const maskName = (name) => {
  const [first, ...rest] = String(name).split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};

// Leaderboards show masked names only.
function leaderboard() {
  const referrers = db.all('SELECT full_name, referral_points FROM users WHERE referral_points > 0 ORDER BY referral_points DESC LIMIT 10')
    .map((r, i) => ({ rank: i + 1, name: maskName(r.full_name), points: r.referral_points }));
  const savers = db.all(`SELECT u.full_name, SUM(c.amount) AS total, SUM(c.paid_on_time) AS on_time
                         FROM contributions c JOIN users u ON u.id = c.user_id WHERE c.status = 'paid'
                         GROUP BY u.id ORDER BY on_time DESC, total DESC LIMIT 10`)
    .map((r, i) => ({ rank: i + 1, name: maskName(r.full_name), totalSaved: r.total, onTimeContributions: r.on_time }));
  return { referrers, savers };
}

module.exports = { onFirstContribution, summary, leaderboard, maskName };
