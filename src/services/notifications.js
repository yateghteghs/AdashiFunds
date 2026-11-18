'use strict';
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');
const { t } = require('../lib/i18n');
const notifier = require('./notifier');

// Create an in-app notification in the user's language; optionally mirror it by SMS.
function notify(userId, type, key, vars = {}, { sms = false, data = null } = {}) {
  const user = db.get('SELECT id, phone, language FROM users WHERE id = ?', userId);
  if (!user) return null;
  const body = t(user.language, key, vars);
  const row = {
    id: uid(),
    user_id: userId,
    type,
    title: type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    body,
    data: data ? JSON.stringify(data) : null,
    read_at: null,
    created_at: clock.iso(),
  };
  db.insert('notifications', row);
  if (sms) notifier.sms(user.phone, body);
  return row;
}

function list(userId, { unreadOnly = false, limit = 50 } = {}) {
  return db.all(
    `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT ?`, userId, limit,
  ).map((n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null }));
}

function markRead(userId, ids) {
  const now = clock.iso();
  if (!ids || !ids.length) {
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now, userId);
    return;
  }
  for (const id of ids) db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now, id, userId);
}

const unreadCount = (userId) =>
  db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId).n;

module.exports = { notify, list, markRead, unreadCount };
