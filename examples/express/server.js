/*
 * Express example: your shop creates the payment on the server, the browser shows the checkout,
 * and you fulfil the order when 'paid' fires.
 *
 *   npm install express pg github:codemodeai/codemode-upi-pay
 *   UPI_ID=yourshop@okhdfcbank UPI_NAME="Your Shop" GMAIL_ADDRESS=... GMAIL_APP_PASSWORD=... DATABASE_URL=... node server.js
 */
const express = require('express');
const { createUpiPay, PostgresStore, MemoryStore } = require('codemode-upi-pay');

const upi = createUpiPay({
  vpa: process.env.UPI_ID,
  payeeName: process.env.UPI_NAME,
  gmail: { user: process.env.GMAIL_ADDRESS, appPassword: process.env.GMAIL_APP_PASSWORD },
  store: process.env.DATABASE_URL ? new PostgresStore({ connectionString: process.env.DATABASE_URL }) : new MemoryStore()
});

// Money arrived: mark the order paid in your own database, send the email, ship it...
upi.on('paid', async (payment) => {
  console.log('Order', payment.orderId, 'paid ₹' + payment.paidAmount, 'UTR', payment.utr);
  // await db.orders.update({ id: payment.orderId }, { status: 'paid', utr: payment.utr });
});
upi.on('underpaid', (payment) => console.warn('Order', payment.orderId, 'got only ₹' + payment.paidAmount));

const app = express();
app.use(express.json());

// The checkout talks to these routes: payment status, "I've paid" with a UTR, and the widget script.
app.use(upi.handler({ basePath: '/upi' }));

// Your own route: you decide the amount from your order, never from the browser.
app.post('/checkout/:orderId', async (req, res) => {
  const order = { id: req.params.orderId, total: 499 };                // look the order up in your database
  const payment = await upi.createPayment({ amount: order.total, orderId: order.id, customer: 'customer@example.com' });
  res.json({ paymentId: payment.id });
});

app.get('/', (req, res) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<button id="buy" style="font:16px system-ui;padding:12px 20px">Buy for ₹499</button>
<script src="/upi/checkout.js"></script>
<script>
  document.getElementById('buy').onclick = async () => {
    const { paymentId } = await (await fetch('/checkout/ORDER-' + Date.now(), { method: 'POST' })).json();
    UpiCheckout.open({ endpoint: '/upi', paymentId, onPaid: (p) => alert('Paid! UTR ' + p.utr) });
  };
</script>`));

upi.start(15);                                                            // check the inbox every 15 seconds
app.listen(3000, () => console.log('http://localhost:3000'));
