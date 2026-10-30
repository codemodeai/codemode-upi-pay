// The same money rules, checked against MemoryStore and PostgresStore (real Postgres, run in-process by PGlite).
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, PostgresStore } = require('../src');
const { newRef } = require('../src/link');

const MIN = 60e3;
let seq = 0;
const ids = () => 'pay_' + String(++seq).padStart(24, '0');
const utrs = () => String(427700000000 + (++seq));
const alert = (o) => Object.assign({ utr: utrs(), bank: 'HDFC Bank', payer: 'a@okaxis', ref: '', receivedAt: new Date().toISOString() }, o);

const BACKENDS = {
  memory: {
    make: async () => new MemoryStore(),
    // move a payment back in time by m minutes (created and expiry)
    age: async (s, id, m) => { const p = s.payments.get(id); p.createdAt = new Date(Date.parse(p.createdAt) - m * MIN).toISOString(); p.expiresAt = new Date(Date.parse(p.expiresAt) - m * MIN).toISOString(); }
  },
  postgres: {
    make: async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const db = new PGlite();
      const s = new PostgresStore({ client: db });
      await s.init();
      await s.init();                                             // migrations are safe to run twice
      s.raw = db;
      return s;
    },
    age: async (s, id, m) => { await s.raw.query("update upi_payments set created_at = created_at - make_interval(mins => $2), expires_at = expires_at - make_interval(mins => $2) where id = $1", [id, m]); }
  }
};

for (const [name, B] of Object.entries(BACKENDS)) {
  const create = (s, o) => s.createPayment(Object.assign({ id: ids(), amount: 100, ref: newRef('PAY'), minutes: 10 }, o));

  test(name + ': each open payment asks for its own amount (price + 1..99 paise)', async () => {
    const s = await B.make();
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const p = await create(s);
      assert.ok(p.payAmount > 100 && p.payAmount < 101, 'between ₹100.01 and ₹100.99');
      assert.ok(!seen.has(p.payAmount), 'never the same amount twice while open');
      seen.add(p.payAmount);
      assert.equal(p.status, 'pending');
    }
    await assert.rejects(create(s, { amount: 0.5 }), (e) => e.code === 'BAD_AMOUNT');
    await assert.rejects(create(s, { amount: 10.555 }), (e) => e.code === 'BAD_AMOUNT');
  });

  test(name + ': 99 slots per amount, then a clear error', async () => {
    const s = await B.make();
    for (let i = 0; i < 99; i++) await create(s, { amount: 7 });
    await assert.rejects(create(s, { amount: 7 }), (e) => e.code === 'NO_FREE_AMOUNT' && e.status === 429);
    assert.ok(await create(s, { amount: 8 }), 'other amounts unaffected');
  });

  test(name + ': same order + amount while open returns the same payment', async () => {
    const s = await B.make();
    const a = await create(s, { orderId: 'ORD-1' });
    const b = await create(s, { orderId: 'ORD-1' });
    assert.equal(b.id, a.id);
    const c = await create(s, { orderId: 'ORD-1', amount: 200 });
    assert.notEqual(c.id, a.id, 'a different amount is a new payment');
  });

  test(name + ': matched by the reference note, even when the amount is off; the UTR is used once', async () => {
    const s = await B.make();
    const p = await create(s, { orderId: 'X', customer: 'c@x.com', metadata: { plan: 'pro' } });
    let settled = await s.ingestAlerts([alert({ amount: p.payAmount, ref: p.ref })]);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].id, p.id);
    assert.equal(settled[0].status, 'paid');
    assert.equal(settled[0].matchedBy, 'ref');
    assert.deepEqual(settled[0].metadata, { plan: 'pro' });
    assert.equal(settled[0].customer, 'c@x.com');
    settled = await s.ingestAlerts([alert({ amount: p.payAmount, ref: p.ref, utr: settled[0].utr })]);
    assert.equal(settled.length, 0, 'the same email twice changes nothing');

    const q = await create(s);
    const short = await s.ingestAlerts([alert({ amount: q.payAmount - 50, ref: q.ref })]);
    assert.equal(short[0].status, 'underpaid', 'paid less than asked: underpaid, never paid');
    assert.equal(short[0].paidAmount, Math.round((q.payAmount - 50) * 100) / 100);
  });

  test(name + ': matched by the unique amount when the bank hides the note; never when two could match', async () => {
    const s = await B.make();
    const p = await create(s);
    const settled = await s.ingestAlerts([alert({ amount: p.payAmount })]);
    assert.deepEqual(settled.map((x) => [x.id, x.matchedBy]), [[p.id, 'amount']]);
    const stranger = await s.ingestAlerts([alert({ amount: 55.55 })]);
    assert.equal(stranger.length, 0, 'money for no payment stays unmatched');
    const um = await s.unmatchedAlerts();
    assert.deepEqual(um.map((a) => a.amount), [55.55]);
  });

  test(name + ': a late payment still matches for 30 minutes after expiry, not after', async () => {
    const s = await B.make();
    const late = await create(s);
    await B.age(s, late.id, 30);                                 // expired 20 minutes ago
    assert.equal((await s.ingestAlerts([alert({ amount: late.payAmount })])).length, 1);
    const tooLate = await create(s, { amount: 300 });
    await B.age(s, tooLate.id, 45);                              // expired 35 minutes ago
    assert.equal((await s.ingestAlerts([alert({ amount: tooLate.payAmount, ref: tooLate.ref })])).length, 0);
  });

  test(name + ': an unmatched alert keeps its amount out of use for a while', async () => {
    const s = await B.make();
    for (let paise = 1; paise <= 98; paise++) await s.ingestAlerts([alert({ amount: 9 + paise / 100 })]);
    const p = await create(s, { amount: 9 });
    assert.equal(p.payAmount, 9.99, 'the only amount no stray payment used');
  });

  test(name + ': UTR claim settles once, only with a genuine alert, 5 tries', async () => {
    const s = await B.make();
    const p = await create(s, { amount: 150 });
    const u = utrs();
    await s.ingestAlerts([alert({ utr: u, amount: p.payAmount + 50 })]);         // a different amount: no auto match
    let r = await s.claimUtr(p.id, '111111111111');
    assert.deepEqual([r.result, r.settled], ['not_found', false]);
    r = await s.claimUtr(p.id, u);
    assert.deepEqual([r.result, r.settled, r.payment.status, r.payment.matchedBy], ['paid', true, 'paid', 'utr']);
    r = await s.claimUtr(p.id, u);
    assert.deepEqual([r.result, r.settled], ['paid', false], 'asking again just says paid');
    const q = await create(s, { amount: 150 });
    r = await s.claimUtr(q.id, u);
    assert.equal(r.result, 'used', 'one UTR, one payment');
    for (let i = 0; i < 4; i++) await s.claimUtr(q.id, '222222222222');   // 1 + 4 = the 5 tries
    await assert.rejects(s.claimUtr(q.id, '222222222222'), (e) => e.code === 'TOO_MANY_TRIES');
    await assert.rejects(s.claimUtr('pay_' + 'f'.repeat(24), u), (e) => e.code === 'NOT_FOUND');
  });

  test(name + ': inbox throttle and position', async () => {
    const s = await B.make();
    assert.deepEqual(await s.claimSync(10), { lastUid: 0, uidValidity: 0 });
    assert.equal(await s.claimSync(10), null, 'a second reader within 10 s is turned away');
    await s.finishSync({ lastUid: 40, uidValidity: 7, error: null });
    assert.deepEqual(await s.claimSync(0), { lastUid: 40, uidValidity: 7 });
    await s.finishSync({ lastUid: null, uidValidity: null, error: 'Gmail took too long to answer.' });
    const st = await s.syncStatus();
    assert.equal(st.lastError, 'Gmail took too long to answer.');
    assert.ok(st.lastOk && st.lastRun);
    assert.deepEqual(await s.claimSync(0), { lastUid: 40, uidValidity: 7 }, 'a failed run keeps the position');
  });

  test(name + ': list payments', async () => {
    const s = await B.make();
    const a = await create(s, { orderId: 'L1' });
    await create(s, { orderId: 'L2', amount: 120 });
    await s.ingestAlerts([alert({ amount: a.payAmount, ref: a.ref })]);
    assert.deepEqual((await s.listPayments({ status: 'paid' })).map((p) => p.id), [a.id]);
    assert.equal((await s.listPayments({ orderId: 'L2' })).length, 1);
    assert.equal((await s.getPayment('nope')), null);
  });
}
