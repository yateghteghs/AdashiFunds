'use strict';
// USSD channel for feature phones / low-connectivity areas. Implements the Africa's Talking USSD
// callback contract: POST { sessionId, serviceCode, phoneNumber, text } where `text` is the
// '*'-joined history of the user's inputs. Respond with "CON ..." to continue or "END ..." to finish.
const db = require('../db');
const { verifyPassword } = require('../lib/crypto');
const money = require('../lib/money');
const { t } = require('../lib/i18n');
const groups = require('./groups');
const wallet = require('./wallet');

const pinAttempts = new Map(); // phone -> { count, until }

function handle({ phoneNumber, text = '' }) {
  let user;
  try {
    user = db.get('SELECT * FROM users WHERE phone = ?', require('./auth').normalizePhone(phoneNumber));
  } catch { user = null; }
  const lang = user ? user.language : 'en';
  const end = (key, vars) => `END ${t(lang, key, vars)}`;
  const con = (key, vars) => `CON ${t(lang, key, vars)}`;
  if (!user || !user.phone_verified) return end('ussd_unknown');

  const parts = text === '' ? [] : text.split('*');
  const myGroups = groups.listForUser(user.id).filter((g) => g.status === 'active');

  if (parts.length === 0) return con('ussd_menu');
  switch (parts[0]) {
    case '1':
      return end('ussd_balance', { amount: money.format(wallet.balance(user.id).balance) });
    case '2': {
      if (!myGroups.length) return end('ussd_no_groups');
      return `END ${myGroups.map((g) => `${g.name}: ${money.format(g.contributionAmount)} ${g.frequency}${g.myOutstanding ? ' (due)' : ''}`).join('\n')}`;
    }
    case '3': {
      if (!user.ussd_pin_hash) return end('ussd_no_pin');
      if (!myGroups.length) return end('ussd_no_groups');
      if (parts.length === 1) {
        return con('ussd_pick_group', { list: myGroups.map((g, i) => `${i + 1}. ${g.name}`).join('\n') });
      }
      const g = myGroups[Number(parts[1]) - 1];
      if (!g) return end('ussd_invalid');
      const due = db.get(`SELECT c.* FROM contributions c JOIN rounds r ON r.id = c.round_id
                          WHERE c.user_id = ? AND c.group_id = ? AND c.status IN ('pending','defaulted') ORDER BY r.round_number LIMIT 1`, user.id, g.id);
      if (!due) return end('ussd_nothing_due', { group: g.name });
      if (parts.length === 2) return con('ussd_enter_pin', { amount: money.format(due.amount), group: g.name });
      const lock = pinAttempts.get(user.phone);
      if (lock && lock.count >= 3 && lock.until > Date.now()) return end('ussd_bad_pin');
      if (!verifyPassword(parts[2], user.ussd_pin_hash)) {
        const cur = lock && lock.until > Date.now() ? lock : { count: 0, until: Date.now() + 30 * 60_000 };
        pinAttempts.set(user.phone, { count: cur.count + 1, until: cur.until });
        return end('ussd_bad_pin');
      }
      pinAttempts.delete(user.phone);
      try {
        groups.contribute(user.id, g.id, { contributionId: due.id, source: 'ussd' });
        return end('ussd_paid', { amount: money.format(due.amount), group: g.name });
      } catch (err) {
        return `END ${err.message}`;
      }
    }
    case '4': {
      const next = myGroups.filter((g) => g.myPayoutAt && g.myPayoutStatus !== 'paid_out')
        .sort((a, b) => a.myPayoutAt.localeCompare(b.myPayoutAt))[0];
      return next ? end('ussd_next_payout', { group: next.name, date: next.myPayoutAt.slice(0, 10) }) : end('ussd_no_payout');
    }
    default:
      return end('ussd_invalid');
  }
}

module.exports = { handle };
