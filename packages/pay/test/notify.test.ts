/** Payment notifications: what they say, where they go, and the settings that turn them on. */

import { describe, expect, it } from 'vitest';
import { createNotifier, notificationLines, readNotifyTargets, unitsToAmount, type GatewayEvent, type Invoice, type Payment } from '../src';

const payment: Payment = { id: '0xabc:1', tx: '0xabc', block: 10, at: 1, from: '0x5bbe3adb4e5fc0747d7b261acea5be4fc157692c', to: '0x1', currency: 'USDC', units: '25000123', dust: '0' };
const invoice = {
  id: 'inv_1',
  network: 'testnet',
  currency: 'USDC',
  mode: 'amount',
  amount: '25',
  units: '25000000',
  due: '25000123',
  dueAmount: '25.000123',
  address: '0x1',
  addressIndex: null,
  description: 'Two mugs',
  orderId: '1042',
  metadata: {},
  createdAt: 0,
  expiresAt: 1,
  status: 'paid',
  received: '25000123',
  payments: [payment],
  paidAt: 1,
  late: false,
} as Invoice;
const event = (type: GatewayEvent['type'], over: Partial<GatewayEvent> = {}): GatewayEvent => ({ id: 'evt_1', type, at: 1, invoice, payment, ...over });

describe('notifications', () => {
  it('say what happened in plain words, with the order and the transaction', () => {
    expect(unitsToAmount('25000123')).toBe('25.000123');
    expect(unitsToAmount('5000000')).toBe('5');
    expect(unitsToAmount('120')).toBe('0.00012');
    expect(notificationLines(event('invoice.paid'))).toEqual(['💵 Paid: 25 USDC', 'Order 1042 · Two mugs', 'From 0x5bbe…692c', 'https://explorer.testnet.arc.io/tx/0xabc']);
    expect(notificationLines(event('invoice.payment', { invoice: { ...invoice, received: '10000000' } as Invoice, payment: { ...payment, units: '10000000' } }))![0]).toBe('🟡 Part paid: 10 USDC toward 25 USDC (10 received so far)');
    expect(notificationLines(event('invoice.expired', { payment: undefined }))).toEqual(['⌛ Expired unpaid: 25 USDC', 'Order 1042 · Two mugs']);
    expect(notificationLines(event('payment.unmatched', { invoice: undefined }))![0]).toBe('❓ A payment of 25.000123 USDC matched no invoice');
  });

  it('go to a Discord channel without mentions and to a Telegram chat, and a failure is logged, not thrown', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const logs: string[] = [];
    const notify = createNotifier(
      { discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc', telegram: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh', chatId: '-100123' } },
      {
        fetch: async (url, init) => {
          sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
          if (url.includes('telegram')) throw new Error('offline');
          return { ok: true, status: 204 };
        },
        log: (_level, message) => logs.push(message),
      },
    );
    notify(event('invoice.paid'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent[0]).toMatchObject({ url: 'https://discord.com/api/webhooks/1/abc', body: { allowed_mentions: { parse: [] } } });
    expect(String(sent[0]!.body.content)).toContain('💵 Paid: 25 USDC');
    expect(sent[1]).toMatchObject({ url: 'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh/sendMessage', body: { chat_id: '-100123' } });
    expect(logs).toEqual(['a notification failed']);
  });

  it('are on only when set, and a malformed setting stops the server at start', () => {
    const get = (values: Record<string, string>) => (name: string) => values[name];
    expect(readNotifyTargets(get({}))).toBeNull();
    expect(readNotifyTargets(get({ NOTIFY_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }))).toEqual({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc', telegram: null });
    expect(() => readNotifyTargets(get({ NOTIFY_DISCORD_WEBHOOK_URL: 'https://example.com/hook' }))).toThrow(/Discord channel webhook/);
    expect(() => readNotifyTargets(get({ NOTIFY_TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh' }))).toThrow(/go together/);
    expect(() => readNotifyTargets(get({ NOTIFY_TELEGRAM_BOT_TOKEN: 'nope', NOTIFY_TELEGRAM_CHAT_ID: '1' }))).toThrow(/bot token/);
  });
});
