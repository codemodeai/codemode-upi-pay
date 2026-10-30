const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpiPay, MemoryStore, verifyWebhook, signWebhook } = require('../src');

const quiet = { info() {}, warn() {}, error() {} };
// A fake Gmail: whatever alerts are queued arrive on the next sync.
function fakeInbox() {
  const q = [];
  const read = async (o, state) => { read.calls.push({ o, state }); return { alerts: q.splice(0), lastUid: (state.lastUid || 0) + 1, uidValidity: 1 }; };
  read.calls = [];
  read.queue = (a) => q.push(Object.assign({ bank: 'HDFC Bank', payer: 'x@okaxis', ref: '', receivedAt: new Date().toISOString() }, a));
  return read;
}
const make = (o) => {
  const inbox = fakeInbox();
  const upi = createUpiPay(Object.assign({ vpa: 'shop@okhdfcbank', payeeName: 'My Shop', gmail: { user: 'a@gmail.com', appPassword: 'x' }, store: new MemoryStore(), logger: quiet, _readInbox: inbox, syncThrottleSeconds: 0 }, o));
  return { upi, inbox };
};

test('needs a valid UPI ID and a payee name', () => {
  assert.throws(() => createUpiPay({ payeeName: 'x' }), /vpa/);
  assert.throws(() => createUpiPay({ vpa: 'not-a-vpa', payeeName: 'x' }), /vpa/);
  assert.throws(() => createUpiPay({ vpa: 'ab@okaxis' }), /payeeName/);
});

test('createPayment gives the browser a QR, a UPI link and nothing private', async () => {
  const { upi } = make();
  const p = await upi.createPayment({ amount: 499, orderId: 'ORDER-1', customer: 'c@x.com', metadata: { secret: 1 } });
  assert.match(p.id, /^pay_[a-f0-9]{24}$/);
  assert.equal(p.amount, 499);
  assert.equal(p.extraPaise, Math.round((p.payAmount - 499) * 100));
  assert.match(p.ref, /^PAY[A-Z2-9]{8}$/);
  assert.equal(p.link, 'upi://pay?pa=shop@okhdfcbank&pn=My%20Shop&am=' + p.payAmount.toFixed(2) + '&cu=INR&tn=' + p.ref);
  assert.match(p.qr, /^<svg/);
  assert.equal(p.status, 'pending');
  assert.equal(p.customer, undefined); assert.equal(p.metadata, undefined);
  const full = await upi.getPayment(p.id, { sync: false });
  assert.equal(full.customer, 'c@x.com'); assert.deepEqual(full.metadata, { secret: 1 });
  await assert.rejects(upi.createPayment({ amount: 0 }), (e) => e.code === 'BAD_AMOUNT');
});

test('sync reads the inbox, settles the payment once and fires paid / onPaid / the webhook', async () => {
  const posts = [];
  const onPaid = [];
  const { upi, inbox } = make({
    onPaid: (p) => onPaid.push(p.id),
    webhook: { url: 'https://merchant.test/hook', secret: 'whsec', _fetch: async (url, init) => { posts.push({ url, init }); return { status: 200 }; } }
  });
  const events = [];
  upi.on('paid', (p) => events.push(p));
  const p = await upi.createPayment({ amount: 100, orderId: 'A1', metadata: { plan: 'pro' } });
  inbox.queue({ utr: '427712345678', amount: p.payAmount, ref: p.ref });
  const r = await upi.sync();
  assert.deepEqual(r.credited.map((x) => x.id), [p.id]);
  assert.equal(events.length, 1);
  assert.equal(events[0].orderId, 'A1');
  assert.deepEqual(events[0].metadata, { plan: 'pro' });
  assert.deepEqual(onPaid, [p.id]);
  assert.equal(posts.length, 1);
  const body = posts[0].init.body;
  assert.equal(JSON.parse(body).event, 'payment.paid');
  assert.equal(JSON.parse(body).data.utr, '427712345678');
  assert.equal(posts[0].init.headers['X-Upi-Event'], 'payment.paid');
  assert.ok(verifyWebhook(body, posts[0].init.headers['X-Upi-Signature'], 'whsec'), 'signature verifies');
  assert.ok(!verifyWebhook(body + ' ', posts[0].init.headers['X-Upi-Signature'], 'whsec'), 'a changed body doesn’t');
  assert.ok(!verifyWebhook(body, posts[0].init.headers['X-Upi-Signature'], 'other'), 'nor another secret');
  inbox.queue({ utr: '427712345678', amount: p.payAmount, ref: p.ref });
  await upi.sync();
  assert.equal(events.length, 1, 'the same alert never pays twice');
  assert.equal(inbox.calls[1].state.lastUid, 1, 'the next read continues where the last one stopped');
  assert.equal(inbox.calls[0].o.refRe.test(p.ref), true, 'the inbox reader looks for this store’s reference format');
});

test('old webhook signatures are refused', () => {
  const old = signWebhook('{}', 's', Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyWebhook('{}', old, 's'), false);
  assert.equal(verifyWebhook('{}', signWebhook('{}', 's'), 's'), true);
});

test('checking a payment reads the inbox first', async () => {
  const { upi, inbox } = make();
  const p = await upi.createPayment({ amount: 250 });
  inbox.queue({ utr: '427712345679', amount: p.payAmount });
  const pub = await upi.getPublicPayment(p.id);
  assert.equal(pub.status, 'paid');
  assert.equal(pub.utr, '427712345679');
});

test('claimUtr: a typed UTR settles only against a genuine alert', async () => {
  const { upi, inbox } = make();
  const p = await upi.createPayment({ amount: 300 });
  inbox.queue({ utr: '427712345680', amount: 999 });                 // arrived, but the amount matches nothing
  await upi.sync();
  await assert.rejects(upi.claimUtr(p.id, '123'), (e) => e.code === 'BAD_UTR');
  let r = await upi.claimUtr(p.id, '4277 0000 0000');
  assert.equal(r.result, 'not_found');
  assert.ok(r.triesLeft < 5);
  r = await upi.claimUtr(p.id, '427712345680');
  assert.equal(r.result, 'paid');
  assert.equal(r.payment.matchedBy, 'utr');
});

test('a UTR whose email is just arriving: claimUtr reads the inbox and succeeds', async () => {
  const { upi, inbox } = make();
  const p = await upi.createPayment({ amount: 310 });
  inbox.queue({ utr: '427712345681', amount: 5000 });                // a different amount: only the UTR can link it
  const r = await upi.claimUtr(p.id, '427712345681');
  assert.equal(r.result, 'paid');
});

test('an inbox error is reported without secrets and doesn’t throw', async () => {
  const upi = createUpiPay({ vpa: 'shop@okhdfcbank', payeeName: 'S', gmail: { user: 'a', appPassword: 'hunter2' }, store: new MemoryStore(), logger: quiet,
    _readInbox: async () => { throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true }); } });
  const errors = [];
  upi.on('error', (e) => errors.push(e));
  const r = await upi.sync({ force: true });
  assert.match(r.error, /App Password/);
  assert.ok(!r.error.includes('hunter2'));
  assert.equal(errors.length, 1);
  assert.match((await upi.status()).inbox.lastError, /App Password/);
});

test('test mode: simulate a payment; outside test mode it is refused', async () => {
  const { upi } = make({ testMode: true });
  const paid = [];
  upi.on('paid', (p) => paid.push(p));
  const p = await upi.createPayment({ amount: 10 });
  assert.equal(p.testMode, true);
  const r = await upi.simulatePayment(p.id);
  assert.equal(r.status, 'paid');
  assert.equal(paid.length, 1);
  const { upi: live } = make();
  const q = await live.createPayment({ amount: 10 });
  await assert.rejects(live.simulatePayment(q.id), (e) => e.code === 'TEST_MODE_ONLY');
});
