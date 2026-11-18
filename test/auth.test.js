'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, clock } = require('./helpers');
const { totpAt } = require('../src/lib/crypto');
const { normalizePhone } = require('../src/services/auth');

test('phone numbers normalise to E.164', () => {
  assert.equal(normalizePhone('08031234567'), '+2348031234567');
  assert.equal(normalizePhone('2348031234567'), '+2348031234567');
  assert.equal(normalizePhone('+2348031234567'), '+2348031234567');
  assert.throws(() => normalizePhone('12345'));
});

test('registration requires OTP verification before login', async () => {
  const phone = '08099990001';
  const r = await api().post('/api/auth/register').send({ fullName: 'Chika Eze', phone, email: 'chika@example.com', password: 'passw0rd1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.phoneVerified, false);
  assert.match(r.body.devOtp, /^\d{6}$/);

  const early = await api().post('/api/auth/login').send({ identifier: phone, password: 'passw0rd1' });
  assert.equal(early.status, 403);
  assert.equal(early.body.error.code, 'phone_not_verified');

  const wrong = await api().post('/api/auth/verify-phone').send({ phone, code: r.body.devOtp === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);

  const ok = await api().post('/api/auth/verify-phone').send({ phone, code: r.body.devOtp });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken && ok.body.refreshToken);

  // OTP is single use.
  const reuse = await api().post('/api/auth/verify-phone').send({ phone, code: r.body.devOtp });
  assert.equal(reuse.status, 400);

  const byEmail = await api().post('/api/auth/login').send({ identifier: 'CHIKA@example.com', password: 'passw0rd1' });
  assert.equal(byEmail.status, 200);
});

test('rejects duplicate phone, weak password and bad credentials', async () => {
  await registerUser('Dup', { phone: '08099990002' });
  const dup = await api().post('/api/auth/register').send({ fullName: 'Dup 2', phone: '+2348099990002', password: 'passw0rd1' });
  assert.equal(dup.status, 409);
  const weak = await api().post('/api/auth/register').send({ fullName: 'Weak', phone: '08099990003', password: 'short' });
  assert.equal(weak.status, 400);
  const bad = await api().post('/api/auth/login').send({ identifier: '08099990002', password: 'wrongpass1' });
  assert.equal(bad.status, 401);
});

test('OTP expires', async () => {
  const phone = '08099990004';
  const r = await api().post('/api/auth/register').send({ fullName: 'Late Verifier', phone, password: 'passw0rd1' });
  clock.advance(11 * 60_000);
  const v = await api().post('/api/auth/verify-phone').send({ phone, code: r.body.devOtp });
  clock.reset();
  assert.equal(v.status, 400);
});

test('refresh tokens rotate and logout revokes', async () => {
  const u = await registerUser('Refresher');
  const r1 = await api().post('/api/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.equal(r1.status, 200);
  const replay = await api().post('/api/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.equal(replay.status, 401, 'old refresh token must not be reusable');
  await api().post('/api/auth/logout').send({ refreshToken: r1.body.refreshToken });
  const after = await api().post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
  assert.equal(after.status, 401);
});

test('TOTP multi-factor authentication', async () => {
  const u = await registerUser('Secure Sam', { phone: '08099990005' });
  const setup = await api().post('/api/me/mfa/setup').set(u.auth);
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const bad = await api().post('/api/me/mfa/enable').set(u.auth).send({ code: '000000' });
  assert.equal(bad.status, 400);
  const en = await api().post('/api/me/mfa/enable').set(u.auth).send({ code: totpAt(setup.body.secret, Date.now()) });
  assert.equal(en.status, 200);

  const login = await api().post('/api/auth/login').send({ identifier: '08099990005', password: 'passw0rd1' });
  assert.equal(login.body.mfaRequired, true);
  assert.equal(login.body.accessToken, undefined);
  const wrong = await api().post('/api/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: '123456' === totpAt(setup.body.secret, Date.now()) ? '654321' : '123456' });
  assert.equal(wrong.status, 401);
  const ok = await api().post('/api/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: totpAt(setup.body.secret, Date.now()) });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken);

  // SMS fallback
  const login2 = await api().post('/api/auth/login').send({ identifier: '08099990005', password: 'passw0rd1' });
  const sms = await api().post('/api/auth/mfa/sms').send({ mfaToken: login2.body.mfaToken });
  const ok2 = await api().post('/api/auth/mfa/verify').send({ mfaToken: login2.body.mfaToken, code: sms.body.devOtp, method: 'sms' });
  assert.equal(ok2.status, 200);
});

test('password reset revokes sessions', async () => {
  const u = await registerUser('Forgetful', { phone: '08099990006' });
  const f = await api().post('/api/auth/password/forgot').send({ identifier: '08099990006' });
  const r = await api().post('/api/auth/password/reset').send({ identifier: '08099990006', code: f.body.devOtp, newPassword: 'newpassw0rd' });
  assert.equal(r.status, 200);
  assert.equal((await api().post('/api/auth/refresh').send({ refreshToken: u.refreshToken })).status, 401);
  assert.equal((await api().post('/api/auth/login').send({ identifier: '08099990006', password: 'newpassw0rd' })).status, 200);
  // Unknown accounts get the same response (no enumeration).
  const unknown = await api().post('/api/auth/password/forgot').send({ identifier: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
});

test('KYC verification raises tier; sensitive numbers are encrypted at rest', async () => {
  const u = await registerUser('Kyc Kemi');
  const bad = await api().post('/api/me/kyc').set(u.auth).send({ idType: 'NIN', idNumber: '123' });
  assert.equal(bad.status, 400);
  const rejected = await api().post('/api/me/kyc').set(u.auth).send({ idType: 'NIN', idNumber: '12345670000' });
  assert.equal(rejected.body.status, 'rejected');
  const ok = await api().post('/api/me/kyc').set(u.auth).send({ idType: 'BVN', idNumber: '22345678901' });
  assert.equal(ok.body.status, 'verified');
  assert.equal(ok.body.idLast4, '8901');
  const me = await api().get('/api/me').set(u.auth);
  assert.equal(me.body.user.kycTier, 2);
  const row = require('../src/db').get('SELECT id_number_enc FROM kyc_records WHERE user_id = ? AND status = ?', u.id, 'verified');
  assert.ok(!row.id_number_enc.includes('22345678901'));
});

test('protected endpoints require a valid token', async () => {
  assert.equal((await api().get('/api/me')).status, 401);
  assert.equal((await api().get('/api/me').set('Authorization', 'Bearer nonsense')).status, 401);
  assert.equal((await api().get('/api/admin/stats').set((await registerUser('Not Admin')).auth)).status, 403);
});
