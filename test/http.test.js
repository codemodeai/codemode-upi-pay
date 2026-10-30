const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createUpiPay, MemoryStore } = require('../src');

const quiet = { info() {}, warn() {}, error() {} };

async function serve(handlerOpts, upiOpts) {
  const upi = createUpiPay(Object.assign({ vpa: 'shop@okhdfcbank', payeeName: 'My Shop', store: new MemoryStore(), logger: quiet }, upiOpts));
  const h = upi.handler(Object.assign({ basePath: '/upi', apiKey: 'key123' }, handlerOpts));
  const server = http.createServer((req, res) => h(req, res, () => { res.statusCode = 418; res.end('next'); }));
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, headers) => {
    const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { upi, call, close: () => new Promise((r) => server.close(r)) };
}
const KEY = { Authorization: 'Bearer key123' };

test('create needs the API key (unless publicCreate); customer + metadata only from your server', async () => {
  const s = await serve();
  let r = await s.call('POST', '/upi/payments', { amount: 100 });
  assert.equal(r.status, 401);
  r = await s.call('POST', '/upi/payments', { amount: 100, orderId: 'O1', customer: 'c@x.com', metadata: { a: 1 } }, KEY);
  assert.equal(r.status, 201);
  assert.match(r.json.qr, /^<svg/);
  const full = await s.upi.getPayment(r.json.id, { sync: false });
  assert.equal(full.customer, 'c@x.com');
  await s.close();

  const pub = await serve({ publicCreate: true });
  r = await pub.call('POST', '/upi/payments', { amount: 100, customer: 'spoof', metadata: { paid: true } });
  assert.equal(r.status, 201);
  const p = await pub.upi.getPayment(r.json.id, { sync: false });
  assert.equal(p.customer, null, 'the public can’t attach customer details');
  assert.deepEqual(p.metadata, {});
  r = await pub.call('POST', '/upi/payments', { amount: 0.1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'BAD_AMOUNT');
  await pub.close();
});

test('status for the checkout, UTR claim, simulate only in test mode', async () => {
  const s = await serve({ publicCreate: true, testMode: true }, { testMode: true });
  const c = await s.call('POST', '/upi/payments', { amount: 50 });
  let r = await s.call('GET', '/upi/payments/' + c.json.id);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'pending');
  assert.equal(r.json.qr, undefined, 'no QR unless asked');
  r = await s.call('GET', '/upi/payments/' + c.json.id + '?qr=1');
  assert.match(r.json.qr, /^<svg/);
  r = await s.call('POST', '/upi/payments/' + c.json.id + '/utr', { utr: '427700000001' });
  assert.equal(r.status, 200);
  assert.equal(r.json.result, 'not_found');
  assert.match(r.json.message, /haven't received/);
  r = await s.call('POST', '/upi/payments/' + c.json.id + '/simulate');
  assert.equal(r.json.status, 'paid');
  r = await s.call('GET', '/upi/payments/pay_' + '0'.repeat(24));
  assert.equal(r.status, 404);
  await s.close();

  const live = await serve();
  const p = await live.upi.createPayment({ amount: 50 });
  r = await live.call('POST', '/upi/payments/' + p.id + '/simulate');
  assert.equal(r.status, 403);
  await live.close();
});

test('admin routes need the key; status and the widget are public; other paths fall through', async () => {
  const s = await serve();
  assert.equal((await s.call('GET', '/upi/payments')).status, 401);
  assert.equal((await s.call('GET', '/upi/payments', null, KEY)).status, 200);
  assert.equal((await s.call('GET', '/upi/unmatched')).status, 401);
  assert.equal((await s.call('POST', '/upi/sync', {}, { 'X-Api-Key': 'key123' })).status, 200);
  assert.equal((await s.call('POST', '/upi/sync', {}, { 'X-Api-Key': 'wrong' })).status, 401);
  const st = await s.call('GET', '/upi/status');
  assert.equal(st.json.upiId, 'shop@okhdfcbank');
  assert.equal(st.json.inboxConfigured, false);
  const w = await s.call('GET', '/upi/checkout.js');
  assert.match(w.headers.get('content-type'), /javascript/);
  assert.match(w.text, /UpiCheckout/);
  assert.equal((await s.call('GET', '/other')).status, 418, 'not ours: next()');
  await s.close();
});

test('CORS only for the allowed sites', async () => {
  const s = await serve({ cors: 'https://shop.test' });
  let r = await s.call('OPTIONS', '/upi/payments', null, { Origin: 'https://shop.test' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://shop.test');
  r = await s.call('GET', '/upi/status', null, { Origin: 'https://evil.test' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  await s.close();
});

test('public create is rate limited per visitor', async () => {
  const s = await serve({ publicCreate: true, publicCreatePerMinute: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.call('POST', '/upi/payments', { amount: 20 + i })).status);
  assert.deepEqual(codes, [201, 201, 201, 429, 429]);
  await s.close();
});
