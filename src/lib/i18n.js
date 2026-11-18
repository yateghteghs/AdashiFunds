'use strict';
// Server-side message catalogue for notifications and USSD menus.
// English is the source of truth; other languages fall back to English per key.
// NOTE: non-English strings are first drafts and should be reviewed by native speakers before launch.
const SUPPORTED = ['en', 'ha', 'yo', 'ig', 'pcm', 'fr'];

const messages = {
  en: {
    contribution_due: 'Your {amount} contribution to {group} is due {when}.',
    contribution_received: 'We received your {amount} contribution to {group}.',
    contribution_late: 'Your contribution to {group} is late. A penalty of {penalty} now applies.',
    contribution_missed_admin: '{member} has not paid round {round} of {group}.',
    payout_received: 'You received a payout of {amount} from {group}.',
    group_started: '{group} has started. Your payout position is #{position}.',
    member_joined: '{member} joined {group}.',
    proposal_opened: 'New vote in {group}: {title}',
    proposal_resolved: 'Vote "{title}" in {group} {result}.',
    loan_disbursed: 'Your loan of {amount} from {group} has been disbursed. Repay {total} by {due}.',
    loan_overdue: 'Your loan from {group} is overdue. Outstanding: {amount}.',
    transfer_received: 'You received {amount} from {sender}.',
    kyc_verified: 'Your identity has been verified.',
    kyc_rejected: 'Your identity verification was not successful: {reason}',
    fraud_alert: 'Unusual activity was detected on your account. If this was not you, contact support.',
    dispute_update: 'Your dispute "{category}" is now {status}.',
    contribution_overdue: 'Your contribution to {group} is overdue. Pay before {deadline} UTC to avoid a late penalty.',
    auto_debit_failed: 'Auto-debit for {group} failed: {reason}. Fund your wallet and pay manually.',
    auto_withdraw_failed: 'Automatic withdrawal of your payout failed. The money is safe in your wallet.',
    referral_reward: '{name} made their first contribution. You earned {points} referral points!',
    otp: 'Your AdashiFunds code is {code}. It expires in {minutes} minutes. Do not share it.',
    ussd_menu: 'AdashiFunds\n1. Wallet balance\n2. My groups\n3. Contribute\n4. Next payout',
    ussd_balance: 'Wallet balance: {amount}',
    ussd_no_groups: 'You have no active groups.',
    ussd_pick_group: 'Choose a group:\n{list}',
    ussd_enter_pin: 'Enter your 4-digit PIN to pay {amount} to {group}:',
    ussd_paid: 'Paid {amount} to {group}. Thank you!',
    ussd_bad_pin: 'Incorrect PIN.',
    ussd_no_pin: 'Set a USSD PIN in the AdashiFunds app first.',
    ussd_unknown: 'Phone number not registered with AdashiFunds.',
    ussd_next_payout: 'Next payout: {group} on {date}.',
    ussd_no_payout: 'No upcoming payouts.',
    ussd_invalid: 'Invalid option.',
    ussd_nothing_due: 'Nothing due in {group}.',
  },
  pcm: {
    contribution_due: 'Your {amount} contribution for {group} go due {when}.',
    contribution_received: 'We don collect your {amount} contribution for {group}.',
    payout_received: 'Your payout of {amount} from {group} don land.',
    transfer_received: 'You don receive {amount} from {sender}.',
    ussd_menu: 'AdashiFunds\n1. Wallet balance\n2. My groups\n3. Pay contribution\n4. Next payout',
    ussd_balance: 'Your wallet balance na {amount}',
  },
  ha: {
    contribution_due: 'Gudummawarka ta {amount} zuwa {group} ta kusa {when}.',
    payout_received: 'Ka karɓi kuɗi {amount} daga {group}.',
    ussd_menu: 'AdashiFunds\n1. Ma\'aunin walat\n2. Ƙungiyoyina\n3. Biya gudummawa\n4. Biya na gaba',
    ussd_balance: 'Ma\'aunin walat: {amount}',
  },
  yo: {
    contribution_due: 'Ìdáwó {amount} rẹ sí {group} yóò tó {when}.',
    payout_received: 'O ti gba {amount} láti {group}.',
    ussd_menu: 'AdashiFunds\n1. Iye owó àpò\n2. Àwọn ẹgbẹ́ mi\n3. San ìdáwó\n4. Owó tó kàn',
    ussd_balance: 'Iye owó àpò: {amount}',
  },
  ig: {
    contribution_due: 'Onyinye {amount} gị na {group} ga-eru {when}.',
    payout_received: 'Ị natara {amount} site na {group}.',
    ussd_menu: 'AdashiFunds\n1. Ego dị na akpa\n2. Otu m\n3. Kwụọ onyinye\n4. Ịkwụ ụgwọ ọzọ',
    ussd_balance: 'Ego dị na akpa: {amount}',
  },
  fr: {
    contribution_due: 'Votre cotisation de {amount} pour {group} est due {when}.',
    contribution_received: 'Nous avons reçu votre cotisation de {amount} pour {group}.',
    payout_received: 'Vous avez reçu un versement de {amount} de {group}.',
    transfer_received: 'Vous avez reçu {amount} de {sender}.',
    otp: 'Votre code AdashiFunds est {code}. Il expire dans {minutes} minutes. Ne le partagez pas.',
    ussd_menu: 'AdashiFunds\n1. Solde\n2. Mes groupes\n3. Cotiser\n4. Prochain versement',
    ussd_balance: 'Solde du portefeuille : {amount}',
  },
};

function t(lang, key, vars = {}) {
  const template = (messages[lang] && messages[lang][key]) || messages.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

module.exports = { t, SUPPORTED };
