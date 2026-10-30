/*
 * Reads new bank alerts from a Gmail inbox over IMAP. Read-only: nothing in the mailbox is changed, moved or
 * marked as read. Needs a Google "App Password" (Google Account -> Security -> 2-Step Verification -> App passwords).
 */
'use strict';

const alerts = require('./alerts');

const MAX_PER_RUN = 150;

function withTimeout(promise, ms, onTimeout) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => { onTimeout(); reject(Object.assign(new Error('Gmail took too long to answer'), { code: 'TIMEOUT' })); }, ms); })
  ]);
}

/*
 * New messages since the last run. state = { lastUid, uidValidity } from the previous run (or null: the first run
 * looks back two days). Only messages from bank domains are downloaded.
 *   opts: { user, appPassword, alertSenders, authServer, refRe, ownVpa, host, port, timeoutMs }
 *   deps: { imapflow } - for tests
 * Returns { alerts: [...], scanned, fromBanks, rejected, lastUid, uidValidity }.
 */
async function readInbox(opts, state, deps) {
  const { ImapFlow } = (deps && deps.imapflow) || require('imapflow');
  const client = new ImapFlow({
    host: opts.host || 'imap.gmail.com', port: opts.port || 993, secure: true,
    auth: { user: opts.user, pass: String(opts.appPassword || '').replace(/\s+/g, '') },
    logger: false, connectionTimeout: 8000, greetingTimeout: 6000, socketTimeout: 15000, disableAutoIdle: true
  });
  const list = alerts.senderList(opts.alertSenders);
  const run = async () => {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const out = { alerts: [], scanned: 0, fromBanks: 0, rejected: 0 };
    try {
      const box = client.mailbox;
      const uidValidity = Number(box.uidValidity);
      const last = Number(state && state.lastUid) || 0;
      const fresh = !last || Number(state && state.uidValidity) !== uidValidity;
      let uids = fresh
        ? await client.search({ since: new Date(Date.now() - 2 * 86400e3) }, { uid: true })
        : await client.search({ uid: (last + 1) + ':*' }, { uid: true });
      uids = (uids || []).map(Number).filter((u) => fresh || u > last).sort((a, b) => a - b);
      out.uidValidity = uidValidity;
      out.lastUid = uids.length ? uids[uids.length - 1] : fresh ? Math.max(0, Number(box.uidNext) - 1) : last;
      const recent = uids.slice(-MAX_PER_RUN);
      out.scanned = recent.length;
      const banks = [];
      if (recent.length) {
        for await (const m of client.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
          const from = m.envelope && m.envelope.from && m.envelope.from[0];
          if (from && alerts.allowedSender(from.address, list)) banks.push(m.uid);
        }
      }
      out.fromBanks = banks.length;
      if (banks.length) {
        for await (const m of client.fetch(banks, { uid: true, source: true, internalDate: true }, { uid: true })) {
          const a = m.source ? await alerts.toAlert(m.source, m.internalDate, opts) : null;
          if (a) out.alerts.push(a); else out.rejected++;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    return out;
  };
  try {
    return await withTimeout(run(), opts.timeoutMs || 20000, () => { try { client.close(); } catch (e) { /* already closed */ } });
  } catch (e) {
    try { client.close(); } catch (x) { /* already closed */ }
    throw e;
  }
}

// A short reason without secrets, safe to show in a status page.
function describeError(e) {
  const s = String((e && (e.responseText || e.message)) || e || '');
  if (/AUTHENTICATIONFAILED|Invalid credentials|authenticat/i.test(s) || (e && e.authenticationFailed)) {
    return 'Gmail rejected the login: use a 16-character App Password (Google Account -> Security -> App passwords).';
  }
  if (/TIMEOUT|too long/i.test(s)) return 'Gmail took too long to answer.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(s)) return 'Couldn\'t connect to Gmail.';
  return 'Couldn\'t read the inbox: ' + s.replace(/[^\w .:,'-]/g, '').slice(0, 120);
}

module.exports = { readInbox, describeError };
