# codemode-upi-pay

**Free UPI payments for your website or app. The money goes straight into your own bank account, with no payment gateway and no fees. Payments are confirmed automatically from your bank's email alerts.**

```
Customer scans the QR  ─►  pays ₹499.37 with any UPI app  ─►  money lands in YOUR bank account
                                                                   │
           your app gets  'paid'  ◄─  matched to the order  ◄─  bank emails a credit alert to Gmail
```

- **0% fees.** No Razorpay, Cashfree or PhonePe PG, and no settlement delay. It's your UPI ID and your bank account.
- **Automatic confirmation.** Each payment asks for a unique amount (₹499 becomes ₹499.37) and carries a reference note. The bank's credit alert is read from Gmail, checked, and matched to the right order.
- **Fake emails don't work.** An alert only counts if it comes from a bank domain *and* Gmail's own DKIM/DMARC check passed. A UTR can settle only one payment.
- **Works with any stack.** Use the Node.js SDK, or run the included server and use plain HTTP and webhooks from PHP, Python, Java, Go, and so on.
- **Drop-in checkout.** A Razorpay-style popup with QR, GPay/PhonePe/Paytm buttons on phones, a countdown, auto-confirm, "I've paid, here's my UTR", and light/dark themes. It's one script tag.
- **Store payments anywhere.** It ships with an in-memory store and Postgres (Supabase, Neon, RDS). Anything else works through a small store interface.

> Built by [Codemode](https://github.com/codemodeai). It's the same payment system that runs the Boostly store, extracted so anyone can use it. MIT licensed, free forever.

---

## Contents

1. [Try it in 1 minute](#try-it-in-1-minute)
2. [Setup (one time)](#setup-one-time)
3. [Integrate: Node.js](#integrate-nodejs)
4. [Integrate: any language (server + webhooks)](#integrate-any-language-server--webhooks)
5. [The checkout widget](#the-checkout-widget)
6. [HTTP API](#http-api)
7. [How matching works](#how-matching-works)
8. [Serverless hosting (Vercel, Netlify, Cloudflare)](#serverless-hosting)
9. [Security](#security)
10. [Custom store](#custom-store)
11. [Troubleshooting](#troubleshooting)
12. [Limits: read this](#limits-read-this)

---

## Try it in 1 minute

Test mode needs no Gmail, no bank and no real money:

```sh
git clone https://github.com/codemodeai/codemode-upi-pay.git
cd codemode-upi-pay
npm install
npm run demo
```

Open **http://localhost:8787**, click **Pay with UPI**, then **Simulate the bank alert**. You'll see the full flow: QR, waiting, confirmed.

---

## Setup (one time)

You need four things.

### 1. A UPI ID on your bank account

This is the UPI ID customers pay to, for example `yourshop@okhdfcbank`. You can find it in your bank's app, or in GPay/PhonePe under your profile. A **current account** is best for business payments.

### 2. Email alerts for credits

In your bank's net-banking or app, turn on **email alerts for credits** (sometimes called "InstaAlerts" or "transaction alerts"). Send them to a Gmail address. A separate Gmail used only for alerts is a good idea.

Check that you get an email like *"Rs.1.00 has been credited to your account… UPI Ref 4277…"* when someone pays you ₹1.

### 3. A Gmail App Password

1. Turn on **2-Step Verification** for that Google account.
2. Go to **Google Account → Security → 2-Step Verification → App passwords** and create one (name it "UPI").
3. You get a 16-character password. That's your `GMAIL_APP_PASSWORD`.

The library logs in over **IMAP, read-only**. It never sends, deletes or changes mail.

### 4. A database (recommended)

With `DATABASE_URL` set to any Postgres (Supabase, Neon, Railway, RDS), the tables are created automatically on first start. Without it, payments are kept in memory and lost on restart, which is fine for testing.

**On Supabase:** Project Settings → Database → Connection string (URI). Use the "Session pooler" string on serverless hosts. The tables have Row Level Security on with no policies, so Supabase's public API can't read them.

---

## Integrate: Node.js

```sh
npm install github:codemodeai/codemode-upi-pay pg
```

(`pg` is only needed for `PostgresStore`.)

```js
const { createUpiPay, PostgresStore } = require('codemode-upi-pay');

const upi = createUpiPay({
  vpa: 'yourshop@okhdfcbank',                 // your UPI ID
  payeeName: 'Your Shop',                     // shown in the customer's UPI app
  gmail: { user: process.env.GMAIL_ADDRESS, appPassword: process.env.GMAIL_APP_PASSWORD },
  store: new PostgresStore({ connectionString: process.env.DATABASE_URL })
});

// 1. When the customer checks out: create a payment for the order's total (decide the amount on YOUR server)
const payment = await upi.createPayment({ amount: 499, orderId: 'ORDER-1001', customer: 'asha@example.com' });
// payment.qr   -> SVG of the QR code
// payment.link -> upi://pay?pa=yourshop@okhdfcbank&am=499.37&tn=PAYK7Q2M9XH...
// payment.id   -> give this to the browser for the checkout widget

// 2. Fulfil the order when the money arrives (fires exactly once per payment)
upi.on('paid', async (p) => {
  await markOrderPaid(p.orderId, { utr: p.utr, amount: p.paidAmount });
});
upi.on('underpaid', (p) => notifyAdmin(p));   // they paid less than asked

// 3. Keep reading the inbox (long-running servers). On serverless, see "Serverless hosting".
upi.start(15);   // every 15 seconds
```

Add the HTTP routes the checkout widget needs (Express shown here; plain `http`, Next.js and Fastify work the same way):

```js
app.use(express.json());
app.use(upi.handler({ basePath: '/upi' }));   // status, UTR claim, /upi/checkout.js
```

There's a complete runnable example in [`examples/express/server.js`](examples/express/server.js).

### SDK reference

| Method | What it does |
| --- | --- |
| `createUpiPay(options)` | Create an instance. Options: `vpa`, `payeeName`, `gmail`, `store`, `expiresInMinutes` (10), `refPrefix` ('PAY'), `alertSenders`, `webhook: { url, secret }`, `onPaid`, `testMode`, `logger` |
| `createPayment({ amount, orderId?, customer?, note?, metadata? })` | Start a payment and get back the public payment with `qr` and `link`. The same `orderId` and amount while the QR is valid returns the same payment, so reloads are safe |
| `getPayment(id)` | Full record (customer, metadata…). Reads the inbox first if the payment is still open |
| `getPublicPayment(id, { qr })` | The browser-safe version |
| `claimUtr(id, utr)` | "I've paid": settles only if a genuine alert with that UTR exists. Returns `{ result: 'paid' \| 'underpaid' \| 'not_found' \| 'used', payment, triesLeft }` |
| `sync({ force })` | Read the inbox and settle payments now. Throttled to one run per 10 s across all servers unless `force` |
| `start(seconds)` / `stop()` | Background inbox reading |
| `listPayments({ status, orderId, limit })` | For your admin page |
| `unmatchedPayments()` | Money that arrived but matched no payment (wrong amount, very late). Check these by hand |
| `status()` | Setup check: inbox configured, last successful read, last error (no secrets) |
| `simulatePayment(id)` | `testMode` only: pretend the bank alert arrived |
| `on('paid' \| 'underpaid' \| 'synced' \| 'error', fn)` | Events |
| `handler({ basePath, apiKey, publicCreate, cors })` | The HTTP API below, as `(req, res, next)` middleware |

TypeScript types are included (`index.d.ts`).

---

## Integrate: any language (server + webhooks)

Not using Node? Run the included server next to your app. It's a small service you talk to over HTTP.

```sh
git clone https://github.com/codemodeai/codemode-upi-pay.git && cd codemode-upi-pay
npm install --omit=dev && npm install pg
cp .env.example .env      # fill in UPI_ID, UPI_NAME, GMAIL_*, DATABASE_URL, UPI_API_KEY, WEBHOOK_*
npm start                 # http://localhost:8787/upi
```

It runs anywhere Node 18+ runs: a VPS, Railway, Render, Fly.io, or Docker (`node:20-alpine`, `npm ci`, `node bin/server.js`).

**1. Create a payment from your backend**, with the API key:

```sh
curl -X POST https://pay.yoursite.com/upi/payments \
  -H "Authorization: Bearer $UPI_API_KEY" -H "Content-Type: application/json" \
  -d '{"amount": 499, "orderId": "ORDER-1001", "customer": "asha@example.com"}'
```

```php
// PHP
$ch = curl_init('https://pay.yoursite.com/upi/payments');
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('UPI_API_KEY'), 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['amount' => 499, 'orderId' => 'ORDER-1001'])]);
$payment = json_decode(curl_exec($ch), true);   // $payment['id'], $payment['qr'], $payment['link']
```

```python
# Python
import os, requests
payment = requests.post('https://pay.yoursite.com/upi/payments',
    headers={'Authorization': 'Bearer ' + os.environ['UPI_API_KEY']},
    json={'amount': 499, 'orderId': 'ORDER-1001'}).json()
```

**2. Show the checkout** with `payment.id` (see [the widget](#the-checkout-widget)), or render `payment.qr` and `payment.link` yourself.

**3. Get a webhook when it's paid.** The server POSTs to `WEBHOOK_URL`:

```
POST /your/webhook
X-Upi-Event: payment.paid
X-Upi-Signature: t=1767225600,v1=5f2b...   (HMAC-SHA256 of "<t>.<raw body>" with WEBHOOK_SECRET)

{ "event": "payment.paid", "createdAt": "...", "data": { "id": "pay_...", "orderId": "ORDER-1001",
  "status": "paid", "amount": 499, "payAmount": 499.37, "paidAmount": 499.37, "utr": "427712345678",
  "bank": "HDFC Bank", "payer": "asha@okaxis", "customer": "asha@example.com", "metadata": {} } }
```

Always verify the signature, and treat the same `data.id` twice as one event:

```php
// PHP
$raw = file_get_contents('php://input');
parse_str(str_replace(',', '&', $_SERVER['HTTP_X_UPI_SIGNATURE'] ?? ''), $sig);
$ok = isset($sig['t'], $sig['v1']) && abs(time() - (int)$sig['t']) < 300
   && hash_equals(hash_hmac('sha256', $sig['t'] . '.' . $raw, getenv('WEBHOOK_SECRET')), $sig['v1']);
if (!$ok) { http_response_code(400); exit; }
$event = json_decode($raw, true);
if ($event['event'] === 'payment.paid') { /* mark $event['data']['orderId'] as paid */ }
http_response_code(200);
```

```python
# Python (Flask)
import hmac, hashlib, time, os
@app.post('/upi-webhook')
def upi_webhook():
    raw = request.get_data(as_text=True)
    sig = dict(p.split('=', 1) for p in request.headers.get('X-Upi-Signature', '').split(','))
    want = hmac.new(os.environ['WEBHOOK_SECRET'].encode(), f"{sig.get('t')}.{raw}".encode(), hashlib.sha256).hexdigest()
    if not sig.get('t') or abs(time.time() - int(sig['t'])) > 300 or not hmac.compare_digest(want, sig.get('v1', '')):
        return '', 400
    event = request.get_json()
    if event['event'] == 'payment.paid':
        mark_paid(event['data']['orderId'])
    return '', 200
```

```js
// Node
const { verifyWebhook } = require('codemode-upi-pay');
app.post('/upi-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(req.body, req.get('X-Upi-Signature'), process.env.WEBHOOK_SECRET)) return res.sendStatus(400);
  const event = JSON.parse(req.body);
  res.sendStatus(200);
});
```

Webhooks are retried 3 times (now, +2 s, +8 s). Any 2xx answer counts as delivered. If you missed one, `GET /upi/payments/:id` with the API key gives you the truth.

---

## The checkout widget

```html
<script src="https://pay.yoursite.com/upi/checkout.js"></script>
<script>
  UpiCheckout.open({
    endpoint: 'https://pay.yoursite.com/upi',
    paymentId: 'pay_...',                         // from your backend (step 1 above)
    onPaid: (payment) => location.href = '/thank-you?order=' + payment.orderId,
    onClose: (payment) => {}
  });
</script>
```

| Option | |
| --- | --- |
| `endpoint` | Where the HTTP API is mounted (`…/upi`) |
| `paymentId` | A payment your server created (recommended) |
| `amount`, `orderId` | Or let the widget create the payment. Needs `publicCreate: true` (see Security) |
| `onPaid(payment)` | Payment confirmed. `payment.utr` and `payment.paidAmount` are set |
| `onClose(payment)`, `onExpired(payment)` | |
| `color` | Brand color, e.g. `'#0f766e'` |
| `theme` | `'light'`, `'dark'` or automatic (default) |
| `name` | Title, if different from your payee name |

What customers see:
- **Computer:** a QR to scan with their phone.
- **Phone:** a big "Pay with UPI app" button plus GPay, PhonePe and Paytm buttons. The QR stays one tap away for paying from another phone.

Payments confirm on their own, usually within 10–60 seconds of the bank's email. If the QR expires, a late payment still confirms, and customers can type their UTR as a fallback.

**No-code buttons:**

```html
<script src="https://pay.yoursite.com/upi/checkout.js" data-endpoint="https://pay.yoursite.com/upi"></script>
<button data-upi-amount="499" data-upi-order="ORDER-1001">Pay ₹499</button>
<script>document.addEventListener('upi:paid', (e) => console.log('paid', e.detail));</script>
```

Prefer your own design? Use `payment.qr` (SVG) and `payment.link` (`upi://…`) from `createPayment`, and poll `GET /upi/payments/:id` until `status` is `paid`.

---

## HTTP API

Mounted at `/upi` by default.

| Route | Auth | |
| --- | --- | --- |
| `POST /upi/payments` | API key¹ | Create: `{ amount, orderId?, customer?, note?, metadata? }`. Returns the public payment with `qr` |
| `GET /upi/payments/:id` | none² | Status for the checkout. Add `?qr=1` for the QR. With the API key: the full record |
| `POST /upi/payments/:id/utr` | none² | `{ utr }`. Returns `{ result, message, triesLeft, payment }`. Check `result`, not the status code |
| `POST /upi/payments/:id/simulate` | test mode | Pretend the money arrived |
| `GET /upi/payments?status=paid` | API key | List |
| `GET /upi/unmatched` | API key | Money that matched no payment |
| `POST /upi/sync` | API key | Read the inbox now (for a cron job) |
| `GET /upi/status` | none | Setup check, no secrets |
| `GET /upi/checkout.js` | none | The widget |

¹ Send `Authorization: Bearer <UPI_API_KEY>` or `X-Api-Key`. With `publicCreate: true` (`UPI_PUBLIC_CREATE=1`), browsers may create payments too, rate-limited and without `customer`/`metadata`.
² Payment IDs are 96-bit random and can't be guessed. They show nothing private: no customer, metadata or payer.

Statuses: `pending` → `paid` (or `underpaid`, when less than asked arrived), or `expired` (QR timed out; a late payment can still turn it `paid`).

---

## How matching works

| Rule | |
| --- | --- |
| Unique amount | Each open payment asks for the price + 1 to 99 paise. An amount stays reserved until 30 min after its QR expires, so two open payments never share one |
| Reference note | Every payment has a note like `PAYK7Q2M9XH` in the UPI link. If the bank's email shows it, that's used first |
| Amount match | Otherwise the unique amount is used, but only when exactly one open payment asks for it |
| Time window | The alert must arrive between 2 min before the payment was created and 30 min after it expired |
| UTR fallback | The customer types the 12-digit UTR. It works only if a genuine alert with that UTR arrived, up to 48 h after expiry. 5 tries per payment |
| Once only | A UTR can settle one payment, and a payment settles once. `paid` fires once even with several servers |
| Underpaid | Less than asked becomes `underpaid` (never `paid`). You decide what to do |

Understands credit-alert wording in the style of HDFC, SBI, ICICI, Axis and Kotak, plus generic "credited… UPI Ref…" emails. Kotak has been confirmed with a real payment; the others are covered by sample-based tests. Trusted senders by default: HDFC, ICICI, SBI, Axis, Kotak, IDFC FIRST, IndusInd, Yes, Federal, Bank of Baroda, PNB, Canara, Union, AU, RBL, Bandhan, and any `*.bank.in` domain.

---

## Serverless hosting

On Vercel, Netlify or Cloudflare there's no process running in the background, so don't call `start()`:

- Every status check (`GET /upi/payments/:id`, which the widget calls every 3 s) reads the inbox, throttled to once per 10 s across all instances. While a customer is on the checkout, their payment confirms by itself.
- For payments where the customer closed the page, call `POST /upi/sync` (with the API key) every minute or two from a cron job: Vercel Cron, Supabase `pg_cron` + `pg_net`, GitHub Actions, or cron-job.org.
- Use `PostgresStore`. The in-memory store doesn't survive between serverless calls.

```js
// Next.js app router: app/upi/[...path]/route.js
import { upi } from '@/lib/upi';                       // your createUpiPay(...) instance
const handle = upi.handler({ basePath: '/upi', apiKey: process.env.UPI_API_KEY });
export async function GET(req) { return run(req); }
export async function POST(req) { return run(req); }
async function run(req) {   // adapt the Web Request to (req, res)
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined;
  return new Promise((resolve) => {
    const headers = {}; let status = 200;
    handle({ url: new URL(req.url).pathname + new URL(req.url).search, method: req.method, headers: Object.fromEntries(req.headers), body },
      { set statusCode(s) { status = s; }, setHeader: (k, v) => { headers[k] = v; }, end: (d) => resolve(new Response(status === 204 ? null : d, { status, headers })) });
  });
}
```

(In the pages router or Vercel `api/` functions, `(req, res)` already fits: `export default upi.handler({ basePath: '/api/upi' })`.)

---

## Security

- **Decide the amount on your server**, from your own order data, and create the payment with the API key. Only turn on `publicCreate` for donation or tip pages where the customer chooses the amount.
- **Fake emails are rejected.** The sender must be on the bank list and pass Gmail's DKIM/DMARC check. Only Gmail's top `Authentication-Results` header is trusted, since the sender can't forge it. Set `UPI_ALERT_SENDERS=alerts@yourbank.com` to trust only your bank's exact alert address.
- **Read-only inbox.** Use a Gmail account only for alerts, with an App Password. Keep the App Password, `DATABASE_URL`, `UPI_API_KEY` and `WEBHOOK_SECRET` in environment variables, never in code or git.
- **Webhooks are signed** with a timestamp (5-minute window). Verify every one.
- **Nothing private reaches the browser.** Customer, metadata and payer stay on the server.
- Errors never include your passwords. The status page shows a short, secret-free reason.

---

## Custom store

Want MySQL, MongoDB or Redis? Implement the methods in `index.d.ts` → `Store`. `src/stores/memory.js` is the reference: about 140 lines, with every rule in plain JavaScript. Then run `test/store.test.js` against your store: add it to `BACKENDS` and all the money rules are checked for you.

Your store must do `createPayment` (picking a free amount) and the settle step atomically, using a transaction or lock, if more than one server shares it.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Gmail rejected the login` | Use an **App Password** (16 characters) with 2-Step Verification on, not your normal password. IMAP must be on: Gmail Settings → Forwarding and POP/IMAP |
| Paid, but nothing happens | Check `GET /upi/status` → `inbox.lastError`. Check the bank's email reached that Gmail inbox (not another account, and not in Spam). Check `GET /upi/unmatched` (API key): if the payment is listed there, the customer paid a different amount or paid very late |
| My bank isn't detected | Add your bank's alert address to `UPI_ALERT_SENDERS`. If the email text isn't understood, open an issue with a **redacted** sample (hide account numbers and names) |
| Customer paid ₹499 instead of ₹499.37 | Matching by amount needs the exact amount, but the reference note or the UTR fallback still work. Otherwise it shows in `unmatched` |
| Two servers sending duplicate webhooks | Use `PostgresStore`, which settles each payment once across servers. In-memory stores are per process |

---

## Limits: read this

- **This is not a licensed payment gateway.** You receive money into your own account as ordinary UPI transfers, the same as showing a QR at a shop counter. Follow your bank's rules for business receipts and keep proper records for GST and income tax.
- **No refunds API.** Refund by sending money back from your bank app using the payer's UPI ID or UTR.
- **Confirmation depends on your bank's emails.** Most arrive within seconds to a minute. A bank outage or email delay delays confirmation; the payment still confirms when the email arrives, and the UTR fallback covers it.
- UPI limits apply (usually ₹1 lakh per transaction; your bank may set lower limits for new payees).

## Development

```sh
npm test          # 49 tests: alert parsing, fake-email rejection, the money rules on both stores, API, HTTP
npm run demo      # test-mode server with the demo page
```

## License

MIT © Codemode. Use it in anything, commercial or not. A link back is appreciated, not required.
