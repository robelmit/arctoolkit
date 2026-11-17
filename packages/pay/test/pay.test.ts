import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressWord, uintWord, type EvmLog, type EvmRpc } from '@arctoolkit/evm';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import {
  AddressDeriver,
  Gateway,
  InvoiceError,
  JsonFilePayStore,
  MAX_TAG,
  MemoryPayStore,
  NETWORKS,
  RETRY_SCHEDULE_MS,
  SIGNATURE_HEADER,
  SYSTEM_EMITTER,
  TRANSFER_TOPIC,
  WebhookVerificationError,
  checksumAddress,
  formatAmount,
  fromNative,
  parseAmount,
  paymentLinks,
  paymentOf,
  qrSvg,
  signWebhook,
  verifyWebhook,
  type GatewayEvent,
  type Payment,
} from '../src';

// The well-known Hardhat test mnemonic: public test keys, never funded on Arc.
const MNEMONIC = 'test test test test test test test test test test test junk';
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/0'/0").publicExtendedKey;
const MERCHANT = '0x00000000000000000000000000000000000000aa';
const PAYER = '0x00000000000000000000000000000000000000bb';
const SECRET = 'whsec_0123456789abcdef';

describe('amounts', () => {
  it('parses decimal strings exactly and refuses anything else', () => {
    expect(parseAmount('25')).toBe(25_000_000n);
    expect(parseAmount('25.5')).toBe(25_500_000n);
    expect(parseAmount('0.000001')).toBe(1n);
    expect(parseAmount(' 1234.567891 ')).toBe(1_234_567_891n);
    for (const bad of ['', '-1', '1.2345678', '1e6', '1,000', 'abc', '.5', '5.']) expect(() => parseAmount(bad), bad).toThrow();
  });

  it('formats units with at least two decimals', () => {
    expect(formatAmount(25_000_000n)).toBe('25.00');
    expect(formatAmount(25_000_123n)).toBe('25.000123');
    expect(formatAmount(500_000n)).toBe('0.50');
    expect(formatAmount(1n)).toBe('0.000001');
  });

  it('splits a native value into units and the remainder the ERC-20 view does not show', () => {
    expect(fromNative(3_157_572_668_368_848_187_475n)).toEqual({ units: 3_157_572_668n, dust: 368_848_187_475n });
    expect(fromNative(10n ** 12n - 1n)).toEqual({ units: 0n, dust: 10n ** 12n - 1n });
  });
});

describe('payment links and QR codes', () => {
  it('asks for USDC as the native coin and as an ERC-20, and for EURC as an ERC-20', () => {
    expect(paymentLinks({ network: 'mainnet', currency: 'USDC', to: MERCHANT, units: 25_000_123n })).toEqual({
      native: `ethereum:${MERCHANT}@5042?value=25000123000000000000`,
      token: `ethereum:0x3600000000000000000000000000000000000000@5042/transfer?address=${MERCHANT}&uint256=25000123`,
    });
    const eurc = paymentLinks({ network: 'testnet', currency: 'EURC', to: MERCHANT, units: 5_000_000n });
    expect(eurc.native).toBeNull();
    expect(eurc.token).toBe(`ethereum:${NETWORKS.testnet.eurc}@5042002/transfer?address=${MERCHANT}&uint256=5000000`);
    expect(() => paymentLinks({ network: 'mainnet', currency: 'USDC', to: 'nope', units: 1n })).toThrow(/address/);
    expect(() => paymentLinks({ network: 'mainnet', currency: 'USDC', to: MERCHANT, units: 0n })).toThrow(/positive/);
  });

  it('draws a QR code as SVG', () => {
    const svg = qrSvg(`ethereum:${MERCHANT}@5042?value=1`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox');
    expect(() => qrSvg('')).toThrow();
  });
});

describe('addresses from an extended public key', () => {
  it('derives the same addresses a wallet shows for the same keys', () => {
    const deriver = new AddressDeriver(XPUB);
    // The Hardhat test accounts 0 and 1.
    expect(checksumAddress(deriver.address(0))).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(checksumAddress(deriver.address(1))).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(deriver.address(2)).toBe(deriver.address(2));
    expect(() => deriver.address(-1)).toThrow();
    expect(() => deriver.address(2 ** 31)).toThrow();
  });

  it('refuses a private key outright, and anything that is not an extended key', () => {
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).privateExtendedKey;
    expect(() => new AddressDeriver(xprv)).toThrow(/PRIVATE/);
    expect(() => new AddressDeriver('hello')).toThrow(/extended public key/);
    expect(() => checksumAddress('0x12')).toThrow();
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ type: 'invoice.paid' });
  const now = 1_800_000_000_000;

  it('verifies a body signed with the secret, within the tolerance', () => {
    const header = signWebhook(SECRET, body, now);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(() => verifyWebhook({ header, body, secret: SECRET, nowMs: now + 60_000 })).not.toThrow();
  });

  it('refuses a changed body, another secret, an old signature and a missing header', () => {
    const header = signWebhook(SECRET, body, now);
    const refuse = (options: Parameters<typeof verifyWebhook>[0]): string => {
      try {
        verifyWebhook(options);
        return 'accepted';
      } catch (error) {
        return error instanceof WebhookVerificationError ? error.message : 'other';
      }
    };
    expect(refuse({ header, body: `${body} `, secret: SECRET, nowMs: now })).toContain('does not match');
    expect(refuse({ header, body, secret: 'another-secret-entirely', nowMs: now })).toContain('does not match');
    expect(refuse({ header, body, secret: SECRET, nowMs: now + 301_000 })).toContain('too old');
    expect(refuse({ header: null, body, secret: SECRET, nowMs: now })).toContain('missing');
    expect(refuse({ header: 't=abc,v1=00', body, secret: SECRET, nowMs: now })).toContain('missing');
    expect(() => signWebhook('short', body)).toThrow(/16/);
  });
});

const log = (over: Partial<EvmLog> & { value: bigint; to?: string; from?: string }): EvmLog => ({
  address: over.address ?? SYSTEM_EMITTER,
  topics: [TRANSFER_TOPIC, `0x${addressWord(over.from ?? PAYER)}`, `0x${addressWord(over.to ?? MERCHANT)}`],
  data: `0x${uintWord(over.value)}`,
  blockNumber: over.blockNumber ?? 100,
  transactionHash: over.transactionHash ?? '0xtx',
  logIndex: over.logIndex ?? 0,
  blockTimestamp: over.blockTimestamp === undefined ? 1_800_000_000 : over.blockTimestamp,
});

describe('reading a payment from a log', () => {
  it('reads USDC from the system emitter in 18 decimals and EURC from its token in 6', () => {
    expect(paymentOf(log({ value: 25_000_123_000_000_000_007n }), 'mainnet', 5)).toMatchObject({ currency: 'USDC', units: '25000123', dust: '7', to: MERCHANT, from: PAYER, at: 5, id: '0xtx:0' });
    expect(paymentOf(log({ address: NETWORKS.mainnet.eurc, value: 5_000_000n }), 'mainnet', 5)).toMatchObject({ currency: 'EURC', units: '5000000', dust: '0' });
  });

  it('ignores the USDC interface\'s own log, other tokens, other events and the other network\'s EURC', () => {
    expect(paymentOf(log({ address: NETWORKS.mainnet.usdc, value: 25_000_000n }), 'mainnet', 5)).toBeNull();
    expect(paymentOf(log({ address: '0x00000000000000000000000000000000000000cc', value: 1n }), 'mainnet', 5)).toBeNull();
    expect(paymentOf({ ...log({ value: 1n }), topics: ['0x1234'] }, 'mainnet', 5)).toBeNull();
    expect(paymentOf(log({ address: NETWORKS.testnet.eurc, value: 1n }), 'mainnet', 5)).toBeNull();
    expect(paymentOf({ ...log({ value: 1n }), data: '0x' }, 'mainnet', 5)).toBeNull();
  });
});

const payment = (over: Partial<Payment> = {}): Payment => ({ id: `0x${Math.random().toString(16).slice(2)}:0`, tx: '0xtx', block: 100, at: 1_800_000_000_000, from: PAYER, to: MERCHANT, currency: 'USDC', units: '25000000', dust: '0', ...over });

function gatewayOf(over: { xpub?: boolean; address?: boolean; webhook?: boolean; fetch?: typeof fetch; store?: MemoryPayStore; rpc?: EvmRpc } = {}) {
  let now = 1_800_000_000_000;
  const events: GatewayEvent[] = [];
  const store = over.store ?? new MemoryPayStore();
  const gateway = new Gateway({
    network: 'mainnet',
    rpc: over.rpc ?? ({ call: async () => { throw new Error('no chain in this test'); } } as EvmRpc),
    store,
    receive: { ...(over.address === false ? {} : { address: MERCHANT }), ...(over.xpub ? { xpub: XPUB } : {}) },
    webhook: over.webhook ? { url: 'https://merchant.example/hooks', secret: SECRET } : null,
    fetch: over.fetch,
    now: () => now,
    onEvent: (event) => events.push(event),
  });
  return { gateway, store, events, tick: (ms: number) => (now += ms), at: () => now };
}

describe('invoices', () => {
  it('gives each open amount-mode invoice its own tag, under one cent', async () => {
    const { gateway } = gatewayOf();
    const invoices = await Promise.all(Array.from({ length: 50 }, () => gateway.createInvoice({ amount: '25.00' })));
    const dues = new Set(invoices.map((i) => i.due));
    expect(dues.size).toBe(50);
    for (const invoice of invoices) {
      const tag = BigInt(invoice.due) - BigInt(invoice.units);
      expect(tag >= 1n && tag <= BigInt(MAX_TAG)).toBe(true);
      expect(invoice).toMatchObject({ mode: 'amount', currency: 'USDC', address: MERCHANT, amount: '25.00', units: '25000000', status: 'open', received: '0', addressIndex: null });
      expect(invoice.dueAmount).toBe(formatAmount(BigInt(invoice.due)));
      expect(invoice.id).toMatch(/^inv_[0-9a-f]{24}$/);
    }
  });

  it('gives each address-mode invoice the next derived address', async () => {
    const { gateway } = gatewayOf({ xpub: true });
    const first = await gateway.createInvoice({ amount: '10', mode: 'address' });
    const second = await gateway.createInvoice({ amount: '10', mode: 'address' });
    expect(first).toMatchObject({ mode: 'address', addressIndex: 0, address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', due: '10000000' });
    expect(second).toMatchObject({ addressIndex: 1, address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' });
    // With a key, address mode is the default.
    expect((await gateway.createInvoice({ amount: '1' })).mode).toBe('address');
    expect(gateway.modes).toEqual(['amount', 'address']);
  });

  it('refuses what it cannot honour, with a code', async () => {
    const { gateway } = gatewayOf();
    const code = async (input: Parameters<Gateway['createInvoice']>[0]): Promise<string> => {
      try {
        await gateway.createInvoice(input);
        return 'created';
      } catch (error) {
        return error instanceof InvoiceError ? error.code : 'other';
      }
    };
    expect(await code({ amount: '0' })).toBe('INVALID_AMOUNT');
    expect(await code({ amount: '1.0000001' })).toBe('INVALID_AMOUNT');
    expect(await code({ amount: '1', mode: 'address' })).toBe('MODE_NOT_SET_UP');
    expect(await code({ amount: '1', currency: 'BTC' as never })).toBe('INVALID_FIELD');
    expect(await code({ amount: '1', expiresInSeconds: 5 })).toBe('INVALID_FIELD');
    expect(await code({ amount: '1', description: 'x'.repeat(501) })).toBe('INVALID_FIELD');
    expect(await code({ amount: '1', metadata: { a: 1 as never } })).toBe('INVALID_FIELD');
    expect(() => new Gateway({ network: 'mainnet', rpc: {} as EvmRpc, store: new MemoryPayStore(), receive: {} })).toThrow(/receiving address/);
    expect(() => new Gateway({ network: 'mainnet', rpc: {} as EvmRpc, store: new MemoryPayStore(), receive: { address: 'nope' } })).toThrow(/not an address/);
  });

  it('runs out of tags before it would reuse one, and says so', async () => {
    const { gateway } = gatewayOf();
    // Fill every tag of one amount directly, as a busy shop might over a day.
    await Promise.all(Array.from({ length: MAX_TAG }, () => gateway.createInvoice({ amount: '1' })));
    await expect(gateway.createInvoice({ amount: '1' })).rejects.toMatchObject({ code: 'NO_FREE_TAG' });
    expect((await gateway.createInvoice({ amount: '2' })).status).toBe('open');
  }, 60_000);
});

describe('matching payments to invoices', () => {
  it('pays an amount-mode invoice with exactly its amount, once', async () => {
    const { gateway, events } = gatewayOf();
    const invoice = await gateway.createInvoice({ amount: '25.00', orderId: 'order-7' });
    const other = await gateway.createInvoice({ amount: '25.00' });
    const paying = payment({ units: invoice.due });
    expect(await gateway.applyPayments([paying, paying])).toBe(1);
    expect(gateway.invoice(invoice.id)).toMatchObject({ status: 'paid', received: invoice.due, late: false, paidAt: paying.at, orderId: 'order-7' });
    expect(gateway.invoice(other.id)!.status).toBe('open');
    expect(events.map((e) => e.type)).toEqual(['invoice.payment', 'invoice.paid']);
  });

  it('never guesses: a rounded amount, a second payment and a stranger\'s payment are recorded as unmatched', async () => {
    const { gateway } = gatewayOf();
    const invoice = await gateway.createInvoice({ amount: '25.00' });
    // Sent as 25.00 by a wallet or exchange that dropped the tag: named as a hint, not paid.
    await gateway.applyPayments([payment({ units: '25000000' })]);
    expect(gateway.invoice(invoice.id)!.status).toBe('open');
    expect(gateway.unmatched()[0]).toMatchObject({ reason: 'no_invoice_with_this_amount', hints: [invoice.id] });
    await gateway.applyPayments([payment({ units: invoice.due })]);
    await gateway.applyPayments([payment({ units: invoice.due })]);
    expect(gateway.unmatched()[0]).toMatchObject({ reason: 'invoice_already_paid', hints: [invoice.id] });
    // A transfer in the other currency does not pay a USDC invoice.
    const eurcInvoice = await gateway.createInvoice({ amount: '3', currency: 'EURC' });
    await gateway.applyPayments([payment({ units: eurcInvoice.due, currency: 'USDC' })]);
    expect(gateway.invoice(eurcInvoice.id)!.status).toBe('open');
    await gateway.applyPayments([payment({ units: eurcInvoice.due, currency: 'EURC' })]);
    expect(gateway.invoice(eurcInvoice.id)!.status).toBe('paid');
    // Money to an address the gateway does not watch is not its business.
    expect(gateway.watched(PAYER)).toBe(false);
  });

  it('attributes a late payment of an exact amount within the window, and flags it late', async () => {
    const { gateway, tick, at } = gatewayOf();
    const invoice = await gateway.createInvoice({ amount: '9.99', expiresInSeconds: 60 });
    tick(61_000);
    await gateway.expire();
    expect(gateway.invoice(invoice.id)!.status).toBe('expired');
    tick(3_600_000);
    await gateway.applyPayments([payment({ units: invoice.due, at: at() })]);
    expect(gateway.invoice(invoice.id)).toMatchObject({ status: 'paid', late: true });
  });

  it('adds up payments to a derived address: partial, then paid, then over', async () => {
    const { gateway, events } = gatewayOf({ xpub: true });
    const invoice = await gateway.createInvoice({ amount: '10' });
    await gateway.applyPayments([payment({ to: invoice.address, units: '4000000' })]);
    expect(gateway.invoice(invoice.id)).toMatchObject({ status: 'open', received: '4000000' });
    await gateway.applyPayments([payment({ to: invoice.address, units: '6500000' })]);
    expect(gateway.invoice(invoice.id)).toMatchObject({ status: 'paid', received: '10500000' });
    await gateway.applyPayments([payment({ to: invoice.address, units: '1' })]);
    expect(gateway.invoice(invoice.id)!.payments).toHaveLength(3);
    expect(events.filter((e) => e.type === 'invoice.paid')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'invoice.payment')).toHaveLength(3);
  });

  it('expires what was not paid, once', async () => {
    const { gateway, events, tick } = gatewayOf();
    await gateway.createInvoice({ amount: '1', expiresInSeconds: 60 });
    tick(60_001);
    expect(await gateway.expire()).toBe(1);
    expect(await gateway.expire()).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['invoice.expired']);
  });
});

describe('webhooks', () => {
  it('sends each event signed, and the merchant can verify it', async () => {
    const received: { body: string; signature: string | null; id: string | null }[] = [];
    const fakeFetch = (async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      received.push({ body: init!.body!, signature: init!.headers![SIGNATURE_HEADER] ?? null, id: init!.headers!['arc-event-id'] ?? null });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { gateway, at } = gatewayOf({ webhook: true, fetch: fakeFetch });
    const invoice = await gateway.createInvoice({ amount: '5' });
    await gateway.applyPayments([payment({ units: invoice.due })]);
    expect(await gateway.deliverWebhooks()).toBe(2);
    expect(gateway.pendingWebhooks()).toHaveLength(0);
    for (const hook of received) expect(() => verifyWebhook({ header: hook.signature, body: hook.body, secret: SECRET, nowMs: at() })).not.toThrow();
    const paid = JSON.parse(received[1]!.body) as GatewayEvent;
    expect(paid).toMatchObject({ type: 'invoice.paid', invoice: { id: invoice.id, status: 'paid' } });
    expect(received[1]!.id).toBe(paid.id);
  });

  it('retries a failed delivery on a schedule, and drops it after the last try', async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    }) as unknown as typeof fetch;
    const { gateway, tick } = gatewayOf({ webhook: true, fetch: failing });
    await gateway.createInvoice({ amount: '1', expiresInSeconds: 60 });
    tick(61_000);
    await gateway.expire();
    await gateway.deliverWebhooks();
    expect(gateway.pendingWebhooks()[0]).toMatchObject({ attempts: 1, lastError: 'HTTP 503' });
    await gateway.deliverWebhooks();
    expect(calls).toBe(1);
    for (const wait of RETRY_SCHEDULE_MS.slice(1)) {
      tick(wait);
      await gateway.deliverWebhooks();
    }
    expect(calls).toBe(RETRY_SCHEDULE_MS.length);
    expect(gateway.pendingWebhooks()).toHaveLength(0);
  });
});

describe('following the chain', () => {
  function chain(head: { value: number }, logs: EvmLog[]) {
    const asked: string[] = [];
    const rpc: EvmRpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'eth_blockNumber') return `0x${head.value.toString(16)}` as T;
        if (method === 'eth_getLogs') {
          const filter = params[0] as { address: string[]; fromBlock: string; toBlock: string };
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          asked.push(`${from}-${to}`);
          expect(filter.address).toEqual([SYSTEM_EMITTER, NETWORKS.mainnet.eurc]);
          return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to).map((l) => ({ ...l, blockNumber: `0x${l.blockNumber.toString(16)}`, logIndex: `0x${l.logIndex.toString(16)}`, blockTimestamp: l.blockTimestamp === null ? undefined : `0x${l.blockTimestamp.toString(16)}` })) as T;
        }
        if (method === 'eth_getBlockByNumber') return { timestamp: '0x6b49d200' } as T;
        throw new Error(method);
      },
    };
    return { rpc, asked };
  }

  it('starts at the head, reads each new block once, and pays an invoice from a real-shaped log', async () => {
    const head = { value: 1_000 };
    const logs: EvmLog[] = [];
    const { rpc, asked } = chain(head, logs);
    const { gateway } = gatewayOf({ rpc });
    expect(await gateway.poll()).toBe(0);
    expect(gateway.cursor).toBe(1_000);
    const invoice = await gateway.createInvoice({ amount: '25' });
    logs.push(log({ value: BigInt(invoice.due) * 10n ** 12n + 5n, blockNumber: 1_003, transactionHash: '0xpaid' }));
    logs.push(log({ value: 99n * 10n ** 18n, blockNumber: 1_003, to: PAYER, transactionHash: '0xnotours', logIndex: 1 }));
    head.value = 1_005;
    expect(await gateway.poll()).toBe(1);
    expect(gateway.invoice(invoice.id)).toMatchObject({ status: 'paid' });
    expect(gateway.invoice(invoice.id)!.payments[0]).toMatchObject({ tx: '0xpaid', dust: '5', at: 1_800_000_000_000 });
    expect(asked).toEqual(['1000-1000', '1001-1005']);
    // Nothing new: nothing is read again.
    expect(await gateway.poll()).toBe(0);
  });

  it('carries on after a restart from the block it stopped at, so a payment made while it was down is still seen', async () => {
    const head = { value: 500 };
    const logs: EvmLog[] = [];
    const store = new MemoryPayStore();
    const first = gatewayOf({ rpc: chain(head, logs).rpc, store });
    await first.gateway.poll();
    const invoice = await first.gateway.createInvoice({ amount: '3' });
    // Down for a while; the payment lands meanwhile.
    head.value = 900;
    logs.push(log({ value: BigInt(invoice.due) * 10n ** 12n, blockNumber: 700, blockTimestamp: null }));
    const second = gatewayOf({ rpc: chain(head, logs).rpc, store });
    await second.gateway.poll();
    expect(second.gateway.invoice(invoice.id)).toMatchObject({ status: 'paid' });
    // The block's time was asked for when the log did not carry it.
    expect(second.gateway.invoice(invoice.id)!.payments[0]!.at).toBe(0x6b49d200 * 1000);
  });

  it('keeps its state in a JSON file across restarts, and refuses a file it cannot read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcpay-'));
    try {
      const path = join(dir, 'state', 'pay.json');
      const make = () => new Gateway({ network: 'mainnet', rpc: {} as EvmRpc, store: new JsonFilePayStore(path), receive: { address: MERCHANT, xpub: XPUB } });
      const a = make();
      const invoice = await a.createInvoice({ amount: '7', mode: 'address' });
      await a.applyPayments([payment({ to: invoice.address, units: '7000000', id: '0xa:1' })]);
      const b = make();
      await b.load();
      expect(b.invoice(invoice.id)).toMatchObject({ status: 'paid', received: '7000000' });
      // The next address continues where the last left off, and a counted payment is not counted again.
      expect((await b.createInvoice({ amount: '1', mode: 'address' })).addressIndex).toBe(1);
      expect(await b.applyPayments([payment({ to: invoice.address, units: '7000000', id: '0xa:1' })])).toBe(0);
      await writeFile(path, '{broken');
      await expect(make().load()).rejects.toThrow(/not JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
