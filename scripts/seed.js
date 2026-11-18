'use strict';
// Seeds a demo dataset: a platform admin and five members in an active weekly group with one round
// paid out. Run with `npm run seed` (uses DB_PATH or data/adashi.db). All passwords: passw0rd1
process.env.EXPOSE_DEV_OTP = 'true';
const db = require('../src/db');
const auth = require('../src/services/auth');
const wallet = require('../src/services/wallet');
const groups = require('../src/services/groups');
const kyc = require('../src/services/kyc');
const ledger = require('../src/services/ledger');

(async () => {
  db.open();
  for (const name of Object.values(ledger.SYSTEM)) ledger.systemAccount(name);
  if (db.get('SELECT 1 FROM users LIMIT 1')) {
    console.log('Database already has users; skipping seed.');
    return;
  }
  const make = async (fullName, phone, email, { admin = false, naira = 50_000, verify = true } = {}) => {
    const { user } = auth.register({ fullName, phone, email, password: 'passw0rd1' });
    db.update('users', user.id, { phone_verified: 1, role: admin ? 'admin' : 'user' });
    if (verify) await kyc.submit(user.id, { idType: 'NIN', idNumber: `1${phone.slice(-10)}` });
    if (naira) await wallet.initDeposit(user.id, { amount: naira * 100 });
    return user;
  };

  await make('Platform Admin', '08000000001', 'admin@adashifunds.test', { admin: true, naira: 0 });
  const amina = await make('Amina Bello', '08030000001', 'amina@adashifunds.test');
  const tunde = await make('Tunde Adeyemi', '08030000002', 'tunde@adashifunds.test');
  const ngozi = await make('Ngozi Okafor', '08030000003', 'ngozi@adashifunds.test');
  const musa = await make('Musa Ibrahim', '08030000004', null, { verify: false });
  const efe = await make('Efe Omoregie', '08030000005', null, { naira: 2_000 });

  const g = groups.createGroup(amina.id, {
    name: 'Balogun Market Traders', description: 'Weekly Adashi for shop owners on Balogun Street.',
    contributionAmount: 10_000_00, frequency: 'weekly', maxMembers: 5, latePenaltyBps: 500, gracePeriodHours: 24,
  });
  for (const u of [tunde, ngozi, musa, efe]) groups.joinGroup(u.id, { inviteCode: g.invite_code });
  groups.startGroup(amina.id, g.id);
  for (const u of [amina, tunde, ngozi, musa, efe]) {
    try { groups.contribute(u.id, g.id); } catch (e) { console.log(`  ${u.full_name}: ${e.message}`); }
  }
  groups.postMessage(tunde.id, g.id, 'Efe, please fund your wallet so we can complete round 1 🙏');

  groups.createGroup(ngozi.id, {
    name: 'Ikeja Teachers Cooperative', description: 'Monthly savings for school staff. New members welcome.',
    contributionAmount: 25_000_00, frequency: 'monthly', maxMembers: 10, isPublic: true, requireKyc: true,
  });

  console.log('Seeded demo data. Log in with any of these (password: passw0rd1):');
  console.log('  admin  08000000001   |  Amina 08030000001 (group admin)  |  Efe 08030000005 (owes round 1)');
  console.log(`  Invite code for Balogun Market Traders: ${g.invite_code}`);
})().catch((e) => { console.error(e); process.exit(1); });
