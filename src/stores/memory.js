/*
 * In-memory store: for development, tests and single-process apps that don't need payments to survive a restart.
 * For production use PostgresStore (or write your own store with the same methods; see README "Custom store").
 */
'use strict';

const { RULES, fail, round2 } = require('../rules');

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);

class MemoryStore {
  constructor() {
    this.payments = new Map();   // id -> payment
    this.alerts = new Map();     // utr -> alert (+ paymentId)
    this.sync = { lastRun: 0, lastUid: 0, uidValidity: 0, lastOk: null, lastError: null };
  }

  async init() {}

  // input: { id, amount, ref, expiresAt, orderId, customer, note, metadata, minutes }
  async createPayment(input) {
    const amount = round2(input.amount);
    if (!(amount >= 1) || Math.abs(amount - Number(input.amount)) > 1e-9) fail('BAD_AMOUNT');
    const now = Date.now();
    if (input.orderId) {
      const open = [...this.payments.values()].filter((p) => p.orderId === input.orderId && p.status === 'pending' && Date.parse(p.expiresAt) > now);
      const same = open.filter((p) => p.amount === amount && Date.parse(p.expiresAt) > now + 2 * 60e3).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (same) return clone(same);                                       // reopening the same checkout
      if (open.length >= RULES.maxOpenPerOrder) fail('TOO_MANY_OPEN');
    }
    const free = [];
    for (let paise = 1; paise <= 99; paise++) {
      const pay = round2(amount + paise / 100);
      const taken = [...this.payments.values()].some((p) => p.status === 'pending' && p.payAmount === pay && Date.parse(p.expiresAt) > now - RULES.matchAfterMs) ||
        [...this.alerts.values()].some((a) => !a.paymentId && a.amount === pay && Date.parse(a.receivedAt) > now - RULES.holdAfterAlertMs);
      if (!taken) free.push(pay);
    }
    if (!free.length) fail('NO_FREE_AMOUNT');
    const p = {
      id: input.id, amount, payAmount: free[Math.floor(Math.random() * free.length)], ref: input.ref, status: 'pending',
      orderId: input.orderId || null, customer: input.customer || null, note: input.note || null, metadata: input.metadata || {},
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + input.minutes * 60e3).toISOString(),
      paidAt: null, paidAmount: null, utr: null, bank: null, payer: null, matchedBy: null, utrTries: 0
    };
    this.payments.set(p.id, p);
    return clone(p);
  }

  async getPayment(id) { return clone(this.payments.get(String(id))); }

  async listPayments(opts) {
    opts = opts || {};
    return [...this.payments.values()].filter((p) => (!opts.status || p.status === opts.status) && (!opts.orderId || p.orderId === opts.orderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit || 50).map(clone);
  }

  // Save genuine alerts (repeats ignored) and match them. Returns the payments that got settled.
  async ingestAlerts(alerts) {
    for (const a of alerts || []) {
      if (!/^\d{12}$/.test(a.utr) || !(Number(a.amount) > 0) || this.alerts.has(a.utr)) continue;
      const at = Math.min(Date.parse(a.receivedAt) || Date.now(), Date.now());
      this.alerts.set(a.utr, { utr: a.utr, amount: round2(a.amount), bank: a.bank || null, payer: a.payer || null, ref: a.ref || null, receivedAt: new Date(at).toISOString(), paymentId: null });
    }
    return this.matchAlerts();
  }

  _inWindow(p, a, afterMs) {
    const t = Date.parse(a.receivedAt);
    return t >= Date.parse(p.createdAt) - RULES.matchBeforeMs && t <= Date.parse(p.expiresAt) + afterMs;
  }

  _settle(p, a, how) {
    if (p.status !== 'pending' || a.paymentId) return null;
    a.paymentId = p.id;
    Object.assign(p, { status: a.amount + 0.001 >= p.payAmount ? 'paid' : 'underpaid', paidAt: new Date().toISOString(), paidAmount: a.amount,
      utr: a.utr, bank: a.bank, payer: a.payer, matchedBy: how });
    return clone(p);
  }

  async matchAlerts() {
    const settled = [];
    const open = () => [...this.payments.values()].filter((p) => p.status === 'pending');
    const fresh = [...this.alerts.values()].filter((a) => !a.paymentId && Date.parse(a.receivedAt) > Date.now() - RULES.lookBackMs)
      .sort((x, y) => x.receivedAt.localeCompare(y.receivedAt));
    for (const a of fresh) {
      let p = null, how = 'ref';
      if (a.ref) p = open().find((x) => x.ref === a.ref && this._inWindow(x, a, RULES.matchAfterMs)) || null;
      if (!p) {
        const hits = open().filter((x) => x.payAmount === a.amount && this._inWindow(x, a, RULES.matchAfterMs));
        if (hits.length === 1) { p = hits[0]; how = 'amount'; }
      }
      const done = p && this._settle(p, a, how);
      if (done) settled.push(done);
    }
    return settled;
  }

  // Returns { result: 'paid' | 'underpaid' | 'not_found' | 'used', payment, settled }.
  async claimUtr(id, utr) {
    const p = this.payments.get(String(id));
    if (!p) fail('NOT_FOUND');
    if (p.status !== 'pending') return { result: p.status, payment: clone(p), settled: false };
    if (p.utrTries >= RULES.maxUtrTries) fail('TOO_MANY_TRIES');
    p.utrTries++;
    const a = this.alerts.get(utr);
    if (!a || !this._inWindow(p, a, RULES.utrAfterMs)) return { result: 'not_found', payment: clone(p), settled: false };
    if (a.paymentId) return { result: 'used', payment: clone(p), settled: false };
    const done = this._settle(p, a, 'utr');
    return { result: done.status, payment: done, settled: true };
  }

  // Inbox reader throttle: where to continue from, or null if a reader ran in the last minSeconds.
  async claimSync(minSeconds) {
    if (Date.now() - this.sync.lastRun < minSeconds * 1000) return null;
    this.sync.lastRun = Date.now();
    return { lastUid: this.sync.lastUid, uidValidity: this.sync.uidValidity };
  }

  async finishSync(r) {
    if (r.lastUid != null) {
      this.sync.lastUid = r.uidValidity === this.sync.uidValidity ? Math.max(this.sync.lastUid, r.lastUid) : r.lastUid;
      this.sync.uidValidity = r.uidValidity;
    }
    if (!r.error) this.sync.lastOk = new Date().toISOString();
    this.sync.lastError = r.error ? String(r.error).slice(0, 300) : null;
  }

  async syncStatus() {
    return { lastRun: this.sync.lastRun ? new Date(this.sync.lastRun).toISOString() : null, lastOk: this.sync.lastOk, lastError: this.sync.lastError };
  }

  // Unmatched genuine alerts: money that arrived but matched no payment (show these to an admin).
  async unmatchedAlerts(limit) {
    return [...this.alerts.values()].filter((a) => !a.paymentId).sort((x, y) => y.receivedAt.localeCompare(x.receivedAt)).slice(0, limit || 50).map(clone);
  }
}

module.exports = { MemoryStore };
