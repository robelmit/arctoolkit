/**
 * Signed webhooks. The body is JSON; the header `Arc-Signature` is
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" under the shared secret>`,
 * the same shape as the signatures many payment providers send. A merchant
 * checks it with `verifyWebhook` before trusting the body.
 *
 * Pure JavaScript (no `node:crypto`), so the same check runs in Node, a
 * browser worker or an edge function.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const SIGNATURE_HEADER = 'arc-signature';
export const EVENT_ID_HEADER = 'arc-event-id';

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function signatureOf(secret: string, timestamp: number, body: string): string {
  return toHex(hmac(sha256, encoder.encode(secret), encoder.encode(`${timestamp}.${body}`)));
}

/** The header value for a body sent now. */
export function signWebhook(secret: string, body: string, nowMs: number = Date.now()): string {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('a webhook secret is at least 16 characters');
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${signatureOf(secret, t, body)}`;
}

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface VerifyOptions {
  /** The header's value. */
  readonly header: string | null | undefined;
  /** The body exactly as received, before any parsing. */
  readonly body: string;
  readonly secret: string;
  /** How old a signature may be, in seconds (default 300); an older one is refused, so a captured request cannot be replayed later. */
  readonly toleranceSeconds?: number;
  readonly nowMs?: number;
}

/** Throws `WebhookVerificationError` unless the body was signed with the secret within the tolerance. */
export function verifyWebhook(options: VerifyOptions): void {
  const header = options.header ?? '';
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2) as [string, string]).filter(([k, v]) => k && v));
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isInteger(t) || !v1) throw new WebhookVerificationError('the signature header is missing or malformed');
  const age = Math.floor((options.nowMs ?? Date.now()) / 1000) - t;
  if (Math.abs(age) > (options.toleranceSeconds ?? 300)) throw new WebhookVerificationError('the signature is too old or from the future');
  if (!sameText(signatureOf(options.secret, t, options.body), v1.toLowerCase())) throw new WebhookVerificationError('the signature does not match');
}

export interface Delivery {
  readonly eventId: string;
  readonly body: string;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

/** Wait before each retry: right away, then 5 s, 30 s, 2 min, 10 min, 1 h, 6 h. After that the delivery is dropped and counted. */
export const RETRY_SCHEDULE_MS = Object.freeze([0, 5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000]);

/** Sends one delivery; true when the endpoint answered with a 2xx. */
export async function deliver(url: string, secret: string, delivery: Delivery, options: { fetch?: typeof fetch; nowMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; error: string | null }> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(secret, delivery.body, options.nowMs ?? Date.now()), [EVENT_ID_HEADER]: delivery.eventId, 'user-agent': 'arctoolkit-webhooks/0.1' },
      body: delivery.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'manual',
    });
    if (response.status >= 200 && response.status < 300) return { ok: true, error: null };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'the request failed' };
  }
}
