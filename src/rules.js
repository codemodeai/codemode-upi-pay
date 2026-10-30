/*
 * The matching rules, shared by every store, and the error type.
 *
 *   - Each payment asks for a unique amount: the price + 1 to 99 paise (₹100 -> ₹100.37). An amount stays taken
 *     while a payment could still be matched to it, so two open payments never ask for the same amount.
 *   - A bank alert is matched by the reference note first (when the bank's email shows it), then by the unique
 *     amount (only if exactly one open payment asks for it).
 *   - An alert counts if Gmail received it from 2 minutes before the payment was created until 30 minutes after
 *     it expired, so people who pay a little late still get matched.
 *   - "I've paid, here's my UTR": credits only if a genuine bank alert with that UTR arrived (up to 48 hours after
 *     expiry) and hasn't been used. 5 tries per payment.
 *   - A UTR can only ever settle one payment.
 */
'use strict';

const RULES = {
  matchBeforeMs: 2 * 60e3,          // alert may arrive this long before the payment was created (clock skew)
  matchAfterMs: 30 * 60e3,          // ... and this long after it expired
  utrAfterMs: 48 * 3600e3,          // a UTR claim may point at an alert this long after expiry
  holdAfterAlertMs: 10 * 60e3,      // an unmatched alert keeps its amount out of use this long
  lookBackMs: 3 * 86400e3,          // alerts older than this are no longer matched
  maxUtrTries: 5,
  maxOpenPerOrder: 5
};

class UpiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status || 400;
  }
}

const MESSAGES = {
  BAD_AMOUNT: ['Amount must be at least ₹1, with at most 2 decimals.', 400],
  NO_FREE_AMOUNT: ['Too many payments for this amount are open right now. Try again in a few minutes.', 429],
  TOO_MANY_OPEN: ['Too many open payments for this order. Finish or wait for one to expire.', 429],
  NOT_FOUND: ['Payment not found.', 404],
  TOO_MANY_TRIES: ['Too many UTR attempts for this payment. Contact the merchant.', 429],
  BAD_UTR: ['A UTR is the 12-digit number in your UPI app\'s payment details.', 400]
};

function fail(code) {
  const m = MESSAGES[code] || [code, 400];
  throw new UpiError(code, m[0], m[1]);
}

// The status a customer should see: an open payment past its expiry reads as 'expired' (it can still be matched
// for a while if the money arrives late).
function viewStatus(p, now) {
  if (p.status !== 'pending') return p.status;
  return Date.parse(p.expiresAt) <= (now || Date.now()) ? 'expired' : 'pending';
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

module.exports = { RULES, UpiError, MESSAGES, fail, viewStatus, round2 };
