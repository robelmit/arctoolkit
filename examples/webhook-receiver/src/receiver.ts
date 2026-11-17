/**
 * What a shop's server does with the checkout's webhooks:
 *
 * 1. Check the signature over the body exactly as received, before parsing it.
 * 2. Handle each event once: a webhook can arrive twice (a retry after a slow
 *    answer), so the event id is remembered.
 * 3. Answer 2xx quickly. Anything else is retried later.
 *
 * Only `invoice.paid` should ship an order. `invoice.payment` is a part
 * payment, `invoice.expired` frees a held order, and `payment.unmatched` is
 * money that arrived without a matching invoice: a person looks at it.
 */

import { EVENT_ID_HEADER, SIGNATURE_HEADER, WebhookVerificationError, verifyWebhook, type GatewayEvent } from '@arctoolkit/pay';

export interface Shop {
  /** The order is paid in full: ship it. Called once per order. */
  paid(orderId: string, event: GatewayEvent): Promise<void> | void;
  /** The invoice expired unpaid: release what was held for it. */
  expired(orderId: string, event: GatewayEvent): Promise<void> | void;
  /** Money arrived that no invoice claims, or part of an invoice: for a person to look at. */
  review(event: GatewayEvent): Promise<void> | void;
}

/** Remembers which events were handled. In production this is a table with a unique key. */
export interface SeenEvents {
  has(id: string): Promise<boolean> | boolean;
  add(id: string): Promise<void> | void;
}

export interface ReceiverOptions {
  readonly secret: string;
  readonly shop: Shop;
  readonly seen?: SeenEvents;
  readonly now?: () => number;
}

const answer = (status: number, text: string): Response => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export function createReceiver(options: ReceiverOptions): { handle(request: Request): Promise<Response> } {
  const memory = new Set<string>();
  const seen: SeenEvents = options.seen ?? { has: (id) => memory.has(id), add: (id) => void memory.add(id) };
  return {
    async handle(request) {
      if (request.method !== 'POST') return answer(405, 'POST only');
      const body = await request.text();
      try {
        verifyWebhook({ header: request.headers.get(SIGNATURE_HEADER), body, secret: options.secret, ...(options.now ? { nowMs: options.now() } : {}) });
      } catch (error) {
        if (error instanceof WebhookVerificationError) return answer(400, 'bad signature');
        throw error;
      }
      const event = JSON.parse(body) as GatewayEvent;
      // The header and the signed body must name the same event.
      if (request.headers.get(EVENT_ID_HEADER) !== event.id) return answer(400, 'event id mismatch');
      if (await seen.has(event.id)) return answer(200, 'already handled');

      const orderId = event.invoice?.orderId ?? null;
      if (event.type === 'invoice.paid' && orderId) await options.shop.paid(orderId, event);
      else if (event.type === 'invoice.expired' && orderId) await options.shop.expired(orderId, event);
      else if (event.type === 'payment.unmatched' || (event.type === 'invoice.paid' && !orderId)) await options.shop.review(event);
      // invoice.payment: one payment toward an invoice. invoice.paid follows when it is paid in full.

      await seen.add(event.id);
      return answer(200, 'ok');
    },
  };
}
