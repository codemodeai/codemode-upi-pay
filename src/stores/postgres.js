/*
 * PostgreSQL store (works with Supabase, Neon, RDS, any Postgres 13+). All the money rules run inside the
 * database (sql/postgres.sql), so several server instances can share it safely.
 *
 *   new PostgresStore({ connectionString: process.env.DATABASE_URL })   // uses the `pg` package
 *   new PostgresStore({ pool })                                         // your own pg.Pool / client
 *   new PostgresStore({ client })                                       // anything with query(text, params) -> { rows }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { UpiError, MESSAGES, round2 } = require('../rules');

const SQL_FILE = path.join(__dirname, '..', '..', 'sql', 'postgres.sql');
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const num = (v) => (v == null ? null : round2(v));

function toPayment(r) {
  if (!r || r.id == null) return null;
  return {
    id: r.id, amount: num(r.amount), payAmount: num(r.pay_amount), ref: r.ref, status: r.status,
    orderId: r.order_id, customer: r.customer, note: r.note, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {},
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), paidAt: iso(r.paid_at), paidAmount: num(r.paid_amount),
    utr: r.utr, bank: r.bank, payer: r.payer, matchedBy: r.matched_by, utrTries: Number(r.utr_tries) || 0
  };
}

// Database exceptions like 'NO_FREE_AMOUNT' become UpiErrors with friendly messages.
function mapError(e) {
  const code = Object.keys(MESSAGES).find((k) => String(e && e.message).includes(k));
  if (code) return new UpiError(code, MESSAGES[code][0], MESSAGES[code][1]);
  return e;
}

class PostgresStore {
  constructor(opts) {
    opts = opts || {};
    if (opts.client) this.db = opts.client;
    else if (opts.pool) this.db = opts.pool;
    else {
      let pg;
      try { pg = require('pg'); } catch (e) { throw new Error('PostgresStore needs the "pg" package: npm install pg'); }
      this.db = new pg.Pool({ connectionString: opts.connectionString, ssl: opts.ssl, max: opts.max || 5 });
    }
    this.autoMigrate = opts.migrate !== false;
  }

  async q(text, params) {
    try {
      const r = await this.db.query(text, params);
      return r.rows || [];
    } catch (e) {
      throw mapError(e);
    }
  }

  // Creates / updates the tables and functions. Safe to run on every start.
  async migrate() {
    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    if (typeof this.db.exec === 'function') await this.db.exec(sql);   // e.g. PGlite
    else await this.db.query(sql);
  }

  async init() { if (this.autoMigrate) await this.migrate(); }

  async createPayment(i) {
    const rows = await this.q('select * from upi_create_payment($1, $2, $3, $4, $5, $6, $7, $8)',
      [i.id, i.amount, i.ref, i.minutes, i.orderId || null, i.customer || null, i.note || null, JSON.stringify(i.metadata || {})]);
    return toPayment(rows[0]);
  }

  async getPayment(id) {
    return toPayment((await this.q('select * from upi_payments where id = $1', [String(id)]))[0]);
  }

  async listPayments(opts) {
    opts = opts || {};
    const rows = await this.q('select * from upi_payments where ($1::text is null or status = $1) and ($2::text is null or order_id = $2) order by created_at desc limit $3',
      [opts.status || null, opts.orderId || null, Math.min(opts.limit || 50, 500)]);
    return rows.map(toPayment);
  }

  async ingestAlerts(alerts) {
    const list = (alerts || []).map((a) => ({ utr: a.utr, amount: Number(a.amount).toFixed(2), bank: a.bank || '', payer: a.payer || '', ref: a.ref || '', receivedAt: a.receivedAt }));
    return (await this.q('select * from upi_ingest_alerts($1::jsonb)', [JSON.stringify(list)])).map(toPayment);
  }

  async matchAlerts() { return (await this.q('select * from upi_match_alerts()')).map(toPayment); }

  async claimUtr(id, utr) {
    const rows = await this.q('select upi_claim_utr($1, $2) as r', [String(id), utr]);
    let r = rows[0].r;
    if (typeof r === 'string') r = JSON.parse(r);
    return { result: r.result, settled: !!r.settled, payment: await this.getPayment(id) };
  }

  async claimSync(minSeconds) {
    const r = (await this.q('select * from upi_claim_sync($1)', [minSeconds]))[0];
    return r ? { lastUid: Number(r.last_uid), uidValidity: Number(r.uid_validity) } : null;
  }

  async finishSync(r) {
    await this.q('select upi_finish_sync($1, $2, $3)', [r.lastUid == null ? null : r.lastUid, r.uidValidity == null ? null : r.uidValidity, r.error || null]);
  }

  async syncStatus() {
    const r = (await this.q('select last_run, last_ok, last_error from upi_sync where id = 1'))[0] || {};
    const lastRun = iso(r.last_run);
    return { lastRun: lastRun && lastRun.startsWith('1970') ? null : lastRun, lastOk: iso(r.last_ok), lastError: r.last_error || null };
  }

  async unmatchedAlerts(limit) {
    const rows = await this.q('select * from upi_alerts where payment_id is null order by received_at desc limit $1', [limit || 50]);
    return rows.map((a) => ({ utr: a.utr, amount: num(a.amount), bank: a.bank, payer: a.payer, ref: a.ref, receivedAt: iso(a.received_at), paymentId: null }));
  }

  async close() { if (this.db && typeof this.db.end === 'function') await this.db.end(); }
}

module.exports = { PostgresStore };
