import { Gateway, MemoryPayStore, signWebhook, type GatewayEvent } from '@arctoolkit/pay';
import type { EvmRpc } from '@arctoolkit/evm';
import { describe, expect, it } from 'vitest';
import { createReceiver } from '../src/receiver';

const SECRET = 'whsec_0123456789abcdef';
const NOW = 1_800_000_000_000;
const SHOP = '0x00000000000000000000000000000000000000aa';

function shopLog() {
  const calls: string[] = [];
  return {
    calls,
    shop: {
      paid: (orderId: string) => void calls.push(`paid ${orderId}`),
      expired: (orderId: string) => void calls.push(`expired ${orderId}`),
      review: (event: GatewayEvent) => void calls.push(`review ${event.type}`),
    },
  };
}

/** The deliveries a real gateway queues, so the receiver is tested against the exact bodies it will get. */
async function realEvents(): Promise<{ id: string; body: string }[]> {
  const rpc = { call: async () => { throw new Error('no chain in this test'); } } as EvmRpc;
  const store = new MemoryPayStore();
  const gateway = new Gateway({ network: 'testnet', rpc, store, receive: { address: SHOP }, webhook: { url: 'https://shop.example/hook', secret: SECRET }, now: () => NOW });
  const invoice = await gateway.createInvoice({ amount: '4.50', orderId: 'A-17' });
  const pay = (id: string, units: string) => ({ id, tx: id.split(':')[0]!, block: 1, at: NOW, from: '0x00000000000000000000000000000000000000bb', to: SHOP, currency: 'USDC' as const, units, dust: '0' });
  await gateway.applyPayments([pay('0xa:0', invoice.due), pay('0xb:0', '1234567')]);
  return gateway.pendingWebhooks().map((d) => ({ id: d.eventId, body: d.body }));
}

const post = (body: string, id: string, signature: string | null) =>
  new Request('http://shop.test/arc-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'arc-event-id': id, ...(signature ? { 'arc-signature': signature } : {}) }, body });

describe('the webhook receiver', () => {
  it('handles the gateway\'s own events: ships the paid order once and hands unmatched money to a person', async () => {
    const events = await realEvents();
    const types = events.map((e) => (JSON.parse(e.body) as GatewayEvent).type);
    expect(types).toEqual(['invoice.payment', 'invoice.paid', 'payment.unmatched']);
    const { calls, shop } = shopLog();
    const receiver = createReceiver({ secret: SECRET, shop, now: () => NOW });
    for (const e of events) expect((await receiver.handle(post(e.body, e.id, signWebhook(SECRET, e.body, NOW)))).status).toBe(200);
    // A retry of the paid event changes nothing.
    const paid = events[1]!;
    expect(await (await receiver.handle(post(paid.body, paid.id, signWebhook(SECRET, paid.body, NOW)))).text()).toBe('already handled');
    expect(calls).toEqual(['paid A-17', 'review payment.unmatched']);
  });

  it('refuses a body it cannot trust', async () => {
    const [event] = await realEvents();
    const { calls, shop } = shopLog();
    const receiver = createReceiver({ secret: SECRET, shop, now: () => NOW });
    const status = async (request: Request) => (await receiver.handle(request)).status;
    expect(await status(post(event!.body, event!.id, null))).toBe(400);
    expect(await status(post(event!.body, event!.id, signWebhook('another-secret-0123456789', event!.body, NOW)))).toBe(400);
    expect(await status(post(event!.body.replace('4.50', '0.01'), event!.id, signWebhook(SECRET, event!.body, NOW)))).toBe(400);
    // Signed ten minutes ago: a captured request replayed later.
    expect(await status(post(event!.body, event!.id, signWebhook(SECRET, event!.body, NOW - 600_000)))).toBe(400);
    expect(await status(post(event!.body, 'evt_other', signWebhook(SECRET, event!.body, NOW)))).toBe(400);
    expect(calls).toEqual([]);
  });

  it('does not mark an event handled when the shop fails, so the retry gets another chance', async () => {
    const events = await realEvents();
    const paid = events[1]!;
    let fail = true;
    const shipped: string[] = [];
    const receiver = createReceiver({ secret: SECRET, now: () => NOW, shop: { paid: (orderId) => { if (fail) throw new Error('database down'); shipped.push(orderId); }, expired: () => {}, review: () => {} } });
    await expect(receiver.handle(post(paid.body, paid.id, signWebhook(SECRET, paid.body, NOW)))).rejects.toThrow('database down');
    fail = false;
    expect((await receiver.handle(post(paid.body, paid.id, signWebhook(SECRET, paid.body, NOW)))).status).toBe(200);
    expect(shipped).toEqual(['A-17']);
  });
});
