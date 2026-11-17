/**
 * The gateway: creates invoices, follows the chain for payments to them,
 * decides which invoice each payment pays, expires what was not paid, and
 * tells the merchant by signed webhook.
 *
 * It never holds a key. Money goes straight to the merchant's address (or to
 * an address derived from the merchant's public key), and nothing here can
 * move it.
 *
 * One process owns one store. Every change is saved before the next one.
 */

import { blockNumber, type EvmRpc } from '@arctoolkit/evm';
import { AmountError, formatAmount, parseAmount } from './amount';
import type { Currency, Network } from './constants';
import { AddressDeriver } from './derive';
import { emptyState, type PayState, type PayStore } from './store';
import type { GatewayEvent, GatewayEventType, Invoice, MatchMode, Payment, UnmatchedPayment, UnmatchedReason } from './types';
import { readPayments } from './watch';
import { RETRY_SCHEDULE_MS, deliver, type Delivery } from './webhook';

export interface GatewayOptions {
  readonly network: Network;
  readonly rpc: EvmRpc;
  readonly store: PayStore;
  /** Where money goes: one address (`amount` mode), an extended public key (`address` mode), or both. */
  readonly receive: { readonly address?: string; readonly xpub?: string };
  readonly webhook?: { readonly url: string; readonly secret: string } | null;
  /** How long an invoice stays open, by default (default 30 minutes). */
  readonly defaultExpirySeconds?: number;
  /** How long after expiry a payment of an `amount`-mode invoice's exact amount is still attributed to it (default 24 hours). */
  readonly lateWindowSeconds?: number;
  /** Paid and expired invoices older than this are dropped from the store (default 90 days). */
  readonly retentionDays?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** Called for every event, besides the webhook. */
  readonly onEvent?: (event: GatewayEvent) => void;
  readonly log?: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
}

export interface CreateInvoice {
  /** A decimal string with at most six decimals: `"25"`, `"25.50"`. */
  readonly amount: string;
  readonly currency?: Currency;
  readonly mode?: MatchMode;
  readonly description?: string | null;
  readonly orderId?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly expiresInSeconds?: number;
}

export class InvoiceError extends Error {
  constructor(
    readonly code: 'INVALID_AMOUNT' | 'INVALID_FIELD' | 'MODE_NOT_SET_UP' | 'NO_FREE_TAG',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/** The largest tag added to an `amount`-mode invoice, in 6-decimal units: 0.009999 of the currency. */
export const MAX_TAG = 9_999;
const SEEN_KEPT = 100_000;
const UNMATCHED_KEPT = 1_000;
const MAX_TEXT = 500;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const randomId = (prefix: string): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const randomTag = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % MAX_TAG) + 1;
};

export class Gateway {
  private state: PayState = emptyState();
  private readonly byId = new Map<string, Invoice>();
  private readonly byAddress = new Map<string, Invoice[]>();
  private seen = new Set<string>();
  private readonly deriver: AddressDeriver | null;
  private readonly fixedAddress: string | null;
  private readonly now: () => number;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
    const fixed = options.receive.address?.trim();
    if (fixed !== undefined && !ADDRESS.test(fixed)) throw new Error('the receiving address is not an address');
    this.fixedAddress = fixed ? fixed.toLowerCase() : null;
    this.deriver = options.receive.xpub ? new AddressDeriver(options.receive.xpub) : null;
    if (!this.fixedAddress && !this.deriver) throw new Error('give a receiving address, an extended public key, or both');
    if (options.webhook && (!/^https?:\/\//.test(options.webhook.url) || options.webhook.secret.length < 16)) throw new Error('the webhook needs an http(s) url and a secret of at least 16 characters');
  }

  /** Runs `work` after everything queued before it: one change at a time, each saved. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private index(invoice: Invoice): void {
    this.byId.set(invoice.id, invoice);
    const list = this.byAddress.get(invoice.address) ?? [];
    if (!list.includes(invoice)) list.push(invoice);
    this.byAddress.set(invoice.address, list);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.options.store.load();
    this.state = saved ?? emptyState();
    for (const invoice of this.state.invoices) this.index(invoice);
    this.seen = new Set(this.state.seen);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    this.state.seen = [...this.seen].slice(-SEEN_KEPT);
    await this.options.store.save(this.state);
  }

  private say(level: 'info' | 'warn', message: string, fields?: Record<string, unknown>): void {
    this.options.log?.(level, message, fields);
  }

  /** Addresses payments are watched for. */
  watched = (address: string): boolean => this.byAddress.has(address) || address === this.fixedAddress;

  private emit(type: GatewayEventType, fields: { invoice?: Invoice; payment?: Payment | UnmatchedPayment }): void {
    const event: GatewayEvent = { id: randomId('evt'), type, at: this.now(), ...fields };
    this.options.onEvent?.(event);
    if (this.options.webhook) this.state.outbox.push({ eventId: event.id, body: JSON.stringify(event), attempts: 0, nextAt: this.now(), lastError: null });
  }

  invoice(id: string): Invoice | null {
    return this.byId.get(id) ?? null;
  }

  invoices(filter: { status?: Invoice['status']; limit?: number } = {}): Invoice[] {
    const list = this.state.invoices.filter((i) => !filter.status || i.status === filter.status);
    return list.slice(-Math.max(1, Math.min(filter.limit ?? 100, 1_000))).reverse();
  }

  unmatched(limit = 100): UnmatchedPayment[] {
    return this.state.unmatched.slice(-Math.max(1, Math.min(limit, UNMATCHED_KEPT))).reverse();
  }

  /** What the gateway is set up for. */
  get modes(): MatchMode[] {
    return [...(this.fixedAddress ? (['amount'] as const) : []), ...(this.deriver ? (['address'] as const) : [])];
  }

  createInvoice(input: CreateInvoice): Promise<Invoice> {
    return this.serial(async () => {
      await this.load();
      const text = (value: unknown, name: string): string | null => {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value !== 'string' || value.length > MAX_TEXT) throw new InvoiceError('INVALID_FIELD', `${name} is text of at most ${MAX_TEXT} characters`);
        return value;
      };
      let units: bigint;
      try {
        units = parseAmount(input.amount);
      } catch (error) {
        throw new InvoiceError('INVALID_AMOUNT', error instanceof AmountError ? error.message : 'the amount is not valid');
      }
      if (units <= 0n) throw new InvoiceError('INVALID_AMOUNT', 'the amount must be more than zero');
      const currency = input.currency ?? 'USDC';
      if (currency !== 'USDC' && currency !== 'EURC') throw new InvoiceError('INVALID_FIELD', 'the currency is USDC or EURC');
      const mode = input.mode ?? (this.deriver ? 'address' : 'amount');
      const seconds = input.expiresInSeconds ?? this.options.defaultExpirySeconds ?? 1_800;
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 30 * 86_400) throw new InvoiceError('INVALID_FIELD', 'expiresInSeconds is a whole number from 60 to 2,592,000');
      const metadata = input.metadata ?? {};
      if (typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length > 20 || Object.entries(metadata).some(([k, v]) => typeof v !== 'string' || k.length > 64 || v.length > MAX_TEXT)) {
        throw new InvoiceError('INVALID_FIELD', 'metadata is at most 20 text values');
      }
      const now = this.now();

      let address: string;
      let addressIndex: number | null = null;
      let due = units;
      if (mode === 'address') {
        if (!this.deriver) throw new InvoiceError('MODE_NOT_SET_UP', 'address mode needs the merchant\'s extended public key');
        addressIndex = this.state.nextIndex;
        address = this.deriver.address(addressIndex);
        this.state.nextIndex += 1;
      } else if (mode === 'amount') {
        if (!this.fixedAddress) throw new InvoiceError('MODE_NOT_SET_UP', 'amount mode needs a receiving address');
        address = this.fixedAddress;
        // The tag must not be in use by an invoice a payment could still be meant for.
        const window = (this.options.lateWindowSeconds ?? 86_400) * 1000;
        const taken = new Set(
          (this.byAddress.get(address) ?? [])
            .filter((i) => i.mode === 'amount' && i.currency === currency && (i.status === 'open' || (i.status === 'expired' && now - i.expiresAt < window)))
            .map((i) => i.due),
        );
        let tag = 0;
        for (let attempt = 0; attempt < 64 && tag === 0; attempt += 1) {
          const candidate = randomTag();
          if (!taken.has((units + BigInt(candidate)).toString())) tag = candidate;
        }
        for (let candidate = 1; candidate <= MAX_TAG && tag === 0; candidate += 1) if (!taken.has((units + BigInt(candidate)).toString())) tag = candidate;
        if (tag === 0) throw new InvoiceError('NO_FREE_TAG', `every tag for ${formatAmount(units)} ${currency} is in use; use address mode for this many open invoices of one amount`);
        due = units + BigInt(tag);
      } else {
        throw new InvoiceError('INVALID_FIELD', 'mode is amount or address');
      }

      const invoice: Invoice = {
        id: randomId('inv'),
        network: this.options.network,
        currency,
        mode,
        amount: formatAmount(units),
        units: units.toString(),
        due: due.toString(),
        dueAmount: formatAmount(due),
        address,
        addressIndex,
        description: text(input.description, 'description'),
        orderId: text(input.orderId, 'orderId'),
        metadata: { ...metadata },
        createdAt: now,
        expiresAt: now + seconds * 1000,
        status: 'open',
        received: '0',
        payments: [],
        paidAt: null,
        late: false,
      };
      this.state.invoices.push(invoice);
      this.index(invoice);
      await this.save();
      return invoice;
    });
  }

  private unmatchedPayment(payment: Payment, reason: UnmatchedReason, hints: string[]): void {
    const entry: UnmatchedPayment = { ...payment, reason, hints };
    this.state.unmatched.push(entry);
    if (this.state.unmatched.length > UNMATCHED_KEPT) this.state.unmatched.splice(0, this.state.unmatched.length - UNMATCHED_KEPT);
    this.emit('payment.unmatched', { payment: entry });
    this.say('warn', 'a payment matched no invoice', { id: payment.id, units: payment.units, reason });
  }

  private credit(invoice: Invoice, payment: Payment): void {
    invoice.payments.push(payment);
    invoice.received = (BigInt(invoice.received) + BigInt(payment.units)).toString();
    this.emit('invoice.payment', { invoice, payment });
    if (invoice.status !== 'paid' && BigInt(invoice.received) >= BigInt(invoice.due)) {
      invoice.late = invoice.status === 'expired' || payment.at > invoice.expiresAt;
      invoice.status = 'paid';
      invoice.paidAt = payment.at;
      this.emit('invoice.paid', { invoice, payment });
      this.say('info', 'invoice paid', { invoice: invoice.id, received: invoice.received, late: invoice.late });
    }
  }

  /** Decides which invoice a payment pays. Never guesses: a payment it cannot place is recorded as unmatched. */
  private place(payment: Payment): void {
    const candidates = (this.byAddress.get(payment.to) ?? []).filter((i) => i.currency === payment.currency);
    if (payment.to !== this.fixedAddress) {
      // A derived address belongs to exactly one invoice: whatever arrives there is that invoice's.
      const owner = candidates.find((i) => i.mode === 'address');
      if (owner) this.credit(owner, payment);
      else this.unmatchedPayment(payment, 'no_invoice_with_this_amount', []);
      return;
    }
    const window = (this.options.lateWindowSeconds ?? 86_400) * 1000;
    const exact = candidates.filter((i) => i.mode === 'amount' && i.due === payment.units);
    const open = exact.filter((i) => i.status === 'open');
    const recent = exact.filter((i) => i.status === 'expired' && payment.at - i.expiresAt < window);
    const pick = open.length > 0 ? open : recent;
    if (pick.length === 1) return this.credit(pick[0]!, payment);
    if (pick.length > 1) return this.unmatchedPayment(payment, 'amount_matches_several_invoices', pick.map((i) => i.id));
    const paid = exact.filter((i) => i.status === 'paid').map((i) => i.id);
    if (paid.length > 0) return this.unmatchedPayment(payment, 'invoice_already_paid', paid);
    // A payment without its tag (a wallet or an exchange that rounded it): name the open invoices of that amount.
    const hints = candidates.filter((i) => i.mode === 'amount' && i.status === 'open' && i.units === payment.units).map((i) => i.id);
    this.unmatchedPayment(payment, 'no_invoice_with_this_amount', hints);
  }

  /** Applies payments read from the chain. A payment already counted is skipped. */
  applyPayments(payments: readonly Payment[]): Promise<number> {
    return this.serial(async () => {
      await this.load();
      let applied = 0;
      for (const payment of payments) {
        if (this.seen.has(payment.id)) continue;
        this.seen.add(payment.id);
        this.place(payment);
        applied += 1;
      }
      if (applied > 0) await this.save();
      return applied;
    });
  }

  /** Expires open invoices past their time, and drops old ones past the retention. */
  expire(): Promise<number> {
    return this.serial(async () => {
      await this.load();
      const now = this.now();
      let expired = 0;
      for (const invoice of this.state.invoices) {
        if (invoice.status === 'open' && now > invoice.expiresAt) {
          invoice.status = 'expired';
          this.emit('invoice.expired', { invoice });
          expired += 1;
        }
      }
      const cutoff = now - (this.options.retentionDays ?? 90) * 86_400_000;
      const before = this.state.invoices.length;
      this.state.invoices = this.state.invoices.filter((i) => i.status === 'open' || Math.max(i.expiresAt, i.paidAt ?? 0) > cutoff);
      if (this.state.invoices.length !== before) {
        this.byId.clear();
        this.byAddress.clear();
        for (const invoice of this.state.invoices) this.index(invoice);
      }
      if (expired > 0 || this.state.invoices.length !== before) await this.save();
      return expired;
    });
  }

  /** Reads the chain from where it stopped to the head. On a first start it begins at the head. */
  async poll(span = 2_000): Promise<number> {
    await this.serial(() => this.load());
    const head = await blockNumber(this.options.rpc);
    const from = this.state.cursor === null ? head : this.state.cursor + 1;
    if (head < from) return 0;
    // A long gap is read in steps, each saved, so a crash part-way does not start it over.
    const to = Math.min(head, from + span * 10 - 1);
    const payments = await readPayments(this.options.rpc, this.options.network, from, to, { watched: this.watched, span });
    await this.applyPayments(payments);
    await this.serial(async () => {
      this.state.cursor = to;
      await this.save();
    });
    return payments.length;
  }

  /** Sends webhook deliveries that are due. */
  deliverWebhooks(): Promise<number> {
    const hook = this.options.webhook;
    if (!hook) return Promise.resolve(0);
    return this.serial(async () => {
      await this.load();
      const now = this.now();
      let sent = 0;
      const due = this.state.outbox.filter((d) => d.nextAt <= now).slice(0, 20);
      for (const delivery of due) {
        const result = await deliver(hook.url, hook.secret, delivery, { fetch: this.options.fetch, nowMs: now });
        delivery.attempts += 1;
        delivery.lastError = result.error;
        if (result.ok) {
          sent += 1;
          this.state.outbox = this.state.outbox.filter((d) => d !== delivery);
        } else if (delivery.attempts >= RETRY_SCHEDULE_MS.length) {
          this.state.outbox = this.state.outbox.filter((d) => d !== delivery);
          this.say('warn', 'a webhook was dropped after every retry', { event: delivery.eventId, error: result.error });
        } else {
          delivery.nextAt = now + RETRY_SCHEDULE_MS[delivery.attempts]!;
        }
      }
      if (due.length > 0) await this.save();
      return sent;
    });
  }

  /** Webhooks not yet delivered. */
  pendingWebhooks(): readonly Delivery[] {
    return this.state.outbox;
  }

  /** Polls, expires and delivers on a timer until `signal` aborts. A failed round is logged and tried again. */
  async run(signal: AbortSignal, intervalMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      for (const [name, step] of [['poll', () => this.poll()], ['expire', () => this.expire()], ['webhooks', () => this.deliverWebhooks()]] as const) {
        try {
          await step();
        } catch (error) {
          this.say('warn', `${name} failed; it will be tried again`, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  /** The block the gateway has read up to. */
  get cursor(): number | null {
    return this.state.cursor;
  }
}
