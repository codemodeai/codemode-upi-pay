#!/usr/bin/env node
/*
 * Standalone payment server: run it next to any website or backend (PHP, Python, Java, ...) and talk to it over
 * HTTP + webhooks. Configure with environment variables (or a .env file next to where you start it):
 *
 *   UPI_ID=yourshop@okhdfcbank        your UPI ID (required)
 *   UPI_NAME=Your Shop                name shown in UPI apps (required)
 *   GMAIL_ADDRESS=alerts@gmail.com    inbox that gets your bank's credit alerts
 *   GMAIL_APP_PASSWORD=abcd efgh ...  Google App Password for it
 *   DATABASE_URL=postgres://...       Postgres (recommended; without it payments live in memory)
 *   UPI_API_KEY=long-random-string    your backend sends it to create payments
 *   WEBHOOK_URL=https://you/webhook   where to POST payment.paid / payment.underpaid
 *   WEBHOOK_SECRET=another-secret     signs the webhooks
 *   ALLOWED_ORIGINS=https://shop.com  sites allowed to use the checkout widget (comma-separated, or *)
 *   UPI_PUBLIC_CREATE=1               let the widget create payments without your backend (simple sites)
 *   UPI_TEST_MODE=1                   no real money: adds a "simulate payment" route and a demo page at /
 *   PORT=8787
 *
 *   npx codemode-upi-pay        or        node bin/server.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createUpiPay, MemoryStore, PostgresStore } = require('../src');

// Minimal .env loader (KEY=value lines), so no extra dependency is needed.
const envFile = path.join(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const env = process.env;
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

const testMode = on(env.UPI_TEST_MODE);
const upi = createUpiPay({
  vpa: env.UPI_ID,
  payeeName: env.UPI_NAME,
  gmail: env.GMAIL_ADDRESS ? { user: env.GMAIL_ADDRESS, appPassword: env.GMAIL_APP_PASSWORD } : null,
  store: env.DATABASE_URL ? new PostgresStore({ connectionString: env.DATABASE_URL, ssl: on(env.DATABASE_SSL) ? { rejectUnauthorized: false } : undefined }) : new MemoryStore(),
  expiresInMinutes: Number(env.UPI_EXPIRES_MINUTES) || 10,
  refPrefix: env.UPI_REF_PREFIX || 'PAY',
  alertSenders: env.UPI_ALERT_SENDERS || '',
  webhook: env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET || '' } : null,
  testMode
});
if (!env.DATABASE_URL) console.warn('[upi] DATABASE_URL not set: payments are kept in memory and lost on restart.');
if (env.WEBHOOK_URL && !env.WEBHOOK_SECRET) console.warn('[upi] WEBHOOK_SECRET not set: your webhook receiver can\'t verify that calls come from here.');

const handler = upi.handler({
  basePath: '/upi',
  apiKey: env.UPI_API_KEY || '',
  publicCreate: on(env.UPI_PUBLIC_CREATE) || testMode,
  cors: env.ALLOWED_ORIGINS || (testMode ? '*' : null)
});

const DEMO = fs.readFileSync(path.join(__dirname, '..', 'checkout', 'demo.html'), 'utf8');

const server = http.createServer((req, res) => {
  if ((req.url === '/' || req.url === '/index.html') && (testMode || on(env.UPI_DEMO_PAGE))) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(DEMO);
  }
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true}'); }
  handler(req, res);
});

upi.on('paid', (p) => console.log('[upi] paid', p.id, p.orderId || '', '₹' + p.paidAmount, 'UTR', p.utr));
upi.on('underpaid', (p) => console.log('[upi] UNDERPAID', p.id, 'got ₹' + p.paidAmount, 'of ₹' + p.payAmount));

const port = Number(env.PORT) || 8787;
server.listen(port, () => {
  console.log('[upi] listening on http://localhost:' + port + '/upi' + (testMode ? '  (test mode: demo at http://localhost:' + port + '/)' : ''));
  upi.start(Number(env.UPI_SYNC_SECONDS) || 15);
});
