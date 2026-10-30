/*
 * Webhooks: when a payment is settled, POST it to your URL, signed with your secret, so any backend (PHP, Python,
 * Go, Java, ...) can react.
 *
 *   POST <url>
 *   Content-Type: application/json
 *   X-Upi-Event: payment.paid            (or payment.underpaid)
 *   X-Upi-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your secret>
 *   { "event": "payment.paid", "createdAt": "...", "data": { id, orderId, amount, payAmount, paidAmount, utr, ... } }
 *
 * Verify it with verify(rawBody, header, secret) (or the same HMAC in your language) and reject old timestamps.
 */
'use strict';

const crypto = require('crypto');

function sign(body, secret, t) {
  t = t || Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', String(secret)).update(t + '.' + body).digest('hex');
  return 't=' + t + ',v1=' + mac;
}

// true if the signature header matches the raw body and is at most toleranceSeconds old (default 5 minutes).
function verify(rawBody, header, secret, toleranceSeconds) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.trim().split('=')));
  const t = parseInt(parts.t, 10);
  if (!t || !parts.v1 || !secret) return false;
  if (Math.abs(Date.now() / 1000 - t) > (toleranceSeconds || 300)) return false;
  const want = crypto.createHmac('sha256', String(secret)).update(t + '.' + (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody))).digest();
  const got = Buffer.from(String(parts.v1), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Tries 3 times (now, +2 s, +8 s). A 2xx answer counts as delivered.
async function deliver(cfg, event, data, log) {
  const body = JSON.stringify({ event, createdAt: new Date().toISOString(), data });
  const waits = [0, 2000, 8000];
  let last = null;
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), cfg.timeoutMs || 8000);
      const res = await (cfg._fetch || fetch)(cfg.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'codemode-upi-pay', 'X-Upi-Event': event, 'X-Upi-Signature': sign(body, cfg.secret || '') },
        body
      }).finally(() => clearTimeout(t));
      if (res.status >= 200 && res.status < 300) return true;
      last = new Error('webhook answered ' + res.status);
    } catch (e) {
      last = e;
    }
  }
  if (log) log.error('webhook ' + event + ' for ' + (data && data.id) + ' failed: ' + (last && last.message));
  throw last;
}

module.exports = { sign, verify, deliver };
