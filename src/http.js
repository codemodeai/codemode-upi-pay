/*
 * A ready-made HTTP API for the checkout widget and for backends in other languages. Works with plain Node http,
 * Express, Fastify (via middie), Next.js / Vercel functions (req, res) and Connect-style servers.
 *
 *   app.use(upi.handler({ basePath: '/upi', apiKey: process.env.UPI_API_KEY }))
 *
 *   POST {base}/payments              create a payment        (needs the API key unless publicCreate: true)
 *   GET  {base}/payments/:id          status for the checkout (?qr=1 adds the QR SVG)
 *   POST {base}/payments/:id/utr      "I've paid": { utr }
 *   POST {base}/payments/:id/simulate testMode only: pretend the money arrived
 *   GET  {base}/payments              list payments           (API key)
 *   GET  {base}/unmatched             money that matched no payment (API key)
 *   POST {base}/sync                  read the inbox now      (API key; for a cron job on serverless hosts)
 *   GET  {base}/status                setup check, no secrets
 *   GET  {base}/checkout.js           the drop-in checkout widget
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WIDGET = path.join(__dirname, '..', 'checkout', 'upi-checkout.js');
let widgetCache = null;

function send(res, status, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', typeof body === 'string' && headers && headers['Content-Type'] ? headers['Content-Type'] : 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(data);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(String(req.body) || '{}'); } catch (e) { return null; }
  }
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createHandler(upi, o) {
  o = Object.assign({ basePath: '/upi', apiKey: '', publicCreate: false, cors: null, testMode: false, publicCreatePerMinute: 10 }, o);
  const base = '/' + String(o.basePath || '').replace(/^\/+|\/+$/g, '');
  const hits = new Map();          // ip -> [timestamps], for public create

  const hasKey = (req) => {
    if (!o.apiKey) return false;
    const h = String(req.headers.authorization || '');
    const key = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-api-key'] || '');
    return !!key && safeEqual(key, o.apiKey);
  };
  const allowOrigin = (origin) => {
    if (!origin || !o.cors) return null;
    if (o.cors === '*') return '*';
    const list = Array.isArray(o.cors) ? o.cors : String(o.cors).split(/[\s,]+/).filter(Boolean);
    return list.includes(origin) ? origin : null;
  };
  const tooMany = (req) => {
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 60e3);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > o.publicCreatePerMinute;
  };

  return async function upiHandler(req, res, next) {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (base !== '/') {
      if (p !== base && !p.startsWith(base + '/')) return next ? next() : send(res, 404, { error: 'Not found' });
      p = p.slice(base.length) || '/';
    }
    const cors = allowOrigin(req.headers.origin);
    const headers = cors ? { 'Access-Control-Allow-Origin': cors, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', Object.assign(headers, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key', 'Access-Control-Max-Age': '600', 'Content-Type': 'text/plain' }));
    }
    const reply = (status, body) => send(res, status, body, headers);
    try {
      const m = p.match(/^\/payments\/(pay_[a-f0-9]{24})(\/utr|\/simulate)?\/?$/);
      if (p === '/payments' && req.method === 'POST') {
        const key = hasKey(req);
        if (!key && !o.publicCreate) return reply(401, { error: 'Creating payments needs the API key (Authorization: Bearer <key>).' });
        if (!key && tooMany(req)) return reply(429, { error: 'Too many payments started. Wait a minute.' });
        const b = await readBody(req);
        if (!b) return reply(400, { error: 'Send JSON.' });
        const input = { amount: b.amount, orderId: b.orderId, note: b.note };
        if (key) Object.assign(input, { customer: b.customer, metadata: b.metadata });   // only your server may attach these
        return reply(201, await upi.createPayment(input));
      }
      if (p === '/payments' && req.method === 'GET') {
        if (!hasKey(req)) return reply(401, { error: 'Needs the API key.' });
        return reply(200, { payments: await upi.listPayments({ status: url.searchParams.get('status') || null, orderId: url.searchParams.get('orderId') || null, limit: parseInt(url.searchParams.get('limit'), 10) || 50 }) });
      }
      if (m && !m[2] && req.method === 'GET') {
        const pay = hasKey(req) ? await upi.getPayment(m[1]) : await upi.getPublicPayment(m[1], { qr: url.searchParams.get('qr') === '1' });
        if (pay && hasKey(req) && url.searchParams.get('qr') === '1') Object.assign(pay, await upi.toPublic(pay, true));
        return pay ? reply(200, pay) : reply(404, { error: 'Payment not found.' });
      }
      if (m && m[2] === '/utr' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await upi.claimUtr(m[1], b && b.utr);
        const pub = await upi.toPublic(r.payment);
        const msg = { paid: 'Payment confirmed.', underpaid: 'We received less than the amount due. Contact the merchant.',
          not_found: 'We haven\'t received the bank\'s confirmation for this UTR yet. It can take a few minutes: try again shortly.',
          used: 'This UTR was already used for another payment.' }[r.result];
        return reply(200, { result: r.result, message: msg, triesLeft: r.triesLeft, payment: pub });      // check result, not the status code
      }
      if (m && m[2] === '/simulate' && req.method === 'POST') {
        if (!o.testMode) return reply(403, { error: 'Only in test mode.' });
        return reply(200, await upi.toPublic(await upi.simulatePayment(m[1])));
      }
      if (p === '/unmatched' && req.method === 'GET') {
        if (!hasKey(req)) return reply(401, { error: 'Needs the API key.' });
        return reply(200, { unmatched: await upi.unmatchedPayments(50) });
      }
      if (p === '/sync' && req.method === 'POST') {
        if (!hasKey(req)) return reply(401, { error: 'Needs the API key.' });
        const r = await upi.sync({ force: true });
        return reply(200, { ran: r.ran, alerts: r.alerts, credited: r.credited.map((x) => x.id), error: r.error });
      }
      if (p === '/status' && req.method === 'GET') return reply(200, await upi.status());
      if (p === '/checkout.js' && req.method === 'GET') {
        widgetCache = widgetCache || fs.readFileSync(WIDGET, 'utf8');
        return send(res, 200, widgetCache, Object.assign({}, headers, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }));
      }
      return next ? next() : reply(404, { error: 'Not found' });
    } catch (e) {
      if (e && e.code && e.status) return reply(e.status, { error: e.message, code: e.code });
      console.error('[upi]', e);
      return reply(500, { error: 'Something went wrong.' });
    }
  };
}

module.exports = { createHandler };
