'use strict';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const db = require('../src/db');
const clock = require('../src/lib/clock');
const { createApp } = require('../src/app');

db.open(':memory:');
const app = createApp();
const api = () => request(app);

let phoneSeq = 0;
async function registerUser(name = 'Test User', { phone, referralCode, email } = {}) {
  phoneSeq++;
  phone = phone || `080${String(10_000_000 + phoneSeq).padStart(8, '0')}`;
  const r = await api().post('/api/auth/register').send({ fullName: name, phone, password: 'passw0rd1', referralCode, email });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const v = await api().post('/api/auth/verify-phone').send({ phone, code: r.body.devOtp });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  const auth = { Authorization: `Bearer ${v.body.accessToken}` };
  return { ...v.body, id: v.body.user.id, phone, auth };
}

async function fund(user, naira) {
  const r = await api().post('/api/wallet/deposits').set(user.auth).send({ amount: naira * 100 });
  if (r.status !== 201) throw new Error(`deposit failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function verifyKyc(user, idType = 'NIN', idNumber = '12345678901') {
  const r = await api().post('/api/me/kyc').set(user.auth).send({ idType, idNumber });
  if (r.status !== 201) throw new Error(`kyc failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

const balance = async (user) => (await api().get('/api/wallet').set(user.auth)).body.balance;

async function makeAdmin(user) {
  db.update('users', user.id, { role: 'admin' });
  return user;
}

// Create a group with the given members (first is admin), started.
async function startedGroup(members, overrides = {}, { start = true } = {}) {
  const [admin, ...rest] = members;
  const g = await api().post('/api/groups').set(admin.auth).send({
    name: 'Test Adashi', contributionAmount: 5_000_00, frequency: 'weekly', maxMembers: members.length, ...overrides,
  });
  if (g.status !== 201) throw new Error(`create group failed: ${JSON.stringify(g.body)}`);
  for (const m of rest) {
    const j = await api().post('/api/groups/join').set(m.auth).send({ inviteCode: g.body.inviteCode });
    if (j.status !== 200) throw new Error(`join failed: ${JSON.stringify(j.body)}`);
  }
  if (!start) return g.body;
  const s = await api().post(`/api/groups/${g.body.id}/start`).set(admin.auth).send({});
  if (s.status !== 200) throw new Error(`start failed: ${JSON.stringify(s.body)}`);
  return s.body;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

module.exports = { app, api, db, clock, registerUser, fund, verifyKyc, balance, makeAdmin, startedGroup, DAY, HOUR };
