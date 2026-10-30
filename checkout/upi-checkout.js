/*!
 * codemode-upi-pay checkout widget. One file, no dependencies.
 *
 *   <script src="https://your-server/upi/checkout.js"></script>
 *   UpiCheckout.open({
 *     endpoint: 'https://your-server/upi',     // where upi.handler() is mounted
 *     paymentId: 'pay_...',                     // created by your server (recommended), or:
 *     amount: 499, orderId: 'ORDER-1',          // let the widget create it (needs publicCreate: true)
 *     onPaid: function (payment) {},            // money confirmed: payment.utr, payment.paidAmount...
 *     onClose: function (payment) {}            // closed (payment is null if never created)
 *   });
 *
 * Or with no code: <button data-upi-amount="499" data-upi-order="ORDER-1">Pay</button> and set
 * data-endpoint on the <script> tag; listen for the "upi:paid" event on the button.
 */
(function (root) {
  'use strict';
  if (root.UpiCheckout) return;
  var doc = root.document;

  var CSS = [
    '.upic-scrim{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);animation:upic-fade .2s ease}',
    '.upic{--c:#4f46e5;--bg:#fff;--fg:#0f172a;--mut:#64748b;--line:#e2e8f0;--soft:#f1f5f9;--good:#16a34a;--bad:#dc2626;--warn:#b45309;',
    'font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);width:100%;max-width:400px;max-height:calc(100dvh - 32px);overflow:auto;border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.25);animation:upic-up .25s cubic-bezier(.2,.8,.2,1)}',
    '@media (prefers-color-scheme:dark){.upic.upic-auto{--bg:#0f172a;--fg:#f1f5f9;--mut:#94a3b8;--line:#1e293b;--soft:#1e293b}}',
    '.upic.upic-dark{--bg:#0f172a;--fg:#f1f5f9;--mut:#94a3b8;--line:#1e293b;--soft:#1e293b}',
    '.upic *{box-sizing:border-box}',
    // reset what the host page's CSS might set on buttons, inputs and links (0,1,0: beats "button{...}", loses to our classes below)
    '.upic :where(button,input,a,form,label,h3,p){font-family:inherit;letter-spacing:normal;text-transform:none;margin:0;height:auto;min-height:0;width:auto;max-width:none;box-shadow:none;line-height:1.3;float:none}',
    '.upic-head{display:flex;align-items:center;gap:12px;padding:16px 18px;background:var(--c);color:#fff;border-radius:20px 20px 0 0}',
    '.upic-logo{width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);display:grid;place-items:center;font-weight:700;flex:none}',
    '.upic-head b{display:block;font-size:15px}.upic-head span{font-size:12px;opacity:.85}',
    '.upic-x{margin-left:auto;border:0;background:rgba(255,255,255,.15);color:#fff;width:30px;height:30px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer}',
    '.upic-body{padding:18px;display:grid;gap:14px}',
    '.upic-amt{text-align:center}.upic-amt b{font-size:30px;letter-spacing:-.02em}.upic-amt small{display:block;color:var(--mut);font-size:12px}',
    '.upic-qr{position:relative;margin:0 auto;width:220px;height:220px;padding:12px;border-radius:16px;background:#fff;border:1px solid var(--line)}',
    '.upic-qr svg{width:100%;height:100%;display:block}',
    '.upic-qr i{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px;border-radius:10px;background:var(--c);color:#fff;display:grid;place-items:center;font:700 13px/1 system-ui;font-style:normal;border:3px solid #fff}',
    '.upic-hint{text-align:center;color:var(--mut);font-size:12.5px;margin:-4px 0 0}',
    '.upic-rows{border:1px solid var(--line);border-radius:12px;overflow:hidden}',
    '.upic-row{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:13px}.upic-row+.upic-row{border-top:1px solid var(--line)}',
    '.upic-row span{color:var(--mut);flex:none;width:84px}.upic-row b{font-weight:600;overflow-wrap:anywhere;flex:1}',
    '.upic-copy{flex:none;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:8px;padding:3px 9px;font-size:12px;cursor:pointer}',
    '.upic-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;border-radius:12px;border:0;background:var(--c);color:#fff;font-weight:600;font-size:15px;text-decoration:none;cursor:pointer}',
    '.upic-btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}',
    '.upic-btn[disabled]{opacity:.6;cursor:default}',
    '.upic-apps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}',
    '.upic-apps a{display:grid;place-items:center;gap:4px;padding:8px 4px;border:1px solid var(--line);border-radius:12px;color:var(--fg);text-decoration:none;font-size:11.5px}',
    '.upic-apps a i{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;font:700 12px/1 system-ui;font-style:normal}',
    '.upic-wait{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--mut);font-size:13px}',
    '.upic-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--c);animation:upic-rot .8s linear infinite}',
    '.upic-link{border:0;background:none;color:var(--c);font-weight:600;font-size:13px;cursor:pointer;padding:0;justify-self:center}',
    '.upic-utr{display:grid;gap:8px}.upic-utr input{height:44px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:0 12px;font-size:15px;letter-spacing:.06em}',
    '.upic-msg{font-size:13px;border-radius:10px;padding:9px 12px;background:var(--soft)}.upic-msg.bad{color:var(--bad)}.upic-msg.warn{color:var(--warn)}',
    '.upic-done{text-align:center;display:grid;gap:8px;justify-items:center;padding:8px 0}',
    '.upic-tick{width:64px;height:64px;border-radius:50%;background:var(--good);display:grid;place-items:center;animation:upic-pop .4s cubic-bezier(.2,1.6,.4,1)}',
    '.upic-tick svg{width:34px;height:34px;stroke:#fff;stroke-width:3;fill:none;stroke-dasharray:30;stroke-dashoffset:30;animation:upic-draw .4s .2s forwards}',
    '.upic-done h3{margin:4px 0 0;font-size:19px}.upic-done p{margin:0;color:var(--mut);font-size:13px}',
    '.upic-foot{text-align:center;font-size:11px;color:var(--mut);padding:0 18px 14px}',
    '@keyframes upic-fade{from{opacity:0}}@keyframes upic-up{from{opacity:0;transform:translateY(16px) scale(.98)}}',
    '@keyframes upic-rot{to{transform:rotate(360deg)}}@keyframes upic-pop{from{transform:scale(.3);opacity:0}}@keyframes upic-draw{to{stroke-dashoffset:0}}',
    '@media (prefers-reduced-motion:reduce){.upic,.upic-scrim,.upic-tick,.upic-tick svg{animation:none!important;stroke-dashoffset:0}}'
  ].join('');

  var APPS = [
    { name: 'GPay', scheme: 'tez://upi/pay?', color: '#1a73e8', label: 'G' },
    { name: 'PhonePe', scheme: 'phonepe://pay?', color: '#5f259f', label: 'Pe' },
    { name: 'Paytm', scheme: 'paytmmp://pay?', color: '#00baf2', label: 'P' },
    { name: 'Any app', scheme: 'upi://pay?', color: '#334155', label: 'UPI' }
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function rupees(n) { return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function isPhone() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (root.matchMedia && root.matchMedia('(pointer:coarse)').matches && root.innerWidth < 700); }
  function injectCss() {
    if (doc.getElementById('upic-css')) return;
    var s = doc.createElement('style'); s.id = 'upic-css'; s.textContent = CSS; doc.head.appendChild(s);
  }
  function req(method, url, body, headers) {
    return fetch(url, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined, credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; if (!r.ok && !d.result) { var e = new Error(d.error || 'Something went wrong (' + r.status + ')'); e.data = d; throw e; } return d; }); });
  }

  function open(o) {
    o = o || {};
    injectCss();
    var endpoint = String(o.endpoint || '').replace(/\/+$/, '');
    var state = { p: o.payment || null, closed: false, poll: null, tick: null, view: 'loading', showQr: !isPhone(), skew: 0, utrOpen: false, msg: null };
    var scrim = doc.createElement('div');
    scrim.className = 'upic-scrim';
    var box = doc.createElement('div');
    box.className = 'upic ' + (o.theme === 'dark' ? 'upic-dark' : o.theme === 'light' ? '' : 'upic-auto');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Pay with UPI');
    if (o.color) box.style.setProperty('--c', o.color);
    scrim.appendChild(box);
    doc.body.appendChild(scrim);
    var lastFocus = doc.activeElement;
    var bodyOverflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden';

    function close() {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.poll); clearInterval(state.tick);
      doc.removeEventListener('keydown', onKey);
      scrim.remove(); doc.body.style.overflow = bodyOverflow;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      if (o.onClose) o.onClose(state.p);
    }
    function onKey(e) { if (e.key === 'Escape' && state.view !== 'paid') close(); }
    doc.addEventListener('keydown', onKey);
    scrim.addEventListener('click', function (e) { if (e.target === scrim && state.view !== 'paid') close(); });

    function left() { return state.p ? Date.parse(state.p.expiresAt) - (Date.now() + state.skew) : 0; }
    function clock() { var s = Math.max(0, Math.floor(left() / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

    function head(sub) {
      var name = o.name || (state.p && state.p.payeeName) || 'UPI payment';
      return '<div class="upic-head"><div class="upic-logo">' + esc(name.charAt(0).toUpperCase()) + '</div><div><b>' + esc(name) + '</b><span>' + esc(sub || 'Pay with any UPI app') + '</span></div>' +
        '<button class="upic-x" type="button" aria-label="Close" data-x>×</button></div>';
    }
    function render() {
      if (state.closed) return;
      var p = state.p, html = '';
      if (state.view === 'loading') {
        html = head() + '<div class="upic-body"><div class="upic-wait" style="padding:40px 0"><span class="upic-spin"></span>Preparing your payment…</div></div>';
      } else if (state.view === 'error') {
        html = head() + '<div class="upic-body"><div class="upic-msg bad">' + esc(state.msg) + '</div><button class="upic-btn ghost" type="button" data-x>Close</button></div>';
      } else if (state.view === 'paid') {
        html = head('Payment received') + '<div class="upic-body"><div class="upic-done"><div class="upic-tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
          '<h3>' + esc(rupees(p.paidAmount || p.payAmount)) + ' paid</h3><p>' + (p.bank ? esc(p.bank) + ' · ' : '') + 'UTR ' + esc(p.utr || '') + '</p></div>' +
          '<button class="upic-btn" type="button" data-done>Done</button></div>';
      } else if (state.view === 'underpaid') {
        html = head('Amount didn’t match') + '<div class="upic-body"><div class="upic-msg warn">We received ' + esc(rupees(p.paidAmount)) + ', which is less than ' + esc(rupees(p.payAmount)) + '. Please contact ' + esc(p.payeeName) + ' with UTR ' + esc(p.utr) + '.</div>' +
          '<button class="upic-btn ghost" type="button" data-x>Close</button></div>';
      } else {
        var expired = state.view === 'expired';
        var q = p.link.split('?')[1] || '';
        html = head(expired ? 'This QR has expired' : 'Expires in ' + clock()) + '<div class="upic-body">' +
          '<div class="upic-amt"><b>' + esc(rupees(p.payAmount)) + '</b>' + (p.extraPaise ? '<small>' + esc(rupees(p.amount)) + ' + ' + p.extraPaise + ' paise, so we can spot your payment. Please pay this exact amount.</small>' : '') + '</div>' +
          (expired ? '<div class="upic-msg warn">This payment has expired. If you already paid, your payment will still be confirmed: wait a moment or enter the UTR below.</div>' :
            (state.showQr ? '<div class="upic-qr" aria-label="UPI QR code">' + (p.qr || '') + '<i>UPI</i></div><p class="upic-hint">Scan with GPay, PhonePe, Paytm, BHIM or any UPI app</p>' : '') +
            (isPhone() ? '<a class="upic-btn" href="' + esc(p.link) + '">Pay ' + esc(rupees(p.payAmount)) + ' with UPI app</a><div class="upic-apps">' +
              APPS.map(function (a) { return '<a href="' + esc(a.scheme + q) + '"><i style="background:' + a.color + '">' + a.label + '</i>' + esc(a.name) + '</a>'; }).join('') + '</div>' +
              '<button class="upic-link" type="button" data-qr>' + (state.showQr ? 'Hide QR code' : 'Show QR code (pay from another phone)') + '</button>' : '')) +
          '<div class="upic-rows"><div class="upic-row"><span>Pay to</span><b>' + esc(p.upiId) + '</b><button class="upic-copy" type="button" data-copy="' + esc(p.upiId) + '">Copy</button></div>' +
          '<div class="upic-row"><span>Amount</span><b>' + esc(rupees(p.payAmount)) + '</b><button class="upic-copy" type="button" data-copy="' + esc(Number(p.payAmount).toFixed(2)) + '">Copy</button></div>' +
          '<div class="upic-row"><span>Note</span><b>' + esc(p.ref) + '</b></div></div>' +
          (expired ? '' : '<div class="upic-wait" aria-live="polite"><span class="upic-spin"></span>Waiting for your payment. It confirms automatically.</div>') +
          (p.testMode ? '<button class="upic-btn ghost" type="button" data-sim>Simulate the bank alert (test mode)</button>' : '') +
          (state.utrOpen || expired ? '<form class="upic-utr" data-utr><label for="upic-utr" style="font-size:13px;font-weight:600">Paid already? Enter the 12-digit UTR from your UPI app</label>' +
            '<input id="upic-utr" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="e.g. 427712345678">' +
            (state.msg ? '<div class="upic-msg ' + (state.msgBad ? 'bad' : '') + '">' + esc(state.msg) + '</div>' : '') +
            '<button class="upic-btn ghost" type="submit">Confirm payment</button></form>' : '<button class="upic-link" type="button" data-utropen>Paid but not confirmed? Enter UTR</button>') +
          '</div><div class="upic-foot">Paid directly to ' + esc(p.payeeName) + '’s bank account via UPI. We never see your UPI PIN.</div>';
      }
      var keepUtr = box.querySelector('#upic-utr'), utrVal = keepUtr ? keepUtr.value : '';
      box.innerHTML = html;
      var nu = box.querySelector('#upic-utr'); if (nu && utrVal) nu.value = utrVal;
      wire();
    }
    function wire() {
      box.querySelectorAll('[data-x]').forEach(function (b) { b.onclick = close; });
      var d = box.querySelector('[data-done]'); if (d) d.onclick = close;
      var qr = box.querySelector('[data-qr]'); if (qr) qr.onclick = function () { state.showQr = !state.showQr; render(); };
      var uo = box.querySelector('[data-utropen]'); if (uo) uo.onclick = function () { state.utrOpen = true; render(); var i = box.querySelector('#upic-utr'); if (i) i.focus(); };
      box.querySelectorAll('[data-copy]').forEach(function (b) {
        b.onclick = function () {
          var t = b.getAttribute('data-copy');
          (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1400); }, function () {});
        };
      });
      var sim = box.querySelector('[data-sim]');
      if (sim) sim.onclick = function () { sim.disabled = true; req('POST', endpoint + '/payments/' + state.p.id + '/simulate').then(update).catch(function (e) { state.msg = e.message; state.msgBad = true; render(); }); };
      var f = box.querySelector('[data-utr]');
      if (f) f.onsubmit = function (e) {
        e.preventDefault();
        var v = (box.querySelector('#upic-utr').value || '').replace(/\D/g, '');
        if (v.length !== 12) { state.msg = 'A UTR has 12 digits. Find it in your UPI app under the payment details.'; state.msgBad = true; render(); return; }
        var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
        req('POST', endpoint + '/payments/' + state.p.id + '/utr', { utr: v }).then(function (r) {
          if (r.payment) update(r.payment);
          if (r.result !== 'paid') { state.msg = r.message + (r.triesLeft != null && r.result === 'not_found' ? ' (' + r.triesLeft + ' tries left)' : ''); state.msgBad = r.result !== 'not_found'; render(); }
        }).catch(function (err) { state.msg = err.message; state.msgBad = true; render(); });
      };
      if (!state.focused) { var x = box.querySelector('.upic-x'); if (x) { x.focus(); state.focused = true; } }
    }
    function update(p) {
      var had = state.p;
      state.p = Object.assign({}, had || {}, p, { qr: p.qr || (had && had.qr) });
      if (p.serverTime) state.skew = Date.parse(p.serverTime) - Date.now();
      var before = state.view;
      state.view = p.status === 'paid' ? 'paid' : p.status === 'underpaid' ? 'underpaid' : left() <= 0 ? 'expired' : 'pay';
      if (state.view !== before) {
        render();
        if (state.view === 'paid' && before !== 'paid') {
          clearTimeout(state.poll); clearInterval(state.tick);
          if (o.onPaid) o.onPaid(state.p);
        }
        if (state.view === 'expired' && o.onExpired) o.onExpired(state.p);
      }
    }
    function poll() {
      if (state.closed || state.view === 'paid' || state.view === 'underpaid') return;
      var graceOver = left() < -30 * 60e3;
      if (graceOver) return;
      req('GET', endpoint + '/payments/' + state.p.id).then(update).catch(function () {})
        .then(function () { if (!state.closed) state.poll = setTimeout(poll, state.view === 'expired' ? 8000 : 3000); });
    }
    function start(p) {
      update(p);
      state.tick = setInterval(function () {
        if (state.view === 'pay') {
          if (left() <= 0) { update(state.p); return; }
          var sub = box.querySelector('.upic-head span'); if (sub) sub.textContent = 'Expires in ' + clock();
        }
      }, 1000);
      state.poll = setTimeout(poll, 2500);
    }

    render();
    var first;
    if (state.p && state.p.qr) first = Promise.resolve(state.p);
    else if (o.paymentId || (state.p && state.p.id)) first = req('GET', endpoint + '/payments/' + (o.paymentId || state.p.id) + '?qr=1');
    else first = req('POST', endpoint + '/payments', { amount: o.amount, orderId: o.orderId, note: o.note });
    first.then(start).catch(function (e) { state.view = 'error'; state.msg = e.message; render(); });
    return { close: close, get payment() { return state.p; } };
  }

  // No-code buttons: <button data-upi-amount="499" data-upi-order="A1">, endpoint from the script tag.
  var script = doc.currentScript;
  var autoEndpoint = script && script.getAttribute('data-endpoint');
  if (autoEndpoint) {
    doc.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-upi-amount],[data-upi-payment]');
      if (!b) return;
      e.preventDefault();
      open({
        endpoint: autoEndpoint, amount: Number(b.getAttribute('data-upi-amount')), orderId: b.getAttribute('data-upi-order') || undefined,
        paymentId: b.getAttribute('data-upi-payment') || undefined, color: script.getAttribute('data-color') || undefined,
        onPaid: function (p) { b.dispatchEvent(new CustomEvent('upi:paid', { bubbles: true, detail: p })); },
        onClose: function (p) { b.dispatchEvent(new CustomEvent('upi:close', { bubbles: true, detail: p })); }
      });
    });
  }

  root.UpiCheckout = { open: open, version: '1.0.0' };
})(typeof window !== 'undefined' ? window : this);
