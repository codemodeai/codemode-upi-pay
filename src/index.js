/*
 * codemode-upi-pay: accept UPI payments straight into your own bank account, confirmed automatically from your
 * bank's credit-alert emails in Gmail. No payment gateway, no fees, no KYC with a third party.
 *
 *   const { createUpiPay, PostgresStore } = require('codemode-upi-pay');
 *   const upi = createUpiPay({ vpa: 'shop@okhdfcbank', payeeName: 'My Shop', gmail: { user, appPassword }, store });
 *   const payment = await upi.createPayment({ amount: 499, orderId: 'ORDER-1' });   // -> QR + UPI link
 *   upi.on('paid', (p) => fulfil(p.orderId));                                      // money arrived
 *
 * How a payment is confirmed:
 *   1. Each payment asks for a unique amount (₹499 -> ₹499.37) and carries a reference note (PAYK7Q2M9XH).
 *   2. The customer pays with any UPI app; the money goes to your bank account.
 *   3. Your bank emails you a credit alert. sync() reads new emails over IMAP (read-only), keeps only genuine ones
 *      (bank domain + Gmail's DKIM/DMARC verdict) and pulls out the amount, the 12-digit UTR and the note.
 *   4. The alert is matched to the payment (by note, else by the unique amount) and 'paid' fires once.
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const link = require('./link');
const alerts = require('./alerts');
const inbox = require('./inbox');
const { MemoryStore } = require('./stores/memory');
const { PostgresStore } = require('./stores/postgres');
const { RULES, UpiError, fail, viewStatus } = require('./rules');
const webhook = require('./webhook');

const newId = () => 'pay_' + crypto.randomBytes(12).toString('hex');

function createUpiPay(opts) {
  opts = Object.assign({ expiresInMinutes: 10, refPrefix: 'PAY', syncThrottleSeconds: 10, testMode: false }, opts);
  if (!opts.vpa || !link.VPA_RE.test(opts.vpa)) throw new Error('createUpiPay: set vpa to your UPI ID, e.g. "yourshop@okhdfcbank".');
  if (!opts.payeeName) throw new Error('createUpiPay: set payeeName, the name customers see in their UPI app.');
  const prefix = link.checkPrefix(opts.refPrefix);
  const refRe = link.refPattern(prefix);
  const minutes = Math.max(2, Math.min(60, parseInt(opts.expiresInMinutes, 10) || 10));
  const log = opts.logger || { info() {}, warn: (...a) => console.warn('[upi]', ...a), error: (...a) => console.error('[upi]', ...a) };
  const gmail = opts.gmail && opts.gmail.user && opts.gmail.appPassword ? opts.gmail : null;
  const store = opts.store || new MemoryStore();
  if (!opts.store) log.warn('No store given: using MemoryStore. Payments are lost when the process restarts; use PostgresStore in production.');
  if (!gmail && !opts.testMode) log.warn('No gmail { user, appPassword } given: payments can\'t be confirmed automatically.');

  const events = new EventEmitter();
  events.on('error', () => {});                   // an unhandled 'error' event must never crash the app
  let ready = null, timer = null, running = null;
  const init = () => (ready = ready || Promise.resolve(store.init && store.init()));

  // What the customer's browser may see. No customer details or metadata.
  async function toPublic(p, withQr) {
    if (!p) return null;
    const upiLink = link.payLink({ vpa: opts.vpa, name: opts.payeeName, amount: p.payAmount, ref: p.ref });
    const out = {
      id: p.id, status: viewStatus(p), amount: p.amount, payAmount: p.payAmount, extraPaise: Math.round((p.payAmount - p.amount) * 100),
      currency: 'INR', ref: p.ref, upiId: opts.vpa, payeeName: opts.payeeName, link: upiLink,
      orderId: p.orderId, createdAt: p.createdAt, expiresAt: p.expiresAt, serverTime: new Date().toISOString(),
      paidAt: p.paidAt, paidAmount: p.paidAmount, utr: p.utr, bank: p.bank
    };
    if (opts.testMode) out.testMode = true;
    if (withQr) out.qr = await link.qrSvg(upiLink);
    return out;
  }

  // Full record for your server, webhooks and 'paid' handlers.
  function toPrivate(p) {
    return Object.assign({}, p, { status: viewStatus(p) });
  }

  async function announce(settled) {
    for (const p of settled || []) {
      const full = toPrivate(p);
      events.emit(p.status, full);              // 'paid' or 'underpaid'
      if (opts.onPaid && p.status === 'paid') {
        try { await opts.onPaid(full); } catch (e) { log.error('onPaid failed for', p.id, e && e.message); events.emit('error', e); }
      }
      if (opts.webhook && opts.webhook.url) {
        await webhook.deliver(opts.webhook, 'payment.' + p.status, full, log).catch((e) => events.emit('error', e));
      }
    }
  }

  const api = {
    store,
    on: (ev, fn) => { events.on(ev, fn); return api; },
    off: (ev, fn) => { events.off(ev, fn); return api; },

    /*
     * Start a payment. input: { amount (rupees, >= 1), orderId?, customer?, note?, metadata? }
     * Returns the public payment (safe to send to the browser) including qr (SVG) and link (upi://...).
     * The same orderId + amount while its QR is still valid returns the same payment.
     */
    async createPayment(input) {
      await init();
      input = input || {};
      const amount = Number(input.amount);
      if (!(amount >= 1) || Math.round(amount * 100) !== amount * 100 || amount > 1e7) fail('BAD_AMOUNT');
      const clean = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
      const p = await store.createPayment({
        id: newId(), amount, ref: link.newRef(prefix), minutes,
        orderId: clean(input.orderId, 120), customer: clean(input.customer, 200), note: clean(input.note, 300),
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
      });
      return toPublic(p, input.qr !== false);
    },

    // The payment as your server sees it (customer, metadata...). Checks the inbox first if it's still open.
    async getPayment(id, o) {
      await init();
      let p = await store.getPayment(id);
      if (!p) return null;
      if ((!o || o.sync !== false) && p.status === 'pending' && Date.parse(p.expiresAt) + RULES.matchAfterMs > Date.now()) {
        await api.sync().catch(() => null);
        p = await store.getPayment(id);
      }
      return toPrivate(p);
    },

    // The same, trimmed for the customer's browser.
    async getPublicPayment(id, o) {
      const p = await api.getPayment(id, o);
      return p ? toPublic(p, o && o.qr) : null;
    },

    async listPayments(o) { await init(); return (await store.listPayments(o)).map(toPrivate); },

    // Money that arrived but matched no payment (wrong amount, very late...). Show these to an admin.
    async unmatchedPayments(limit) { await init(); return store.unmatchedAlerts(limit); },

    /*
     * "I've paid": the customer types the 12-digit UTR from their UPI app. It only works if a genuine bank alert with
     * that UTR arrived and wasn't used. Returns { result: 'paid'|'underpaid'|'not_found'|'used', payment }.
     */
    async claimUtr(id, utr) {
      await init();
      const u = String(utr || '').replace(/\D/g, '');
      if (!/^\d{12}$/.test(u)) fail('BAD_UTR');
      let r = await store.claimUtr(id, u);
      if (r.result === 'not_found') {                 // maybe the email just arrived: read the inbox and try once more
        const s = await api.sync({ force: true }).catch(() => null);
        if (s && s.credited.some((p) => p.id === String(id))) r = { result: 'paid', payment: await store.getPayment(id), settled: false };
        else if (s && s.alerts) r = await store.claimUtr(id, u).catch((e) => (e.code === 'TOO_MANY_TRIES' ? r : Promise.reject(e)));
      }
      if (r.settled) await announce([r.payment]);
      return { result: r.result, payment: toPrivate(r.payment), triesLeft: Math.max(0, RULES.maxUtrTries - (r.payment.utrTries || 0)) };
    },

    /*
     * Read new bank alerts and settle payments. Throttled (one run per syncThrottleSeconds across all instances
     * sharing the store) unless force. Returns { ran, alerts, credited: [payments], error }.
     */
    async sync(o) {
      await init();
      if (running) return running;
      running = (async () => {
        const out = { ran: false, alerts: 0, credited: [], error: null };
        if (!gmail) {
          out.credited = await store.matchAlerts();
          await announce(out.credited);
          return out;
        }
        const state = await store.claimSync(o && o.force ? 0 : opts.syncThrottleSeconds);
        if (!state) return out;
        out.ran = true;
        try {
          const r = await (opts._readInbox || inbox.readInbox)({
            user: gmail.user, appPassword: gmail.appPassword, alertSenders: opts.alertSenders, authServer: opts.authServer,
            refRe, ownVpa: opts.vpa, timeoutMs: opts.inboxTimeoutMs
          }, state);
          out.alerts = r.alerts.length;
          out.credited = await store.ingestAlerts(r.alerts);
          await store.finishSync({ lastUid: r.lastUid, uidValidity: r.uidValidity, error: null });
        } catch (e) {
          out.error = inbox.describeError(e);
          await store.finishSync({ lastUid: null, uidValidity: null, error: out.error }).catch(() => null);
          log.error(out.error);
          events.emit('error', e);
        }
        await announce(out.credited);
        if (out.credited.length || out.error) events.emit('synced', out);
        return out;
      })();
      try { return await running; } finally { running = null; }
    },

    // Keep checking the inbox in the background (for long-running servers; serverless apps sync on status checks).
    start(everySeconds) {
      api.stop();
      const ms = Math.max(5, everySeconds || 15) * 1000;
      timer = setInterval(() => { api.sync().catch(() => null); }, ms);
      if (timer.unref) timer.unref();
      api.sync().catch(() => null);
      return api;
    },
    stop() { if (timer) clearInterval(timer); timer = null; return api; },

    // Setup check without secrets.
    async status() {
      await init();
      return { upiId: opts.vpa, payeeName: opts.payeeName, inboxConfigured: !!gmail, testMode: !!opts.testMode, inbox: await store.syncStatus() };
    },

    // testMode only: pretend the bank's alert for this payment arrived (to build your flow without real money).
    async simulatePayment(id, amount) {
      if (!opts.testMode) throw new UpiError('TEST_MODE_ONLY', 'simulatePayment only works with testMode: true.', 403);
      await init();
      const p = await store.getPayment(id);
      if (!p) fail('NOT_FOUND');
      const utr = String(crypto.randomInt(100000, 999999)) + String(crypto.randomInt(100000, 999999));
      const settled = await store.ingestAlerts([{ utr, amount: amount || p.payAmount, bank: 'Test Bank', payer: 'test@upi', ref: p.ref, receivedAt: new Date().toISOString() }]);
      await announce(settled);
      return toPrivate(await store.getPayment(id));
    },

    toPublic,
    handler: (o) => require('./http').createHandler(api, Object.assign({ testMode: opts.testMode }, o)),
    options: { vpa: opts.vpa, payeeName: opts.payeeName, refPrefix: prefix, expiresInMinutes: minutes, testMode: !!opts.testMode }
  };
  return api;
}

module.exports = {
  createUpiPay, MemoryStore, PostgresStore, UpiError, RULES,
  verifyWebhook: webhook.verify, signWebhook: webhook.sign,
  // lower-level pieces, if you want to build your own flow
  parseAlert: alerts.parseAlert, verifySender: alerts.verifySender, toAlert: alerts.toAlert, readInbox: inbox.readInbox,
  payLink: link.payLink, qrSvg: link.qrSvg
};
