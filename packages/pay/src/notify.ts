/**
 * Payment notifications for the merchant: a short message in a Discord
 * channel (through a channel webhook, no bot needed) or a Telegram chat
 * (through a bot) when an invoice is paid, part-paid or expires, or when a
 * payment matches no invoice. They are a convenience beside the signed
 * webhook, which stays the record to build on: a notification is tried once,
 * and a failure is logged, not retried.
 */

import { NETWORKS } from './constants';
import type { GatewayEvent, Invoice, Payment } from './types';

export interface NotifyTargets {
  /** A Discord channel webhook URL (`https://discord.com/api/webhooks/…`). */
  readonly discordWebhookUrl?: string | null;
  /** A Telegram bot and the chat it posts in. */
  readonly telegram?: { readonly botToken: string; readonly chatId: string } | null;
}

/** Whole 6-decimal units as a decimal: `25000123` → `25.000123`, trailing zeros dropped. */
export function unitsToAmount(units: string): string {
  if (!/^\d+$/.test(units)) return units;
  const padded = units.padStart(7, '0');
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

const short = (value: string): string => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

/** What a notification says, as lines of plain text; null for an event that tells the merchant nothing new. */
export function notificationLines(event: GatewayEvent): string[] | null {
  const invoice: Invoice | undefined = event.invoice;
  const payment: Payment | undefined = event.payment;
  const explorer = NETWORKS[invoice?.network ?? 'testnet'].explorer;
  const ref = invoice ? `${invoice.orderId ? `Order ${invoice.orderId}` : `Invoice ${invoice.id}`}${invoice.description ? ` · ${invoice.description}` : ''}` : null;
  const paid = payment ? `${unitsToAmount(payment.units)} ${payment.currency}` : null;
  const tx = payment ? `${explorer}/tx/${payment.tx.split(':')[0]}` : null;
  switch (event.type) {
    case 'invoice.paid':
      return [`💵 Paid: ${invoice ? `${invoice.amount} ${invoice.currency}` : (paid ?? '')}${invoice?.late ? ' (after it expired)' : ''}`, ...(ref ? [ref] : []), ...(payment ? [`From ${short(payment.from)}`, tx!] : [])];
    case 'invoice.payment':
      return [`🟡 Part paid: ${paid ?? '—'} toward ${invoice ? `${invoice.amount} ${invoice.currency}` : 'an invoice'} (${invoice ? `${unitsToAmount(invoice.received)} received so far` : 'more due'})`, ...(ref ? [ref] : []), ...(tx ? [tx] : [])];
    case 'invoice.expired':
      return [`⌛ Expired unpaid: ${invoice ? `${invoice.amount} ${invoice.currency}` : 'an invoice'}`, ...(ref ? [ref] : [])];
    case 'payment.unmatched':
      return [`❓ A payment of ${paid ?? '—'} matched no invoice`, ...(payment ? [`From ${short(payment.from)}`, tx!] : []), 'Look at it in the dashboard: the payer may have sent a different amount.'];
    default:
      return null;
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/**
 * The gateway's `onEvent` that sends each event to the targets. Sending runs in the background; `log` hears of a
 * failure. Mentions are switched off on Discord, so no text in an order can ping anyone.
 */
export function createNotifier(targets: NotifyTargets, options: { readonly fetch?: Fetch; readonly log?: (level: string, message: string, fields?: Record<string, unknown>) => void } = {}): (event: GatewayEvent) => void {
  const send = options.fetch ?? (fetch as unknown as Fetch);
  const post = async (where: string, url: string, body: unknown): Promise<void> => {
    try {
      const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) options.log?.('warn', 'a notification was refused', { where, status: response.status });
    } catch (error) {
      options.log?.('warn', 'a notification failed', { where, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (event) => {
    const lines = notificationLines(event);
    if (!lines) return;
    const text = lines.join('\n');
    if (targets.discordWebhookUrl) void post('discord', targets.discordWebhookUrl, { content: text.slice(0, 1_900), allowed_mentions: { parse: [] } });
    if (targets.telegram) void post('telegram', `https://api.telegram.org/bot${targets.telegram.botToken}/sendMessage`, { chat_id: targets.telegram.chatId, text: text.slice(0, 4_000), link_preview_options: { is_disabled: true } });
  };
}

/** Reads the notification settings; throws on a malformed one, naming it. Null when none is set. */
export function readNotifyTargets(get: (name: string) => string | undefined): NotifyTargets | null {
  const discord = get('NOTIFY_DISCORD_WEBHOOK_URL');
  if (discord && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(discord)) throw new Error('NOTIFY_DISCORD_WEBHOOK_URL is a Discord channel webhook URL (https://discord.com/api/webhooks/…)');
  const token = get('NOTIFY_TELEGRAM_BOT_TOKEN');
  const chat = get('NOTIFY_TELEGRAM_CHAT_ID');
  if (Boolean(token) !== Boolean(chat)) throw new Error('NOTIFY_TELEGRAM_BOT_TOKEN and NOTIFY_TELEGRAM_CHAT_ID go together');
  if (token && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('NOTIFY_TELEGRAM_BOT_TOKEN does not look like a bot token');
  if (chat && !/^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(chat)) throw new Error('NOTIFY_TELEGRAM_CHAT_ID is a chat id (a number) or @channelname');
  if (!discord && !token) return null;
  return { discordWebhookUrl: discord ?? null, telegram: token && chat ? { botToken: token, chatId: chat } : null };
}
