/*
 * The UPI payment link (upi://pay?...) and its QR code, and the short reference note each payment carries.
 */
'use strict';

const crypto = require('crypto');

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O, 1/I: easy to read back
const VPA_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/i;

// A prefix is 2-5 letters, e.g. "PAY" -> references like PAYK7Q2M9XH.
function checkPrefix(prefix) {
  const p = String(prefix || 'PAY').toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(p)) throw new Error('refPrefix must be 2 to 5 letters, e.g. "PAY".');
  return p;
}

function newRef(prefix) {
  let s = checkPrefix(prefix);
  for (let i = 0; i < 8; i++) s += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
  return s;
}

// Finds a reference in an alert's text (case-insensitive), capture group 1.
function refPattern(prefix) {
  return new RegExp('\\b(' + checkPrefix(prefix) + '[' + REF_CHARS + ']{8})\\b', 'i');
}

// NPCI UPI deep link. The amount is fixed (am) and the note (tn) is the reference.
function payLink(o) {
  const enc = (v) => encodeURIComponent(String(v)).replace(/%40/g, '@');
  return 'upi://pay?pa=' + enc(o.vpa) + '&pn=' + enc(o.name) + '&am=' + Number(o.amount).toFixed(2) + '&cu=INR&tn=' + enc(o.ref);
}

// QR code of the link as an SVG string. High error correction, so a logo over the middle still scans.
async function qrSvg(text, opts) {
  const QR = require('qrcode');
  opts = opts || {};
  return QR.toString(text, { type: 'svg', errorCorrectionLevel: 'H', margin: opts.margin == null ? 0 : opts.margin,
    color: { dark: opts.dark || '#0f172aff', light: opts.light || '#ffffffff' } });
}

module.exports = { VPA_RE, REF_CHARS, newRef, refPattern, payLink, qrSvg, checkPrefix };
