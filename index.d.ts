// Types for codemode-upi-pay.
import { EventEmitter } from 'events';

export type PaymentStatus = 'pending' | 'expired' | 'paid' | 'underpaid';

/** What the customer's browser may see (from createPayment, getPublicPayment and the HTTP API). */
export interface PublicPayment {
  id: string;
  status: PaymentStatus;
  amount: number;          // your price
  payAmount: number;       // what the QR asks for: price + 1..99 paise
  extraPaise: number;
  currency: 'INR';
  ref: string;             // UPI note, e.g. PAYK7Q2M9XH
  upiId: string;
  payeeName: string;
  link: string;            // upi://pay?...
  qr?: string;             // SVG markup
  orderId: string | null;
  createdAt: string;
  expiresAt: string;
  serverTime: string;
  paidAt: string | null;
  paidAmount: number | null;
  utr: string | null;
  bank: string | null;
  testMode?: boolean;
}

/** The full record, for your server, webhooks and 'paid' handlers. */
export interface Payment {
  id: string;
  status: PaymentStatus;
  amount: number;
  payAmount: number;
  ref: string;
  orderId: string | null;
  customer: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  paidAmount: number | null;
  utr: string | null;
  bank: string | null;
  payer: string | null;
  matchedBy: 'ref' | 'amount' | 'utr' | null;
  utrTries: number;
}

export interface Alert { utr: string; amount: number; bank?: string; payer?: string; ref?: string; receivedAt: string; }

/** Write your own store (MySQL, MongoDB, ...) by implementing these. See README "Custom store". */
export interface Store {
  init?(): Promise<void>;
  createPayment(input: { id: string; amount: number; ref: string; minutes: number; orderId?: string | null; customer?: string | null; note?: string | null; metadata?: object }): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  listPayments(opts?: { status?: string | null; orderId?: string | null; limit?: number }): Promise<Payment[]>;
  ingestAlerts(alerts: Alert[]): Promise<Payment[]>;
  matchAlerts(): Promise<Payment[]>;
  claimUtr(id: string, utr: string): Promise<{ result: 'paid' | 'underpaid' | 'not_found' | 'used'; settled: boolean; payment: Payment }>;
  claimSync(minSeconds: number): Promise<{ lastUid: number; uidValidity: number } | null>;
  finishSync(r: { lastUid: number | null; uidValidity: number | null; error: string | null }): Promise<void>;
  syncStatus(): Promise<{ lastRun: string | null; lastOk: string | null; lastError: string | null }>;
  unmatchedAlerts(limit?: number): Promise<(Alert & { paymentId: null })[]>;
}

export class MemoryStore implements Store {
  constructor();
  init(): Promise<void>;
  createPayment(input: any): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  listPayments(opts?: any): Promise<Payment[]>;
  ingestAlerts(alerts: Alert[]): Promise<Payment[]>;
  matchAlerts(): Promise<Payment[]>;
  claimUtr(id: string, utr: string): Promise<any>;
  claimSync(minSeconds: number): Promise<any>;
  finishSync(r: any): Promise<void>;
  syncStatus(): Promise<any>;
  unmatchedAlerts(limit?: number): Promise<any[]>;
}

export class PostgresStore extends MemoryStore {
  constructor(opts: { connectionString?: string; ssl?: any; max?: number; pool?: any; client?: { query(text: string, params?: any[]): Promise<{ rows: any[] }> }; migrate?: boolean });
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface UpiPayOptions {
  vpa: string;                                   // your UPI ID
  payeeName: string;                             // shown in UPI apps
  gmail?: { user: string; appPassword: string } | null;
  store?: Store;
  expiresInMinutes?: number;                     // default 10
  refPrefix?: string;                            // 2-5 letters, default 'PAY'
  alertSenders?: string | string[];              // default: Indian banks' alert domains
  syncThrottleSeconds?: number;                  // default 10
  webhook?: { url: string; secret: string; timeoutMs?: number } | null;
  onPaid?: (payment: Payment) => void | Promise<void>;
  testMode?: boolean;
  logger?: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void };
}

export interface HandlerOptions {
  basePath?: string;                             // default '/upi'
  apiKey?: string;
  publicCreate?: boolean;
  publicCreatePerMinute?: number;
  cors?: string | string[] | null;
}

export interface UpiPay {
  store: Store;
  on(event: 'paid' | 'underpaid', fn: (payment: Payment) => void): UpiPay;
  on(event: 'synced', fn: (r: SyncResult) => void): UpiPay;
  on(event: 'error', fn: (e: Error) => void): UpiPay;
  off(event: string, fn: (...a: any[]) => void): UpiPay;
  createPayment(input: { amount: number; orderId?: string; customer?: string; note?: string; metadata?: Record<string, unknown>; qr?: boolean }): Promise<PublicPayment>;
  getPayment(id: string, opts?: { sync?: boolean }): Promise<Payment | null>;
  getPublicPayment(id: string, opts?: { sync?: boolean; qr?: boolean }): Promise<PublicPayment | null>;
  listPayments(opts?: { status?: string; orderId?: string; limit?: number }): Promise<Payment[]>;
  unmatchedPayments(limit?: number): Promise<Alert[]>;
  claimUtr(id: string, utr: string): Promise<{ result: 'paid' | 'underpaid' | 'not_found' | 'used'; payment: Payment; triesLeft: number }>;
  sync(opts?: { force?: boolean }): Promise<SyncResult>;
  start(everySeconds?: number): UpiPay;
  stop(): UpiPay;
  status(): Promise<{ upiId: string; payeeName: string; inboxConfigured: boolean; testMode: boolean; inbox: { lastRun: string | null; lastOk: string | null; lastError: string | null } }>;
  simulatePayment(id: string, amount?: number): Promise<Payment>;
  toPublic(p: Payment, withQr?: boolean): Promise<PublicPayment>;
  handler(opts?: HandlerOptions): (req: any, res: any, next?: () => void) => Promise<void>;
}

export interface SyncResult { ran: boolean; alerts: number; credited: Payment[]; error: string | null; }

export class UpiError extends Error { code: string; status: number; }

export function createUpiPay(opts: UpiPayOptions): UpiPay;
export function verifyWebhook(rawBody: string | Buffer, signatureHeader: string, secret: string, toleranceSeconds?: number): boolean;
export function signWebhook(body: string, secret: string, unixSeconds?: number): string;
export function parseAlert(subject: string, body: string, opts?: { refRe?: RegExp; ownVpa?: string }): { amount: number; utr: string; ref: string; payer: string } | null;
export function payLink(o: { vpa: string; name: string; amount: number; ref: string }): string;
export function qrSvg(text: string): Promise<string>;
export const RULES: Record<string, number>;
