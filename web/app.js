/* AdashiFunds web client — Vue 3, no build step. All API amounts are integer kobo. */
(function () {
  'use strict';
  const { createApp, reactive, ref, computed, onMounted, onUnmounted, watch } = Vue;

  // ---------- Store & API ----------
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  function deviceId() {
    let id = LS.get('adashi.device');
    if (!id) { id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2); LS.set('adashi.device', id); }
    return id;
  }

  const store = reactive({
    user: null, meta: null, unread: 0, toast: null,
    accessToken: LS.get('adashi.access'), refreshToken: LS.get('adashi.refresh'),
  });

  function setSession(s) {
    store.accessToken = s ? s.accessToken : null;
    store.refreshToken = s ? s.refreshToken : null;
    store.user = s ? s.user : null;
    LS.set('adashi.access', store.accessToken);
    LS.set('adashi.refresh', store.refreshToken);
  }

  let toastTimer;
  function toast(msg) {
    store.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { store.toast = null; }, 3500);
  }

  async function api(path, { method = 'GET', body, raw = false, retry = true } = {}) {
    const headers = { 'X-Device-Id': deviceId() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (store.accessToken) headers.Authorization = `Bearer ${store.accessToken}`;
    const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry && store.refreshToken && !path.startsWith('/auth/')) {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId() }, body: JSON.stringify({ refreshToken: store.refreshToken }) });
      if (r.ok) { setSession(await r.json()); return api(path, { method, body, raw, retry: false }); }
      setSession(null);
      location.hash = '#/login';
    }
    if (raw) { if (!res.ok) throw new Error('Download failed'); return res; }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error((data && data.error && data.error.message) || 'Request failed'), { code: data && data.error && data.error.code });
    return data;
  }

  // ---------- Formatting ----------
  const ngn = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' });
  const money = (k) => ngn.format((k || 0) / 100);
  function approx(k) {
    const cur = store.user && store.user.displayCurrency;
    if (!cur || cur === 'NGN' || !store.meta) return '';
    const v = ((k || 0) / 100) * (store.meta.fxRates[cur] || 0);
    return `≈ ${new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(v)}`;
  }
  const date = (s) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const dateTime = (s) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
  const toKobo = (naira) => Math.round(Number(naira) * 100);
  const label = (s) => String(s || '').replace(/_/g, ' ');
  function t(key) {
    const lang = (store.user && store.user.language) || LS.get('adashi.lang') || 'en';
    const d = window.ADASHI_I18N;
    return (d[lang] && d[lang][key]) || d.en[key] || key;
  }
  const statusClass = (s) => ({
    success: 'ok', paid: 'ok', paid_out: 'ok', verified: 'ok', passed: 'ok', resolved: 'ok', completed: 'ok', repaid: 'ok', active: 'ok',
    pending: 'warn', open: 'brand', forming: 'brand', under_review: 'warn', pending_vote: 'warn', disbursed: 'brand', scheduled: '',
    failed: 'danger', reversed: 'danger', defaulted: 'danger', rejected: 'danger', overdue: 'danger', expired: '', blocked: 'danger', flagged: 'warn',
  }[s] || '');
  const fmt = { money, approx, date, dateTime, pct, label, statusClass, t };

  async function loadMe() {
    if (!store.accessToken) return;
    try {
      const me = await api('/me');
      store.user = me.user;
      const n = await api('/notifications?unread=true');
      store.unread = n.unread;
    } catch { /* handled by api() */ }
  }

  // ---------- Router ----------
  const route = reactive({ path: '/', params: {}, query: {} });
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [p, q] = h.split('?');
    route.path = p;
    route.query = Object.fromEntries(new URLSearchParams(q || ''));
  }
  window.addEventListener('hashchange', parseHash);
  parseHash();
  const go = (p) => { location.hash = `#${p}`; };

  // Shared helper for forms: runs fn, tracks busy/error state.
  function useAction() {
    const busy = ref(false);
    const error = ref('');
    async function run(fn) {
      busy.value = true; error.value = '';
      try { return await fn(); } catch (e) { error.value = e.message; return undefined; } finally { busy.value = false; }
    }
    return { busy, error, run };
  }

  // ---------- Auth views ----------
  const AuthView = {
    setup() {
      const mode = ref(route.path === '/register' ? 'register' : 'login');
      const f = reactive({ fullName: '', phone: '', email: '', password: '', identifier: '', code: '', referralCode: route.query.ref || '', newPassword: '', language: LS.get('adashi.lang') || 'en' });
      const mfa = reactive({ token: null, method: 'totp' });
      const devOtp = ref('');
      const { busy, error, run } = useAction();
      watch(() => f.language, (v) => LS.set('adashi.lang', v));

      const finish = (s) => { setSession(s); loadMe(); go('/'); };
      const submitLogin = () => run(async () => {
        const r = await api('/auth/login', { method: 'POST', body: { identifier: f.identifier, password: f.password } }).catch((e) => {
          if (e.code === 'phone_not_verified') { f.phone = f.identifier; mode.value = 'verify'; api('/auth/resend-verification', { method: 'POST', body: { phone: f.phone } }).then((x) => { devOtp.value = x.devOtp || ''; }); }
          throw e;
        });
        if (r.mfaRequired) { mfa.token = r.mfaToken; mode.value = 'mfa'; return; }
        finish(r);
      });
      const submitRegister = () => run(async () => {
        const body = { fullName: f.fullName, phone: f.phone, password: f.password, language: f.language };
        if (f.email) body.email = f.email;
        if (f.referralCode) body.referralCode = f.referralCode;
        const r = await api('/auth/register', { method: 'POST', body });
        devOtp.value = r.devOtp || '';
        mode.value = 'verify';
      });
      const submitVerify = () => run(async () => finish(await api('/auth/verify-phone', { method: 'POST', body: { phone: f.phone, code: f.code } })));
      const resend = () => run(async () => { const r = await api('/auth/resend-verification', { method: 'POST', body: { phone: f.phone } }); devOtp.value = r.devOtp || ''; toast('Code sent'); });
      const smsMfa = () => run(async () => { const r = await api('/auth/mfa/sms', { method: 'POST', body: { mfaToken: mfa.token } }); devOtp.value = r.devOtp || ''; mfa.method = 'sms'; toast('Code sent by SMS'); });
      const submitMfa = () => run(async () => finish(await api('/auth/mfa/verify', { method: 'POST', body: { mfaToken: mfa.token, code: f.code, method: mfa.method } })));
      const forgot = () => run(async () => { const r = await api('/auth/password/forgot', { method: 'POST', body: { identifier: f.identifier } }); devOtp.value = r.devOtp || ''; mode.value = 'reset'; });
      const reset = () => run(async () => { await api('/auth/password/reset', { method: 'POST', body: { identifier: f.identifier, code: f.code, newPassword: f.newPassword } }); toast('Password updated. Log in.'); mode.value = 'login'; f.code = ''; });
      return { mode, f, mfa, devOtp, busy, error, submitLogin, submitRegister, submitVerify, resend, smsMfa, submitMfa, forgot, reset, t, langs: ['en', 'ha', 'yo', 'ig', 'pcm', 'fr'] };
    },
    template: `
    <div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><span class="logo">A</span> AdashiFunds</div>
      <p class="tagline">{{ t('tagline') }}</p>
      <div v-if="error" class="alert error" role="alert">{{ error }}</div>
      <div v-if="devOtp" class="alert info">Development mode — your code is <b class="mono">{{ devOtp }}</b></div>

      <form v-if="mode==='login'" @submit.prevent="submitLogin">
        <div class="field"><label for="id">Phone number or email</label><input id="id" v-model="f.identifier" autocomplete="username" required placeholder="08012345678"></div>
        <div class="field"><label for="pw">Password</label><input id="pw" type="password" v-model="f.password" autocomplete="current-password" required></div>
        <button class="btn primary block" :disabled="busy">{{ t('login') }}</button>
        <p class="small muted" style="margin-top:1rem;text-align:center">
          <a href="#" @click.prevent="mode='register'">{{ t('register') }}</a> ·
          <a href="#" @click.prevent="f.identifier ? forgot() : (error='Enter your phone or email first')">Forgot password?</a>
        </p>
      </form>

      <form v-else-if="mode==='register'" @submit.prevent="submitRegister">
        <div class="field"><label for="fn">Full name</label><input id="fn" v-model="f.fullName" autocomplete="name" required></div>
        <div class="field"><label for="ph">Phone number</label><input id="ph" v-model="f.phone" type="tel" autocomplete="tel" required placeholder="08012345678"><div class="hint">We'll text you a code to verify it.</div></div>
        <div class="field"><label for="em">Email <span class="muted">(optional)</span></label><input id="em" v-model="f.email" type="email" autocomplete="email"></div>
        <div class="field"><label for="pw2">Password</label><input id="pw2" v-model="f.password" type="password" autocomplete="new-password" required minlength="8"><div class="hint">At least 8 characters with a letter and a number.</div></div>
        <div class="grid grid-2" style="gap:.75rem">
          <div class="field"><label for="lang">Language</label><select id="lang" v-model="f.language"><option v-for="l in langs" :value="l">{{ {en:'English',ha:'Hausa',yo:'Yorùbá',ig:'Igbo',pcm:'Pidgin',fr:'Français'}[l] }}</option></select></div>
          <div class="field"><label for="ref">Referral code</label><input id="ref" v-model="f.referralCode" placeholder="Optional"></div>
        </div>
        <button class="btn primary block" :disabled="busy">{{ t('register') }}</button>
        <p class="small muted" style="margin-top:1rem;text-align:center">Already have an account? <a href="#" @click.prevent="mode='login'">{{ t('login') }}</a></p>
      </form>

      <form v-else-if="mode==='verify'" @submit.prevent="submitVerify">
        <p>Enter the 6-digit code sent to <b>{{ f.phone }}</b>.</p>
        <div class="field"><label for="code">Verification code</label><input id="code" v-model="f.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
        <button class="btn primary block" :disabled="busy">Verify phone</button>
        <p class="small" style="margin-top:1rem;text-align:center"><a href="#" @click.prevent="resend">Resend code</a></p>
      </form>

      <form v-else-if="mode==='mfa'" @submit.prevent="submitMfa">
        <p v-if="mfa.method==='totp'">Enter the code from your authenticator app.</p>
        <p v-else>Enter the code we sent by SMS.</p>
        <div class="field"><label for="mfa">Authentication code</label><input id="mfa" v-model="f.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
        <button class="btn primary block" :disabled="busy">Continue</button>
        <p class="small" style="margin-top:1rem;text-align:center" v-if="mfa.method==='totp'"><a href="#" @click.prevent="smsMfa">Send me a code by SMS instead</a></p>
      </form>

      <form v-else-if="mode==='reset'" @submit.prevent="reset">
        <p>If an account exists for <b>{{ f.identifier }}</b>, we've sent a reset code to its phone.</p>
        <div class="field"><label for="rc">Reset code</label><input id="rc" v-model="f.code" inputmode="numeric" maxlength="6" required></div>
        <div class="field"><label for="np">New password</label><input id="np" v-model="f.newPassword" type="password" autocomplete="new-password" required minlength="8"></div>
        <button class="btn primary block" :disabled="busy">Set new password</button>
        <p class="small" style="margin-top:1rem;text-align:center"><a href="#" @click.prevent="mode='login'">Back to log in</a></p>
      </form>
    </div></div>`,
  };

  // ---------- Reusable pieces ----------
  const Modal = {
    props: ['title'], emits: ['close'],
    template: `<div class="modal-bg" @click.self="$emit('close')" role="dialog" aria-modal="true">
      <div class="modal"><div class="row between" style="margin-bottom:.75rem"><h2 style="margin:0">{{ title }}</h2>
      <button class="btn small" @click="$emit('close')" aria-label="Close">✕</button></div><slot></slot></div></div>`,
  };

  const TxList = {
    props: ['items'],
    setup() { return { ...fmt }; },
    template: `<ul class="list" v-if="items && items.length">
      <li v-for="t in items" :key="t.id">
        <div style="min-width:0"><div class="title">{{ t.description || label(t.type) }}</div>
          <div class="sub">{{ dateTime(t.created_at) }} · <span class="badge" :class="statusClass(t.status)">{{ label(t.status) }}</span> <span class="mono">{{ t.reference }}</span></div></div>
        <div class="num" :class="t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : ''" style="font-weight:700;white-space:nowrap">{{ t.net > 0 ? '+' : '' }}{{ money(t.net || 0) }}</div>
      </li></ul><div v-else class="empty">No transactions yet.</div>`,
  };

  const TrustBadge = {
    props: ['trust'],
    setup(props) {
      const color = computed(() => (props.trust.score >= 80 ? 'var(--ok)' : props.trust.score >= 65 ? 'var(--brand)' : props.trust.score >= 45 ? 'var(--warn)' : 'var(--danger)'));
      return { color };
    },
    template: `<div class="trust"><div class="ring" :style="{ border: '6px solid ' + color, color }">{{ trust.score }}</div>
      <div><div style="font-weight:700;text-transform:capitalize">{{ trust.band }} standing</div>
      <div class="small muted">{{ trust.stats.onTime }} on-time · {{ trust.stats.late }} late · {{ trust.stats.outstandingDefaults }} unpaid defaults · {{ trust.stats.completedGroups }} groups completed</div></div></div>`,
  };

  // ---------- Dashboard ----------
  const HomeView = {
    components: { TxList, TrustBadge },
    setup() {
      const d = ref(null);
      const tips = ref([]);
      const { error, run } = useAction();
      const load = () => run(async () => { d.value = await api('/me/dashboard'); store.unread = d.value.unreadNotifications; tips.value = await api('/content/tips'); });
      onMounted(load);
      const pay = (groupId) => run(async () => { await api(`/groups/${groupId}/contributions`, { method: 'POST', body: {} }); toast('Contribution paid'); load(); });
      return { d, tips, error, pay, store, go, ...fmt };
    },
    template: `<div>
      <div class="topbar"><div><h1>Hello, {{ store.user && store.user.fullName.split(' ')[0] }}</h1><div class="muted small">Here's where your savings stand.</div></div>
        <div class="actions"><a class="btn" href="#/groups/new">+ {{ t('createGroup') }}</a><a class="btn" href="#/groups/join">{{ t('joinGroup') }}</a></div></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div v-if="store.user && store.user.kycStatus !== 'verified'" class="alert warn">Verify your identity to unlock withdrawals, loans and higher limits. <a href="#/profile">Verify now →</a></div>
      <template v-if="d">
        <div class="grid grid-2">
          <div class="card hero">
            <div class="label">{{ t('balance') }}</div>
            <div class="amount">{{ money(d.wallet.balance) }}</div>
            <div class="small" v-if="approx(d.wallet.balance)" style="margin-top:-.6rem;margin-bottom:.6rem;opacity:.85">{{ approx(d.wallet.balance) }}</div>
            <div class="row"><a class="btn small" href="#/wallet?action=deposit">{{ t('addMoney') }}</a><a class="btn small" href="#/wallet?action=send">{{ t('send') }}</a><a class="btn small" href="#/wallet?action=withdraw">{{ t('withdraw') }}</a></div>
          </div>
          <div class="card">
            <h2>{{ t('nextPayout') }}</h2>
            <template v-if="d.nextPayout"><div class="stat"><div class="value">{{ money(d.nextPayout.amount) }}</div></div>
              <p class="muted">from <a :href="'#/groups/' + d.nextPayout.groupId">{{ d.nextPayout.name }}</a> around {{ date(d.nextPayout.date) }}</p></template>
            <div v-else class="muted">No payout scheduled. Join or start a group to get in the rotation.</div>
            <TrustBadge :trust="d.trust" style="margin-top:.75rem"/>
          </div>
        </div>
        <div class="card" v-if="d.contributionsDue.length">
          <h2>{{ t('dueNow') }}</h2>
          <ul class="list"><li v-for="c in d.contributionsDue" :key="c.groupId">
            <a class="item" :href="'#/groups/' + c.groupId"><div class="title">{{ c.name }}</div><div class="sub">Due {{ date(c.dueAt) }}</div></a>
            <div class="row"><b class="num">{{ money(c.amount) }}</b><button class="btn primary small" @click="pay(c.groupId)">Pay</button></div>
          </li></ul>
        </div>
        <div class="grid grid-2">
          <div class="card"><h2>My groups <a class="small" href="#/groups">See all</a></h2>
            <ul class="list" v-if="d.groups.length"><li v-for="g in d.groups.slice(0,5)" :key="g.id">
              <a class="item" :href="'#/groups/' + g.id"><div class="title">{{ g.name }}</div><div class="sub">{{ money(g.contributionAmount) }} {{ g.frequency }} · {{ g.memberCount }}/{{ g.maxMembers }} members</div></a>
              <span class="badge" :class="statusClass(g.status)">{{ g.status }}</span></li></ul>
            <div v-else class="empty">You're not in any groups yet.<br><a href="#/groups/new">Start one</a> or <a href="#/groups/join">join with an invite code</a>.</div>
          </div>
          <div class="card"><h2>Recent activity <a class="small" href="#/wallet">Wallet</a></h2><TxList :items="d.recentTransactions"/></div>
        </div>
        <div class="card" v-if="d.loans.length"><h2>My loans</h2>
          <ul class="list"><li v-for="l in d.loans" :key="l.id"><div><div class="title">{{ money(l.principal) }} loan</div><div class="sub">Outstanding {{ money(l.outstanding) }} · due {{ date(l.dueAt) }}</div></div><span class="badge" :class="statusClass(l.status)">{{ label(l.status) }}</span></li></ul></div>
        <div class="card" v-if="tips.length"><h2>Savings tip</h2><h3>{{ tips[new Date().getDate() % tips.length].title }}</h3><p class="muted">{{ tips[new Date().getDate() % tips.length].body }}</p></div>
      </template>
    </div>`,
  };

  // ---------- Wallet ----------
  const WalletView = {
    components: { TxList, Modal },
    setup() {
      const w = ref(null);
      const txs = ref([]);
      const banks = ref([]);
      const accounts = ref([]);
      const modal = ref(route.query.action || null);
      const qr = ref(null);
      const f = reactive({ amount: '', channel: 'card', recipient: route.query.to || '', note: '', bankCode: '', accountNumber: '', bankAccountId: '', month: new Date().toISOString().slice(0, 7) });
      const { busy, error, run } = useAction();
      const load = async () => {
        w.value = await api('/wallet');
        txs.value = await api('/wallet/transactions?limit=50');
        accounts.value = await api('/wallet/bank-accounts');
      };
      onMounted(async () => {
        await run(load);
        if (route.query.ref) run(async () => { const r = await api(`/wallet/deposits/${route.query.ref}/verify`); toast(`Deposit ${r.status}`); load(); });
        if (route.query.amount) f.amount = Number(route.query.amount) / 100;
      });
      const open = async (m) => {
        modal.value = m; error.value = '';
        if (m === 'bank' && !banks.value.length) banks.value = await api('/wallet/banks');
        if (m === 'receive') qr.value = await api('/wallet/qr');
      };
      const close = () => { modal.value = null; f.amount = ''; };
      const deposit = () => run(async () => {
        const r = await api('/wallet/deposits', { method: 'POST', body: { amount: toKobo(f.amount), channel: f.channel } });
        if (r.authorizationUrl) { location.href = r.authorizationUrl; return; }
        toast(r.status === 'success' ? 'Wallet funded' : 'Deposit pending'); close(); load();
      });
      const send = () => run(async () => {
        const body = { amount: toKobo(f.amount), note: f.note || undefined };
        if (route.query.to && f.recipient === route.query.to) body.recipientId = f.recipient; else body.recipient = f.recipient;
        const r = await api('/wallet/transfers', { method: 'POST', body });
        toast(`Sent ${money(r.amount)} to ${r.recipientName}`); close(); load();
      });
      const withdraw = () => run(async () => {
        const r = await api('/wallet/withdrawals', { method: 'POST', body: { amount: toKobo(f.amount), bankAccountId: f.bankAccountId || undefined } });
        toast(`Withdrawal ${r.status}`); close(); load();
      });
      const addBank = () => run(async () => { await api('/wallet/bank-accounts', { method: 'POST', body: { bankCode: f.bankCode, accountNumber: f.accountNumber } }); toast('Bank account added'); f.accountNumber = ''; modal.value = null; load(); });
      const removeBank = (id) => run(async () => { await api(`/wallet/bank-accounts/${id}`, { method: 'DELETE' }); load(); });
      const download = (format) => run(async () => {
        const res = await api(`/wallet/statement?month=${f.month}&format=${format}`, { raw: true });
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `adashifunds-statement-${f.month}.${format}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
      return { w, txs, banks, accounts, modal, qr, f, busy, error, open, close, deposit, send, withdraw, addBank, removeBank, download, store, ...fmt };
    },
    template: `<div>
      <div class="topbar"><h1>{{ t('wallet') }}</h1></div>
      <div v-if="error && !modal" class="alert error">{{ error }}</div>
      <div class="card hero" v-if="w">
        <div class="label">{{ t('balance') }}</div><div class="amount">{{ money(w.balance) }}</div>
        <div class="row"><button class="btn small" @click="open('deposit')">{{ t('addMoney') }}</button><button class="btn small" @click="open('send')">{{ t('send') }}</button>
          <button class="btn small" @click="open('withdraw')">{{ t('withdraw') }}</button><button class="btn small" @click="open('receive')">{{ t('receive') }} (QR)</button></div>
      </div>
      <div class="grid grid-2">
        <div class="card"><h2>Bank accounts <button class="btn small" @click="open('bank')">+ Add</button></h2>
          <ul class="list" v-if="accounts.length"><li v-for="b in accounts" :key="b.id"><div><div class="title">{{ b.accountName }}</div><div class="sub">{{ b.bankName }} ····{{ b.accountLast4 }} <span v-if="store.user && store.user.defaultBankAccountId===b.id" class="badge brand">default</span></div></div>
            <button class="btn small danger" @click="removeBank(b.id)">Remove</button></li></ul>
          <div v-else class="empty">Add a bank account to withdraw your payouts.</div></div>
        <div class="card"><h2>Statements</h2>
          <div class="field"><label for="m">Month</label><input id="m" type="month" v-model="f.month"></div>
          <div class="row"><button class="btn" @click="download('pdf')">Download PDF</button><button class="btn" @click="download('csv')">Download CSV</button></div></div>
      </div>
      <div class="card"><h2>Transaction history</h2><TxList :items="txs"/></div>

      <Modal v-if="modal==='deposit'" title="Add money" @close="close"><form @submit.prevent="deposit">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div class="field"><label for="da">Amount (₦)</label><input id="da" type="number" min="100" step="0.01" v-model="f.amount" required></div>
        <div class="field"><label for="dc">Pay with</label><select id="dc" v-model="f.channel"><option value="card">Debit card</option><option value="bank_transfer">Bank transfer</option><option value="ussd">USSD</option><option value="mobile_money">Mobile money (Opay, PalmPay, Paga…)</option></select></div>
        <p v-if="store.meta && store.meta.paymentProvider==='mock'" class="small muted">Development mode: deposits are credited instantly.</p>
        <button class="btn primary block" :disabled="busy">Continue</button></form></Modal>

      <Modal v-if="modal==='send'" title="Send money" @close="close"><form @submit.prevent="send">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div class="field"><label for="sr">Recipient phone or email</label><input id="sr" v-model="f.recipient" required></div>
        <div class="field"><label for="sa">Amount (₦)</label><input id="sa" type="number" min="1" step="0.01" v-model="f.amount" required></div>
        <div class="field"><label for="sn">Note</label><input id="sn" v-model="f.note" maxlength="140"></div>
        <p class="small muted" v-if="store.meta && store.meta.transferFeeKobo">Fee: {{ money(store.meta.transferFeeKobo) }}</p>
        <button class="btn primary block" :disabled="busy">Send</button></form></Modal>

      <Modal v-if="modal==='withdraw'" title="Withdraw to bank" @close="close"><form @submit.prevent="withdraw">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div v-if="!accounts.length" class="alert warn">Add a bank account first.</div>
        <div class="field"><label for="wb">Bank account</label><select id="wb" v-model="f.bankAccountId"><option value="">Default account</option><option v-for="b in accounts" :value="b.id">{{ b.bankName }} ····{{ b.accountLast4 }}</option></select></div>
        <div class="field"><label for="wa">Amount (₦)</label><input id="wa" type="number" min="100" step="0.01" v-model="f.amount" required></div>
        <button class="btn primary block" :disabled="busy || !accounts.length">Withdraw</button></form></Modal>

      <Modal v-if="modal==='bank'" title="Add bank account" @close="close"><form @submit.prevent="addBank">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div class="field"><label for="bk">Bank or mobile money provider</label><select id="bk" v-model="f.bankCode" required><option value="" disabled>Choose…</option><option v-for="b in banks" :value="b.code">{{ b.name }}</option></select></div>
        <div class="field"><label for="an">Account number</label><input id="an" v-model="f.accountNumber" inputmode="numeric" pattern="\\d{10}" maxlength="10" required><div class="hint">10-digit NUBAN. We'll confirm the account name.</div></div>
        <button class="btn primary block" :disabled="busy">Verify &amp; add</button></form></Modal>

      <Modal v-if="modal==='receive'" title="Receive money" @close="close">
        <p class="muted">Ask the sender to scan this code in AdashiFunds, or share your phone number.</p>
        <img v-if="qr" :src="qr.dataUrl" class="qr" alt="Your payment QR code" width="260" height="260">
        <p class="small mono" v-if="qr">{{ qr.payload }}</p></Modal>
    </div>`,
  };

  // ---------- Groups ----------
  const GroupsView = {
    setup() {
      const mine = ref([]);
      const pub = ref([]);
      const { error, run } = useAction();
      onMounted(() => run(async () => { mine.value = await api('/groups'); pub.value = await api('/groups/public'); }));
      const join = (id) => run(async () => { const g = await api('/groups/join', { method: 'POST', body: { groupId: id } }); go(`/groups/${g.id}`); });
      return { mine, pub, error, join, ...fmt };
    },
    template: `<div>
      <div class="topbar"><h1>{{ t('groups') }}</h1><div class="actions"><a class="btn primary" href="#/groups/new">+ {{ t('createGroup') }}</a><a class="btn" href="#/groups/join">{{ t('joinGroup') }}</a></div></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="grid grid-2">
        <a v-for="g in mine" :key="g.id" class="card" :href="'#/groups/' + g.id" style="text-decoration:none;color:inherit">
          <div class="row between"><h2 style="margin:0">{{ g.name }}</h2><span class="badge" :class="statusClass(g.status)">{{ g.status }}</span></div>
          <p class="muted small" style="margin:.25rem 0 .75rem">{{ money(g.contributionAmount) }} {{ g.frequency }} · {{ g.memberCount }}/{{ g.maxMembers }} members<span v-if="g.myRole==='admin'"> · you're admin</span></p>
          <div class="row between small"><span v-if="g.status==='active'">Round {{ g.currentRound }} of {{ g.memberCount }}</span><span v-if="g.myPosition">Your turn: #{{ g.myPosition }}</span>
            <span v-if="g.myOutstanding" class="badge warn">payment due</span></div>
        </a>
      </div>
      <div v-if="!mine.length" class="card empty">You're not in any groups yet.</div>
      <div class="card" v-if="pub.length"><h2>Open groups looking for members</h2>
        <ul class="list"><li v-for="g in pub" :key="g.id"><div><div class="title">{{ g.name }}</div><div class="sub">{{ money(g.contributionAmount) }} {{ g.frequency }} · {{ g.memberCount }}/{{ g.maxMembers }} members<span v-if="g.requireKyc"> · KYC required</span></div><div class="sub" v-if="g.description">{{ g.description }}</div></div>
          <button class="btn small" @click="join(g.id)">Join</button></li></ul></div>
    </div>`,
  };

  const NewGroupView = {
    setup() {
      const f = reactive({ name: '', description: '', contribution: 5000, frequency: 'weekly', maxMembers: 6, payoutOrder: 'join_order', latePenalty: 5, grace: 24, loanInterest: 5, payoutTiming: 'when_complete', isPublic: false, requireKyc: false });
      const { busy, error, run } = useAction();
      const pot = computed(() => money(toKobo(f.contribution) * f.maxMembers));
      const submit = () => run(async () => {
        const g = await api('/groups', { method: 'POST', body: {
          name: f.name, description: f.description || undefined, contributionAmount: toKobo(f.contribution), frequency: f.frequency,
          maxMembers: Number(f.maxMembers), payoutOrder: f.payoutOrder, latePenaltyBps: Math.round(f.latePenalty * 100),
          gracePeriodHours: Number(f.grace), loanInterestBps: Math.round(f.loanInterest * 100), payoutTiming: f.payoutTiming,
          isPublic: f.isPublic, requireKyc: f.requireKyc,
        } });
        go(`/groups/${g.id}`);
      });
      return { f, busy, error, submit, pot, t };
    },
    template: `<div><div class="topbar"><h1>{{ t('createGroup') }}</h1></div>
      <form class="card" @submit.prevent="submit" style="max-width:640px">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div class="field"><label for="gn">Group name</label><input id="gn" v-model="f.name" required maxlength="80" placeholder="e.g. Balogun Market Traders"></div>
        <div class="field"><label for="gd">Description</label><textarea id="gd" v-model="f.description" maxlength="500"></textarea></div>
        <div class="grid grid-3">
          <div class="field"><label for="ga">Contribution (₦)</label><input id="ga" type="number" min="100" step="50" v-model.number="f.contribution" required></div>
          <div class="field"><label for="gf">Frequency</label><select id="gf" v-model="f.frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div>
          <div class="field"><label for="gm">Members</label><input id="gm" type="number" min="2" max="100" v-model.number="f.maxMembers" required></div>
        </div>
        <div class="alert info">Each payout will be <b>{{ pot }}</b> when the group is full.</div>
        <div class="grid grid-3">
          <div class="field"><label for="go">Payout order</label><select id="go" v-model="f.payoutOrder"><option value="join_order">Order of joining</option><option value="random">Random draw</option><option value="manual">Set by admin</option></select></div>
          <div class="field"><label for="gt">Pay out</label><select id="gt" v-model="f.payoutTiming"><option value="when_complete">As soon as everyone pays</option><option value="on_due_date">On the due date</option></select></div>
          <div class="field"><label for="gg">Grace period (hours)</label><input id="gg" type="number" min="0" max="336" v-model.number="f.grace"></div>
          <div class="field"><label for="gp">Late penalty (%)</label><input id="gp" type="number" min="0" max="50" step="0.5" v-model.number="f.latePenalty"><div class="hint">Goes to the group reserve.</div></div>
          <div class="field"><label for="gi">Loan interest (%)</label><input id="gi" type="number" min="0" max="30" step="0.5" v-model.number="f.loanInterest"></div>
        </div>
        <div class="field"><label class="check"><input type="checkbox" v-model="f.isPublic"> List publicly so others can find and join</label></div>
        <div class="field"><label class="check"><input type="checkbox" v-model="f.requireKyc"> Only allow identity-verified members</label></div>
        <button class="btn primary" :disabled="busy">Create group</button>
      </form></div>`,
  };

  const JoinGroupView = {
    setup() {
      const code = ref(route.query.code || '');
      const { busy, error, run } = useAction();
      const submit = () => run(async () => { const g = await api('/groups/join', { method: 'POST', body: { inviteCode: code.value.trim() } }); toast(`Joined ${g.name}`); go(`/groups/${g.id}`); });
      return { code, busy, error, submit, t };
    },
    template: `<div><div class="topbar"><h1>{{ t('joinGroup') }}</h1></div>
      <form class="card" @submit.prevent="submit" style="max-width:480px">
        <div v-if="error" class="alert error">{{ error }}</div>
        <div class="field"><label for="ic">Invite code</label><input id="ic" v-model="code" required maxlength="10" style="text-transform:uppercase;letter-spacing:.15em" placeholder="ABC234"><div class="hint">Ask your group admin for the code.</div></div>
        <button class="btn primary" :disabled="busy">Join</button></form></div>`,
  };

  const GroupDetailView = {
    components: { Modal },
    props: ['id'],
    setup(props) {
      const g = ref(null);
      const tab = ref('overview');
      const messages = ref([]);
      const proposals = ref([]);
      const loans = ref([]);
      const chat = ref('');
      const modal = ref(null);
      const f = reactive({ title: '', setting: 'latePenaltyBps', value: '', loanAmount: '', loanTerm: 30, loanReason: '', reserve: '', firstDueAt: '', order: [] });
      const { busy, error, run } = useAction();
      const me = computed(() => store.user && store.user.id);
      const isAdmin = computed(() => g.value && g.value.myRole === 'admin');
      const openRound = computed(() => g.value && g.value.rounds.find((r) => r.status === 'open'));
      const myDue = computed(() => {
        if (!g.value) return null;
        for (const r of g.value.rounds) { const c = r.contributions.find((x) => x.userId === me.value && x.status !== 'paid'); if (c) return { ...c, round: r }; }
        return null;
      });
      const load = async () => { g.value = await api(`/groups/${props.id}`); f.order = g.value.members.map((m) => m.userId); };
      const loadTab = async () => {
        if (!g.value || !g.value.myRole) return;
        if (tab.value === 'chat') messages.value = await api(`/groups/${props.id}/messages`);
        if (tab.value === 'votes') proposals.value = await api(`/groups/${props.id}/proposals`);
        if (tab.value === 'loans') loans.value = await api(`/groups/${props.id}/loans`);
      };
      let poll;
      onMounted(async () => { await run(load); poll = setInterval(() => { if (tab.value === 'chat') loadTab(); }, 5000); });
      onUnmounted(() => clearInterval(poll));
      watch(tab, () => run(loadTab));
      const act = (fn, msg) => run(async () => { await fn(); if (msg) toast(msg); modal.value = null; await load(); await loadTab(); });
      const pay = () => act(() => api(`/groups/${props.id}/contributions`, { method: 'POST', body: { contributionId: myDue.value.id } }), 'Contribution paid');
      const start = () => act(() => api(`/groups/${props.id}/start`, { method: 'POST', body: f.firstDueAt ? { firstDueAt: new Date(f.firstDueAt).toISOString() } : {} }), 'Group started');
      const leave = () => run(async () => { if (!confirm('Leave this group?')) return; await api(`/groups/${props.id}/leave`, { method: 'POST' }); go('/groups'); });
      const cancel = () => run(async () => { if (!confirm('Cancel this group? This cannot be undone.')) return; await api(`/groups/${props.id}/cancel`, { method: 'POST' }); go('/groups'); });
      const closeRound = () => act(() => api(`/groups/${props.id}/close-round`, { method: 'POST' }), 'Round settled');
      const toggleAuto = () => act(() => api(`/groups/${props.id}/auto-debit`, { method: 'PUT', body: { enabled: !g.value.myAutoDebit } }), 'Saved');
      const send = () => run(async () => { if (!chat.value.trim()) return; await api(`/groups/${props.id}/messages`, { method: 'POST', body: { body: chat.value } }); chat.value = ''; await loadTab(); });
      const vote = (pid, choice) => act(() => api(`/proposals/${pid}/votes`, { method: 'POST', body: { choice } }), 'Vote recorded');
      const settingDefs = {
        latePenaltyBps: { label: 'Late penalty (%)', toApi: (v) => Math.round(v * 100) },
        gracePeriodHours: { label: 'Grace period (hours)', toApi: Number },
        loanInterestBps: { label: 'Loan interest (%)', toApi: (v) => Math.round(v * 100) },
        contributionAmount: { label: 'Contribution (₦, applies to future rounds)', toApi: (v) => toKobo(v) },
        approvalThresholdBps: { label: 'Approval threshold (%)', toApi: (v) => Math.round(v * 100) },
        payoutTiming: { label: 'Payout timing (when_complete / on_due_date)', toApi: String },
      };
      const propose = () => act(() => api(`/groups/${props.id}/proposals`, { method: 'POST', body: {
        type: 'rule_change', title: f.title || `Change ${settingDefs[f.setting].label} to ${f.value}`,
        payload: { changes: { [f.setting]: settingDefs[f.setting].toApi(f.value) } },
      } }), 'Proposal opened');
      const removeMember = (userId, name) => act(() => api(`/groups/${props.id}/proposals`, { method: 'POST', body: { type: 'remove_member', title: `Remove ${name} from the group`, payload: { userId } } }), 'Removal vote opened');
      const requestLoan = () => act(() => api(`/groups/${props.id}/loans`, { method: 'POST', body: { amount: toKobo(f.loanAmount), termDays: Number(f.loanTerm), reason: f.loanReason || undefined } }), 'Loan request sent to the group for a vote');
      const repay = (l) => act(() => api(`/loans/${l.id}/repayments`, { method: 'POST', body: {} }), 'Loan repaid');
      const fundReserve = () => act(() => api(`/groups/${props.id}/reserve`, { method: 'POST', body: { amount: toKobo(f.reserve) } }), 'Reserve topped up');
      const move = (i, d) => { const o = f.order; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; };
      const saveOrder = () => act(() => api(`/groups/${props.id}/payout-order`, { method: 'PUT', body: { userIds: f.order } }), 'Payout order saved');
      const nameOf = (uid) => (g.value.members.find((m) => m.userId === uid) || {}).fullName || '—';
      const copyInvite = () => { const link = `${location.origin}/#/groups/join?code=${g.value.inviteCode}`; navigator.clipboard && navigator.clipboard.writeText(link).then(() => toast('Invite link copied')); };
      return { g, tab, messages, proposals, loans, chat, modal, f, busy, error, me, isAdmin, openRound, myDue, pay, start, leave, cancel, closeRound, toggleAuto, send, vote, propose, removeMember, requestLoan, repay, fundReserve, settingDefs, move, saveOrder, nameOf, copyInvite, ...fmt };
    },
    template: `<div v-if="g">
      <div class="topbar"><div><h1>{{ g.name }}</h1><div class="muted small">{{ money(g.contributionAmount) }} {{ g.frequency }} · {{ g.members.length }}/{{ g.maxMembers }} members · <span class="badge" :class="statusClass(g.status)">{{ g.status }}</span></div></div>
        <div class="actions" v-if="g.inviteCode && g.status==='forming'"><span class="badge brand mono" style="font-size:.95rem;padding:.35rem .7rem">{{ g.inviteCode }}</span><button class="btn small" @click="copyInvite">Copy invite link</button></div></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <p v-if="g.description" class="muted">{{ g.description }}</p>

      <div class="grid grid-3">
        <div class="card stat"><div class="label">Pot</div><div class="value">{{ money(g.potBalance) }}</div></div>
        <div class="card stat"><div class="label">Reserve fund</div><div class="value">{{ money(g.reserveBalance) }}</div></div>
        <div class="card stat"><div class="label">Round</div><div class="value">{{ g.currentRound || '—' }} / {{ g.rounds.length || g.maxMembers }}</div></div>
      </div>

      <div class="card" v-if="myDue" style="border-color:var(--brand)">
        <div class="row between"><div><h2 style="margin:0">Your round {{ myDue.round.roundNumber }} contribution</h2>
          <div class="muted small">Due {{ dateTime(myDue.round.dueAt) }} · grace until {{ dateTime(myDue.round.graceEndsAt) }}<span v-if="myDue.status==='defaulted'" class="badge danger" style="margin-left:.4rem">defaulted</span></div>
          <div class="small" v-if="myDue.penaltyIfPaidNow" style="color:var(--danger)">Includes late penalty of {{ money(myDue.penaltyIfPaidNow) }}</div></div>
          <button class="btn primary" @click="pay" :disabled="busy">{{ t('contribute') }} · {{ money(myDue.amount + myDue.penaltyIfPaidNow) }}</button></div>
      </div>

      <div class="tabs" role="tablist" v-if="g.myRole">
        <button v-for="x in ['overview','members','chat','votes','loans','settings']" :key="x" :class="{active: tab===x}" @click="tab=x" role="tab">{{ x[0].toUpperCase() + x.slice(1) }}</button>
      </div>

      <div v-if="tab==='overview'">
        <div class="card" v-if="g.status==='forming'">
          <h2>Waiting to start</h2>
          <p class="muted">Share the invite code. Once at least 2 members have joined the admin can start the rotation; settings can be edited freely until then.</p>
          <div v-if="isAdmin" class="row" style="align-items:flex-end">
            <div class="field" style="margin:0"><label for="fd">First due date (optional)</label><input id="fd" type="datetime-local" v-model="f.firstDueAt"></div>
            <button class="btn primary" @click="start" :disabled="busy || g.members.length < 2">Start group</button>
            <button class="btn danger" @click="cancel">Cancel group</button>
          </div>
          <button v-else class="btn danger" @click="leave">Leave group</button>
        </div>
        <div class="card" v-if="g.rounds.length"><h2>Rotation schedule</h2>
          <div v-for="r in g.rounds" :key="r.id" class="round" :class="r.status">
            <div class="row between"><div><b>Round {{ r.roundNumber }}</b> → {{ r.recipientName }}<span v-if="r.recipientId===me" class="badge brand" style="margin-left:.35rem">you</span></div>
              <div class="row"><span class="small muted">due {{ date(r.dueAt) }}</span><span class="badge" :class="statusClass(r.status)">{{ label(r.status) }}</span></div></div>
            <template v-if="r.status!=='scheduled'">
              <div class="progress" :aria-label="'Paid ' + r.contributions.filter(c=>c.status==='paid').length + ' of ' + r.contributions.length"><span :style="{ width: (100 * r.contributions.filter(c=>c.status==='paid').length / Math.max(1, r.contributions.length)) + '%' }"></span></div>
              <div class="chips"><span v-for="c in r.contributions" :key="c.id" class="badge" :class="c.status==='paid' ? (c.paidOnTime ? 'ok' : 'warn') : c.status==='defaulted' ? 'danger' : c.late ? 'warn' : ''">{{ c.fullName.split(' ')[0] }} · {{ c.status==='paid' ? (c.paidOnTime ? 'paid' : 'paid late') : c.status }}</span></div>
              <div class="small muted" v-if="r.payoutAmount">Paid out {{ money(r.payoutAmount) }} on {{ date(r.paidOutAt) }}</div>
            </template>
          </div>
          <button v-if="isAdmin && openRound && new Date(openRound.graceEndsAt) < new Date()" class="btn" @click="closeRound">Settle overdue round now</button>
        </div>
      </div>

      <div v-if="tab==='members'" class="card"><h2>Members</h2>
        <ul class="list"><li v-for="m in g.members" :key="m.userId"><div><div class="title">{{ m.fullName }} <span v-if="m.role==='admin'" class="badge brand">admin</span></div>
          <div class="sub">Trust score {{ m.trustScore }} · joined {{ date(m.joinedAt) }}<span v-if="m.payoutPosition"> · payout #{{ m.payoutPosition }}</span></div></div>
          <button v-if="g.status==='forming' && m.role!=='admin' && m.userId!==me" class="btn small" @click="removeMember(m.userId, m.fullName)">Propose removal</button></li></ul>
        <div v-if="isAdmin && g.status==='forming' && g.payoutOrder==='manual'" style="margin-top:1rem"><h3>Payout order</h3>
          <ol style="padding-left:1.2rem"><li v-for="(uid, i) in f.order" :key="uid" style="margin:.3rem 0"><span class="row">{{ nameOf(uid) }} <button class="btn small" @click="move(i,-1)" aria-label="Move up">↑</button><button class="btn small" @click="move(i,1)" aria-label="Move down">↓</button></span></li></ol>
          <button class="btn primary small" @click="saveOrder">Save order</button></div>
      </div>

      <div v-if="tab==='chat'" class="card"><h2>Group chat</h2>
        <div class="chat"><div v-for="m in messages" :key="m.id" class="msg" :class="{ me: m.user_id===me, system: !m.user_id }">
          <div class="who" v-if="m.user_id && m.user_id!==me">{{ m.full_name }}</div>{{ m.body }}<div class="small" style="opacity:.6">{{ dateTime(m.created_at) }}</div></div>
          <div v-if="!messages.length" class="empty">No messages yet.</div></div>
        <form class="row" style="margin-top:.75rem;flex-wrap:nowrap" @submit.prevent="send"><input v-model="chat" placeholder="Write a message…" aria-label="Message" maxlength="2000"><button class="btn primary">Send</button></form>
      </div>

      <div v-if="tab==='votes'">
        <div class="card"><h2>Propose a rule change</h2>
          <form @submit.prevent="propose"><div class="grid grid-3">
            <div class="field"><label for="ps">Setting</label><select id="ps" v-model="f.setting"><option v-for="(d, k) in settingDefs" :value="k">{{ d.label }}</option></select></div>
            <div class="field"><label for="pv">New value</label><input id="pv" v-model="f.value" required></div>
            <div class="field"><label for="pt">Title (optional)</label><input id="pt" v-model="f.title" maxlength="200"></div></div>
            <p class="small muted">Passes when more than {{ pct(g.approvalThresholdBps) }} of members vote yes. Votes expire after 72 hours.</p>
            <button class="btn primary" :disabled="busy">Open vote</button></form></div>
        <div class="card"><h2>Votes</h2>
          <ul class="list" v-if="proposals.length"><li v-for="p in proposals" :key="p.id"><div style="min-width:0"><div class="title">{{ p.title }}</div>
            <div class="sub">{{ label(p.type) }} · by {{ p.proposerName }} · {{ p.tally.yes }} yes / {{ p.tally.no }} no · {{ p.tally.needed }} of {{ p.tally.eligible }} needed<span v-if="p.status==='open'"> · closes {{ dateTime(p.expiresAt) }}</span></div></div>
            <div class="row"><span class="badge" :class="statusClass(p.status)">{{ p.status }}</span><template v-if="p.canVote"><button class="btn small primary" @click="vote(p.id,'yes')">Yes</button><button class="btn small" @click="vote(p.id,'no')">No</button></template>
              <span v-else-if="p.myVote" class="small muted">you voted {{ p.myVote }}</span></div></li></ul>
          <div v-else class="empty">No votes yet.</div></div>
      </div>

      <div v-if="tab==='loans'">
        <div class="grid grid-2">
          <div class="card"><h2>Request an emergency loan</h2>
            <p class="small muted">Funded from the group reserve ({{ money(g.reserveBalance) }}). Interest {{ pct(g.loanInterestBps) }}. Members vote on every request; unpaid balances are deducted from your payout.</p>
            <form @submit.prevent="requestLoan"><div class="field"><label for="la">Amount (₦)</label><input id="la" type="number" min="1" v-model="f.loanAmount" required></div>
              <div class="field"><label for="lt">Term (days)</label><input id="lt" type="number" min="1" max="180" v-model="f.loanTerm"></div>
              <div class="field"><label for="lr">Reason</label><input id="lr" v-model="f.loanReason" maxlength="500"></div>
              <button class="btn primary" :disabled="busy || g.status!=='active'">Request loan</button></form></div>
          <div class="card"><h2>Top up the reserve</h2><p class="small muted">Voluntary contributions grow the fund available for member loans.</p>
            <form @submit.prevent="fundReserve"><div class="field"><label for="ra">Amount (₦)</label><input id="ra" type="number" min="1" v-model="f.reserve" required></div><button class="btn" :disabled="busy">Add to reserve</button></form></div>
        </div>
        <div class="card"><h2>Group loans</h2>
          <ul class="list" v-if="loans.length"><li v-for="l in loans" :key="l.id"><div><div class="title">{{ l.borrowerName }} · {{ money(l.principal) }}</div><div class="sub">Repay {{ money(l.totalDue) }} · outstanding {{ money(l.outstanding) }}<span v-if="l.dueAt"> · due {{ date(l.dueAt) }}</span><span v-if="l.reason"> · {{ l.reason }}</span></div></div>
            <div class="row"><span class="badge" :class="statusClass(l.status)">{{ label(l.status) }}</span><button v-if="l.borrowerId===me && ['disbursed','overdue'].includes(l.status)" class="btn small primary" @click="repay(l)">Repay {{ money(l.outstanding) }}</button></div></li></ul>
          <div v-else class="empty">No loans yet.</div></div>
      </div>

      <div v-if="tab==='settings'" class="card"><h2>Group rules</h2>
        <table><tbody>
          <tr><th>Contribution</th><td>{{ money(g.contributionAmount) }} {{ g.frequency }}</td></tr>
          <tr><th>Payout order</th><td>{{ label(g.payoutOrder) }}</td></tr>
          <tr><th>Payout timing</th><td>{{ g.payoutTiming==='when_complete' ? 'As soon as everyone has paid' : 'On the due date' }}</td></tr>
          <tr><th>Grace period</th><td>{{ g.gracePeriodHours }} hours</td></tr>
          <tr><th>Late penalty</th><td>{{ pct(g.latePenaltyBps) }} of the contribution</td></tr>
          <tr><th>Loan interest</th><td>{{ pct(g.loanInterestBps) }}</td></tr>
          <tr><th>Approval threshold</th><td>more than {{ pct(g.approvalThresholdBps - 1) }} of eligible members</td></tr>
          <tr><th>Identity verification</th><td>{{ g.requireKyc ? 'Required' : 'Not required' }}</td></tr>
          <tr><th>Auto-debit (you)</th><td><label class="check"><input type="checkbox" :checked="g.myAutoDebit" @change="toggleAuto"> Debit my wallet automatically on the due date</label></td></tr>
        </tbody></table>
        <p class="small muted" style="margin-top:.75rem" v-if="g.status!=='forming'">Rules are locked once the group starts. Use the Votes tab to propose a change.</p>
      </div>
    </div>
    <div v-else-if="error" class="alert error">{{ error }}</div>`,
  };

  // ---------- Disputes ----------
  const DisputesView = {
    setup() {
      const items = ref([]);
      const groups = ref([]);
      const current = ref(null);
      const f = reactive({ groupId: '', category: 'missed_payout', description: '', transactionId: '', reply: '', resolution: '' });
      const { busy, error, run } = useAction();
      const load = async () => { items.value = await api('/disputes'); groups.value = await api('/groups'); };
      onMounted(() => run(load));
      const open = (id) => run(async () => { current.value = await api(`/disputes/${id}`); });
      const create = () => run(async () => {
        const body = { category: f.category, description: f.description };
        if (f.groupId) body.groupId = f.groupId;
        if (f.transactionId) body.transactionId = f.transactionId.trim();
        current.value = await api('/disputes', { method: 'POST', body });
        f.description = ''; f.transactionId = ''; toast('Dispute opened'); load();
      });
      const reply = () => run(async () => { current.value = await api(`/disputes/${current.value.id}/messages`, { method: 'POST', body: { body: f.reply } }); f.reply = ''; });
      const decide = (status) => run(async () => { current.value = await api(`/disputes/${current.value.id}/status`, { method: 'POST', body: { status, resolution: f.resolution || undefined } }); load(); });
      return { items, groups, current, f, busy, error, open, create, reply, decide, categories: ['missed_payout', 'wrong_amount', 'member_default', 'unauthorized_transaction', 'fraud', 'other'], ...fmt };
    },
    template: `<div><div class="topbar"><h1>{{ t('disputes') }}</h1></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="grid grid-2">
        <div>
          <form class="card" @submit.prevent="create"><h2>Raise a dispute</h2>
            <div class="field"><label for="dg">Group</label><select id="dg" v-model="f.groupId"><option value="">Not about a group</option><option v-for="g in groups" :value="g.id">{{ g.name }}</option></select></div>
            <div class="field"><label for="dcat">Category</label><select id="dcat" v-model="f.category"><option v-for="c in categories" :value="c">{{ label(c) }}</option></select></div>
            <div class="field"><label for="dt">Transaction reference (optional)</label><input id="dt" v-model="f.transactionId" placeholder="e.g. ADF-…"></div>
            <div class="field"><label for="dd">What happened?</label><textarea id="dd" v-model="f.description" required minlength="10"></textarea></div>
            <button class="btn primary" :disabled="busy">Submit</button></form>
          <div class="card"><h2>Your disputes</h2>
            <ul class="list" v-if="items.length"><li v-for="d in items" :key="d.id"><a class="item" href="#" @click.prevent="open(d.id)"><div class="title">{{ label(d.category) }}</div><div class="sub">{{ date(d.createdAt) }} · {{ d.description.slice(0, 60) }}</div></a><span class="badge" :class="statusClass(d.status)">{{ label(d.status) }}</span></li></ul>
            <div v-else class="empty">No disputes. 🎉</div></div>
        </div>
        <div class="card" v-if="current">
          <h2>{{ label(current.category) }} <span class="badge" :class="statusClass(current.status)">{{ label(current.status) }}</span></h2>
          <p class="small muted">Raised by {{ current.raisedBy.name }} on {{ dateTime(current.createdAt) }}<span v-if="current.against"> · against {{ current.against.name }}</span></p>
          <p>{{ current.description }}</p>
          <div v-if="current.transaction" class="alert info small">Transaction <span class="mono">{{ current.transaction.reference }}</span> · {{ label(current.transaction.type) }} · {{ money(current.transaction.amount) }} · {{ current.transaction.status }}</div>
          <div v-if="current.resolution" class="alert" :class="current.status==='resolved' ? 'info' : 'warn'"><b>Decision:</b> {{ current.resolution }}</div>
          <h3>Conversation</h3>
          <div class="chat"><div v-for="m in current.messages" :key="m.id" class="msg"><div class="who">{{ m.name }}</div>{{ m.body }}</div><div v-if="!current.messages.length" class="empty small">No messages yet.</div></div>
          <form v-if="!['resolved','rejected'].includes(current.status)" class="row" style="margin-top:.75rem;flex-wrap:nowrap" @submit.prevent="reply"><input v-model="f.reply" placeholder="Add a message or evidence" aria-label="Reply" required><button class="btn">Send</button></form>
          <div v-if="current.canResolve && !['resolved','rejected'].includes(current.status)" style="margin-top:1rem"><h3>Decide</h3>
            <div class="field"><label for="res">Resolution</label><textarea id="res" v-model="f.resolution"></textarea></div>
            <div class="row"><button class="btn" @click="decide('under_review')">Mark under review</button><button class="btn primary" @click="decide('resolved')">Resolve</button><button class="btn danger" @click="decide('rejected')">Reject</button></div></div>
          <details style="margin-top:1rem"><summary class="small">Audit evidence ({{ current.auditTrail.length }} records)</summary>
            <ul class="list small"><li v-for="a in current.auditTrail" :key="a.seq"><span>{{ a.action }} · {{ dateTime(a.created_at) }}</span><span class="mono">{{ a.hash.slice(0, 12) }}…</span></li></ul></details>
        </div>
      </div></div>`,
  };

  // ---------- Notifications ----------
  const NotificationsView = {
    setup() {
      const items = ref([]);
      const load = async () => { const r = await api('/notifications'); items.value = r.items; };
      onMounted(async () => { await load(); await api('/notifications/read', { method: 'POST', body: {} }); store.unread = 0; });
      const link = (n) => (n.data && n.data.groupId ? `#/groups/${n.data.groupId}` : n.data && n.data.disputeId ? '#/disputes' : '#/wallet');
      return { items, link, ...fmt };
    },
    template: `<div><div class="topbar"><h1>{{ t('notifications') }}</h1></div>
      <div class="card"><ul class="list" v-if="items.length"><li v-for="n in items" :key="n.id"><a class="item" :href="link(n)"><div class="title">{{ n.title }} <span v-if="!n.read_at" class="badge brand">new</span></div><div class="sub" style="color:var(--text)">{{ n.body }}</div><div class="sub">{{ dateTime(n.created_at) }}</div></a></li></ul>
      <div v-else class="empty">You're all caught up.</div></div></div>`,
  };

  // ---------- Profile ----------
  const ProfileView = {
    components: { TrustBadge },
    setup() {
      const me = ref(null);
      const kyc = ref(null);
      const refs = ref(null);
      const lb = ref(null);
      const mfaSetup = ref(null);
      const answer = ref(null);
      const f = reactive({ fullName: '', language: 'en', displayCurrency: 'NGN', autoWithdraw: false, idType: 'NIN', idNumber: '', mfaCode: '', pin: '', pinPassword: '', current: '', next: '', disablePassword: '', disableCode: '', question: '' });
      const { busy, error, run } = useAction();
      const load = async () => {
        me.value = await api('/me');
        Object.assign(f, { fullName: me.value.user.fullName, language: me.value.user.language, displayCurrency: me.value.user.displayCurrency, autoWithdraw: me.value.user.autoWithdraw });
        kyc.value = await api('/me/kyc');
        refs.value = await api('/me/referrals');
        lb.value = await api('/leaderboard');
      };
      onMounted(() => run(load));
      const save = () => run(async () => { const r = await api('/me', { method: 'PATCH', body: { fullName: f.fullName, language: f.language, displayCurrency: f.displayCurrency, autoWithdraw: f.autoWithdraw } }); store.user = r.user; toast('Profile saved'); });
      const submitKyc = () => run(async () => { const r = await api('/me/kyc', { method: 'POST', body: { idType: f.idType, idNumber: f.idNumber } }); toast(`Verification ${r.status}`); f.idNumber = ''; await load(); store.user = me.value.user; });
      const startMfa = () => run(async () => { mfaSetup.value = await api('/me/mfa/setup', { method: 'POST' }); });
      const enableMfa = () => run(async () => { await api('/me/mfa/enable', { method: 'POST', body: { code: f.mfaCode } }); mfaSetup.value = null; f.mfaCode = ''; toast('Two-factor authentication on'); await load(); });
      const disableMfa = () => run(async () => { await api('/me/mfa/disable', { method: 'POST', body: { password: f.disablePassword, code: f.disableCode } }); toast('Two-factor authentication off'); await load(); });
      const setPin = () => run(async () => { await api('/me/ussd-pin', { method: 'POST', body: { password: f.pinPassword, pin: f.pin } }); f.pin = ''; f.pinPassword = ''; toast('USSD PIN saved'); await load(); });
      const changePw = () => run(async () => { await api('/me/password', { method: 'POST', body: { currentPassword: f.current, newPassword: f.next } }); f.current = ''; f.next = ''; toast('Password changed'); });
      const ask = () => run(async () => { answer.value = await api('/support/assistant', { method: 'POST', body: { question: f.question } }); });
      const ticket = () => run(async () => { await api('/support/tickets', { method: 'POST', body: { subject: f.question.slice(0, 200), body: f.question } }); toast('Ticket created — our team will reach out'); answer.value = null; f.question = ''; });
      const copy = (s) => navigator.clipboard && navigator.clipboard.writeText(s).then(() => toast('Copied'));
      const logout = async () => { try { await api('/auth/logout', { method: 'POST', body: { refreshToken: store.refreshToken } }); } catch { /* ignore */ } setSession(null); go('/login'); };
      return { me, kyc, refs, lb, mfaSetup, answer, f, busy, error, save, submitKyc, startMfa, enableMfa, disableMfa, setPin, changePw, ask, ticket, copy, logout, store, ...fmt };
    },
    template: `<div v-if="me && kyc"><div class="topbar"><h1>{{ t('profile') }}</h1><button class="btn" @click="logout">{{ t('logout') }}</button></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="grid grid-2">
        <div class="card"><h2>Trust score</h2><TrustBadge :trust="me.trust"/>
          <details style="margin-top:.75rem"><summary class="small">How it's calculated</summary><table class="small"><tr v-for="(v,k) in me.trust.components" :key="k"><td>{{ k.replace(/([A-Z])/g,' $1').toLowerCase() }}</td><td class="num" :class="v<0?'neg':''">{{ v>0?'+':'' }}{{ v }}</td></tr></table></details></div>
        <form class="card" @submit.prevent="save"><h2>Personal details</h2>
          <div class="field"><label for="pn">Full name</label><input id="pn" v-model="f.fullName"></div>
          <p class="small muted">{{ me.user.phone }}<span v-if="me.user.email"> · {{ me.user.email }}</span></p>
          <div class="grid grid-2" style="gap:.75rem"><div class="field"><label for="pl">Language</label><select id="pl" v-model="f.language"><option value="en">English</option><option value="ha">Hausa</option><option value="yo">Yorùbá</option><option value="ig">Igbo</option><option value="pcm">Pidgin</option><option value="fr">Français</option></select></div>
            <div class="field"><label for="pc">Show amounts also in</label><select id="pc" v-model="f.displayCurrency"><option v-for="(r,c) in (store.meta ? store.meta.fxRates : {NGN:1})" :value="c">{{ c }}</option></select></div></div>
          <div class="field"><label class="check"><input type="checkbox" v-model="f.autoWithdraw"> Auto-withdraw payouts to my default bank account</label></div>
          <button class="btn primary" :disabled="busy">Save</button></form>
      </div>

      <div class="card"><h2>Identity verification (KYC) <span class="badge" :class="statusClass(kyc.status)">{{ kyc.status }} · tier {{ kyc.tier }}</span></h2>
        <p class="small muted">Tier limits — single withdrawal: {{ money(me.limits.singleWithdrawal) }}, 24-hour outflow: {{ money(me.limits.dailyOutflow) }}. BVN verification gives the highest tier.</p>
        <form v-if="kyc.status!=='verified' || kyc.tier < 2" @submit.prevent="submitKyc" class="row" style="align-items:flex-end">
          <div class="field" style="margin:0;flex:1;min-width:140px"><label for="kt">ID type</label><select id="kt" v-model="f.idType"><option value="NIN">NIN</option><option value="BVN">BVN</option><option value="PASSPORT">International passport</option><option value="DRIVERS_LICENSE">Driver's licence</option><option value="VOTERS_CARD">Voter's card</option></select></div>
          <div class="field" style="margin:0;flex:2;min-width:180px"><label for="kn">ID number</label><input id="kn" v-model="f.idNumber" required autocomplete="off"></div>
          <button class="btn primary" :disabled="busy">Verify</button></form>
        <ul class="list small" v-if="kyc.records.length"><li v-for="r in kyc.records" :key="r.id"><span>{{ r.idType }} ····{{ r.idLast4 }} · {{ date(r.createdAt) }}<span v-if="r.reason"> · {{ r.reason }}</span></span><span class="badge" :class="statusClass(r.status)">{{ r.status }}</span></li></ul>
      </div>

      <div class="grid grid-2">
        <div class="card"><h2>Security</h2>
          <h3>Two-factor authentication <span class="badge" :class="me.user.mfaEnabled ? 'ok' : ''">{{ me.user.mfaEnabled ? 'on' : 'off' }}</span></h3>
          <template v-if="!me.user.mfaEnabled">
            <button v-if="!mfaSetup" class="btn" @click="startMfa">Set up authenticator app</button>
            <form v-else @submit.prevent="enableMfa"><p class="small">Add this key to Google Authenticator, Authy or similar, then enter the 6-digit code.</p>
              <p class="mono" style="background:var(--surface-2);padding:.5rem;border-radius:8px">{{ mfaSetup.secret }}</p>
              <div class="field"><label for="mc">Code</label><input id="mc" v-model="f.mfaCode" inputmode="numeric" maxlength="6" required></div><button class="btn primary">Turn on</button></form>
          </template>
          <form v-else @submit.prevent="disableMfa" class="grid grid-2" style="gap:.5rem;align-items:end">
            <div class="field" style="margin:0"><label for="dp">Password</label><input id="dp" type="password" v-model="f.disablePassword" required></div>
            <div class="field" style="margin:0"><label for="dco">Code</label><input id="dco" v-model="f.disableCode" maxlength="6" required></div><button class="btn danger">Turn off</button></form>
          <h3 style="margin-top:1.25rem">Change password</h3>
          <form @submit.prevent="changePw"><div class="field"><label for="cp">Current password</label><input id="cp" type="password" v-model="f.current" autocomplete="current-password" required></div>
            <div class="field"><label for="np2">New password</label><input id="np2" type="password" v-model="f.next" autocomplete="new-password" required minlength="8"></div><button class="btn">Change password</button></form>
          <h3 style="margin-top:1.25rem">USSD PIN <span class="badge" :class="me.user.hasUssdPin ? 'ok' : ''">{{ me.user.hasUssdPin ? 'set' : 'not set' }}</span></h3>
          <p class="small muted">Use AdashiFunds from any phone without internet: check your balance and pay contributions by USSD.</p>
          <form @submit.prevent="setPin" class="grid grid-2" style="gap:.5rem;align-items:end"><div class="field" style="margin:0"><label for="up">4-digit PIN</label><input id="up" v-model="f.pin" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></div>
            <div class="field" style="margin:0"><label for="upp">Password</label><input id="upp" type="password" v-model="f.pinPassword" required></div><button class="btn">Save PIN</button></form>
        </div>
        <div>
          <div class="card" v-if="refs"><h2>Invite friends</h2>
            <p class="small muted">Earn points when someone you invite makes their first contribution.</p>
            <div class="row"><span class="badge brand mono" style="font-size:1rem;padding:.4rem .8rem">{{ refs.code }}</span><button class="btn small" @click="copy(refs.link)">Copy invite link</button><b>{{ refs.points }} points</b></div>
            <ul class="list small" v-if="refs.referred.length" style="margin-top:.5rem"><li v-for="r in refs.referred" :key="r.joinedAt"><span>{{ r.name }}</span><span class="badge" :class="r.active ? 'ok' : ''">{{ r.active ? 'saving' : 'joined' }}</span></li></ul></div>
          <div class="card" v-if="lb"><h2>Leaderboard</h2><div class="grid grid-2" style="gap:.5rem">
            <div><h3 class="small muted">Top savers</h3><ol class="small" style="padding-left:1.1rem;margin:0"><li v-for="s in lb.savers" :key="s.rank">{{ s.name }} — {{ s.onTimeContributions }} on time</li></ol></div>
            <div><h3 class="small muted">Top referrers</h3><ol class="small" style="padding-left:1.1rem;margin:0"><li v-for="s in lb.referrers" :key="s.rank">{{ s.name }} — {{ s.points }}</li></ol></div></div></div>
          <div class="card"><h2>Help &amp; support</h2>
            <form @submit.prevent="ask"><div class="field"><label for="q">Ask a question</label><input id="q" v-model="f.question" placeholder="e.g. What happens if I pay late?" required></div><button class="btn">Ask</button></form>
            <div v-if="answer" class="alert info" style="margin-top:.75rem">{{ answer.answer }}<div v-if="!answer.confident" style="margin-top:.5rem"><button class="btn small" @click="ticket">Open a support ticket</button></div></div></div>
        </div>
      </div></div>`,
  };

  // ---------- Admin ----------
  const AdminView = {
    setup() {
      const stats = ref(null);
      const flags = ref([]);
      const kyc = ref([]);
      const auditResult = ref(null);
      const recon = ref(null);
      const sched = ref(null);
      const { error, run } = useAction();
      const load = async () => { stats.value = await api('/admin/stats'); flags.value = await api('/admin/fraud-flags'); kyc.value = await api('/admin/kyc/pending'); };
      onMounted(() => run(load));
      const review = (id, status) => run(async () => { await api(`/admin/fraud-flags/${id}`, { method: 'POST', body: { status } }); load(); });
      const reviewKyc = (id, status) => run(async () => { await api(`/admin/kyc/${id}/review`, { method: 'POST', body: { status, reason: status === 'rejected' ? 'Document could not be verified' : undefined } }); load(); });
      const verify = () => run(async () => { auditResult.value = await api('/admin/audit/verify'); });
      const reconcile = () => run(async () => { recon.value = await api('/admin/ledger/reconcile'); });
      const runJobs = () => run(async () => { sched.value = await api('/admin/scheduler/run', { method: 'POST' }); load(); });
      return { stats, flags, kyc, auditResult, recon, sched, error, review, reviewKyc, verify, reconcile, runJobs, ...fmt };
    },
    template: `<div><div class="topbar"><h1>Back office</h1></div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="grid grid-3" v-if="stats">
        <div class="card stat"><div class="label">Users</div><div class="value">{{ stats.users }}</div><div class="small muted">{{ stats.verifiedUsers }} verified</div></div>
        <div class="card stat"><div class="label">Groups</div><div class="value">{{ stats.groups }}</div><div class="small muted">{{ stats.activeGroups }} active</div></div>
        <div class="card stat"><div class="label">Contributed</div><div class="value">{{ money(stats.totalContributed) }}</div></div>
        <div class="card stat"><div class="label">Paid out</div><div class="value">{{ money(stats.totalPaidOut) }}</div></div>
        <div class="card stat"><div class="label">Fee revenue</div><div class="value">{{ money(stats.feeRevenue) }}</div></div>
        <div class="card stat"><div class="label">Open risk flags</div><div class="value">{{ stats.openFraudFlags }}</div><div class="small muted">{{ stats.openDisputes }} open disputes</div></div>
      </div>
      <div class="card"><h2>Integrity checks</h2><div class="row"><button class="btn" @click="verify">Verify audit chain</button><button class="btn" @click="reconcile">Reconcile ledger</button><button class="btn" @click="runJobs">Run scheduler now</button></div>
        <div v-if="auditResult" class="alert" :class="auditResult.valid ? 'info' : 'error'" style="margin-top:.75rem">Audit chain {{ auditResult.valid ? 'intact' : 'BROKEN at #' + auditResult.brokenAtSeq }} · {{ auditResult.checked }} records<span v-if="auditResult.headHash" class="mono"> · head {{ auditResult.headHash.slice(0,16) }}…</span></div>
        <div v-if="recon" class="alert" :class="recon.ok ? 'info' : 'error'">Ledger {{ recon.ok ? 'balanced' : 'MISMATCH' }} · net {{ recon.netTotal }} · {{ recon.mismatches.length }} account mismatches</div>
        <pre v-if="sched" class="small mono" style="white-space:pre-wrap">{{ JSON.stringify(sched, null, 1) }}</pre></div>
      <div class="card"><h2>Risk flags</h2><div class="table-wrap"><table v-if="flags.length"><thead><tr><th>User</th><th>Rule</th><th>Score</th><th>Details</th><th>Action</th><th></th></tr></thead>
        <tbody><tr v-for="x in flags" :key="x.id"><td>{{ x.full_name }}<div class="small muted">{{ x.phone }}</div></td><td>{{ x.rule }}</td><td>{{ x.score }}</td><td class="small">{{ x.details && x.details.reason }}</td><td><span class="badge" :class="statusClass(x.action)">{{ x.action }}</span></td>
          <td><div class="row"><button class="btn small" @click="review(x.id,'cleared')">Clear</button><button class="btn small danger" @click="review(x.id,'confirmed')">Confirm</button></div></td></tr></tbody></table>
        <div v-else class="empty">No open flags.</div></div></div>
      <div class="card"><h2>KYC review queue</h2><ul class="list" v-if="kyc.length"><li v-for="k in kyc" :key="k.id"><div><div class="title">{{ k.fullName }}</div><div class="sub">{{ k.idType }} ····{{ k.idLast4 }} · {{ date(k.createdAt) }}</div></div>
        <div class="row"><button class="btn small primary" @click="reviewKyc(k.id,'verified')">Approve</button><button class="btn small danger" @click="reviewKyc(k.id,'rejected')">Reject</button></div></li></ul><div v-else class="empty">Nothing to review.</div></div>
    </div>`,
  };

  // ---------- Root ----------
  const App = {
    components: { AuthView, HomeView, WalletView, GroupsView, NewGroupView, JoinGroupView, GroupDetailView, DisputesView, NotificationsView, ProfileView, AdminView },
    setup() {
      const ready = ref(false);
      onMounted(async () => {
        try { store.meta = await api('/meta'); } catch { /* offline */ }
        await loadMe();
        ready.value = true;
      });
      const view = computed(() => {
        const p = route.path;
        if (!store.accessToken || p === '/login' || p === '/register') return { c: 'AuthView', key: p };
        if (p === '/' || p === '') return { c: 'HomeView' };
        if (p === '/wallet') return { c: 'WalletView', key: JSON.stringify(route.query) };
        if (p === '/groups') return { c: 'GroupsView' };
        if (p === '/groups/new') return { c: 'NewGroupView' };
        if (p === '/groups/join') return { c: 'JoinGroupView' };
        const m = p.match(/^\/groups\/([\w-]+)$/);
        if (m) return { c: 'GroupDetailView', props: { id: m[1] }, key: m[1] };
        if (p === '/disputes') return { c: 'DisputesView' };
        if (p === '/notifications') return { c: 'NotificationsView' };
        if (p === '/profile') return { c: 'ProfileView' };
        if (p === '/admin') return { c: 'AdminView' };
        return { c: 'HomeView' };
      });
      // Support "adashi://pay?to=..." links pasted or scanned into the browser.
      watch(() => route.path, (p) => { if (p.startsWith('/pay')) go(`/wallet?action=send&to=${encodeURIComponent(route.query.to || '')}&amount=${route.query.amount || ''}`); });
      const nav = computed(() => {
        const items = [
          { to: '/', ico: '⌂', label: t('home') }, { to: '/wallet', ico: '₦', label: t('wallet') }, { to: '/groups', ico: '◎', label: t('groups') },
          { to: '/notifications', ico: '🔔', label: t('notifications'), badge: store.unread }, { to: '/disputes', ico: '⚖', label: t('disputes') }, { to: '/profile', ico: '☺', label: t('profile') },
        ];
        if (store.user && store.user.role === 'admin') items.push({ to: '/admin', ico: '⚙', label: t('admin') });
        return items;
      });
      const active = (to) => (to === '/' ? route.path === '/' : route.path.startsWith(to));
      return { ready, view, nav, active, store };
    },
    template: `
      <template v-if="ready">
        <component v-if="view.c==='AuthView'" :is="view.c" :key="view.key"/>
        <div v-else class="shell">
          <aside class="sidebar" aria-label="Main navigation">
            <div class="brand"><span class="logo">A</span> AdashiFunds</div>
            <a v-for="n in nav" :key="n.to" :href="'#' + n.to" class="nav-link" :class="{ active: active(n.to) }"><span aria-hidden="true">{{ n.ico }}</span> {{ n.label }}<span v-if="n.badge" class="badge danger">{{ n.badge }}</span></a>
          </aside>
          <main class="main"><component :is="view.c" v-bind="view.props || {}" :key="view.key || view.c"/></main>
          <nav class="bottom-nav" aria-label="Main navigation">
            <a v-for="n in nav.filter(x => x.to !== '/disputes' && x.to !== '/admin')" :key="n.to" :href="'#' + n.to" :class="{ active: active(n.to) }"><span class="ico" aria-hidden="true">{{ n.ico }}</span>{{ n.label }}<span v-if="n.badge"> ({{ n.badge }})</span></a>
          </nav>
        </div>
        <div v-if="store.toast" class="toast" role="status">{{ store.toast }}</div>
      </template>
      <div v-else class="boot">Loading AdashiFunds…</div>`,
  };

  createApp(App).mount('#app');
})();
