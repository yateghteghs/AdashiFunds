'use strict';
// Support: tickets plus a lightweight FAQ assistant that answers common questions instantly and
// hands off to a human ticket when it is not confident. An LLM-backed assistant can replace
// `answer()` later without changing the API.
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');

const FAQ = [
  { keys: ['what is adashi', 'adashe', 'esusu', 'ajo', 'rosca', 'how does it work'], answer: 'Adashi is a rotating savings group. Every member contributes the same amount each period, and each period one member receives the full pot. In AdashiFunds the app collects contributions from wallets, pays out automatically in the agreed order, and keeps a transparent record of every payment.' },
  { keys: ['fund', 'deposit', 'add money', 'top up'], answer: 'Go to Wallet → Add money. You can pay by card, bank transfer, USSD or mobile money. Your balance updates as soon as the payment is confirmed.' },
  { keys: ['withdraw', 'cash out', 'bank'], answer: 'Add a bank account under Wallet → Bank accounts, then choose Withdraw. Withdrawals need identity verification (KYC). You can also turn on auto-withdraw in Profile so payouts go straight to your bank.' },
  { keys: ['late', 'penalty', 'miss', 'default'], answer: 'If you pay after the due date plus the group\'s grace period, a late penalty (set by the group) is added and goes to the group reserve. If a round pays out without your contribution, it is recorded as a default and your trust score drops until you settle it — the money then goes straight to that round\'s recipient.' },
  { keys: ['loan', 'borrow', 'emergency'], answer: 'Active members with verified identity can request an emergency loan from their group\'s reserve. The group votes; if approved the money is sent to your wallet. Anything unpaid at your next payout is deducted automatically.' },
  { keys: ['vote', 'proposal', 'change rule'], answer: 'Once a group starts, rule changes need a vote. Open the group → Votes → New proposal. It passes when more than the group\'s approval threshold of members vote yes.' },
  { keys: ['kyc', 'verify', 'nin', 'bvn', 'identity'], answer: 'Go to Profile → Verify identity and enter your NIN, BVN or another ID. Verification raises your limits; BVN gives the highest tier.' },
  { keys: ['trust score', 'score', 'rating'], answer: 'Your trust score (0–100) grows with on-time contributions, completed groups and repaid loans, and drops with late payments and defaults. Group admins can see it when you join.' },
  { keys: ['ussd', 'no internet', 'offline', 'feature phone'], answer: 'Set a 4-digit USSD PIN in Profile, then dial the AdashiFunds USSD code to check your balance, see your groups and pay contributions without internet.' },
  { keys: ['dispute', 'complain', 'problem', 'fraud', 'scam'], answer: 'Open Disputes → New dispute, choose the category and attach the transaction if there is one. The group admin (if neutral) or our team will review the evidence trail and respond.' },
  { keys: ['mfa', '2fa', 'two factor', 'authenticator', 'security'], answer: 'Turn on two-factor authentication in Profile → Security. Use an authenticator app; you can also receive login codes by SMS.' },
  { keys: ['fee', 'charge', 'cost'], answer: 'Joining and contributing are free. A small platform fee is taken from each payout, and some transfers may carry a fee shown before you confirm.' },
];

function answer(question) {
  const q = String(question || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of FAQ) {
    const score = item.keys.reduce((s, k) => s + (q.includes(k) ? k.length : 0), 0);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best
    ? { answer: best.answer, confident: true }
    : { answer: 'I\'m not sure about that one. Would you like to open a support ticket so a member of our team can help?', confident: false };
}

function createTicket(userId, { subject, body, channel = 'in_app' }) {
  const row = { id: uid(), user_id: userId, channel, subject, body, status: 'open', created_at: clock.iso() };
  db.insert('support_tickets', row);
  return row;
}

const listTickets = (userId) => db.all('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC', userId);

// Financial literacy content, keyed by language with English fallback.
const TIPS = {
  en: [
    { title: 'Pay yourself first', body: 'Treat your Adashi contribution like rent: set auto-debit so it leaves your wallet before you spend.' },
    { title: 'Pick your payout slot wisely', body: 'An early slot works like an interest-free loan; a late slot works like disciplined savings. Choose based on when you need the lump sum.' },
    { title: 'Build an emergency buffer', body: 'Aim to keep at least one month of expenses aside so a surprise bill never makes you miss a contribution.' },
    { title: 'Grow your trust score', body: 'On-time contributions and completed groups raise your trust score, which can unlock bigger groups and loans.' },
    { title: 'Use your payout with a plan', body: 'Before your turn comes, write down what the payout is for — stock for your business, school fees, or rent — and stick to it.' },
  ],
  pcm: [
    { title: 'Pay yourself first', body: 'Make your Adashi contribution be like house rent: turn on auto-debit so e comot before you spend am.' },
    { title: 'Keep small money for emergency', body: 'Try keep at least one month expenses for side, so sudden wahala no go make you miss contribution.' },
  ],
  fr: [
    { title: 'Payez-vous en premier', body: 'Traitez votre cotisation comme un loyer : activez le prélèvement automatique avant de dépenser.' },
    { title: 'Constituez une épargne de précaution', body: 'Gardez au moins un mois de dépenses de côté pour ne jamais manquer une cotisation.' },
  ],
};

const tips = (lang) => TIPS[lang] || TIPS.en;

module.exports = { answer, createTicket, listTickets, tips, FAQ };
