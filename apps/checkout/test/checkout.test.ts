import type { EvmRpc } from '@arctoolkit/evm';
import { Gateway, MemoryPayStore, type Payment } from '@arctoolkit/pay';
import { describe, expect, it } from 'vitest';
import { createCheckout } from '../src/app';
import { readSettings } from '../src/main';

const MERCHANT = '0x00000000000000000000000000000000000000aa';
const KEY = 'test-api-key-0123456789abcdef';
// m/44'/60'/0'/0 of the public Hardhat test mnemonic ("test test … junk"): never funded.
const XPUB = 'xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4';

function harness(over: { publicPerMinute?: number } = {}) {
  let now = 1_800_000_000_000;
  const rpc = { call: async () => { throw new Error('no chain in this test'); } } as EvmRpc;
  const gateway = new Gateway({ network: 'testnet', rpc, store: new MemoryPayStore(), receive: { address: MERCHANT }, now: () => now });
  const checkout = createCheckout({ gateway, network: 'testnet', apiKey: KEY, shopName: 'Coffee <&> Co', publicPerMinute: over.publicPerMinute, now: () => now });
  const call = (method: string, path: string, body?: unknown, key: string | null = KEY, client = 'a') =>
    checkout.handle(new Request(`http://shop.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), client);
  const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown> & { id: string; due: string; links: { native: string | null; token: string }; checkoutUrl: string }; error?: { code: string } };
  return { gateway, checkout, call, json, tick: (ms: number) => (now += ms), at: () => now };
}

const paid = (invoice: { due: string }, at: number): Payment => ({ id: '0xpay:0', tx: '0xpay', block: 1, at, from: '0x00000000000000000000000000000000000000bb', to: MERCHANT, currency: 'USDC', units: invoice.due, dust: '0' });

describe('the merchant API', () => {
  it('creates an invoice and hands back what to pay, the wallet links and the checkout page', async () => {
    const h = harness();
    const response = await h.call('POST', '/v1/invoices', { amount: '4.50', description: 'Flat white', orderId: 'A-17' });
    expect(response.status).toBe(201);
    const { data } = await h.json(response);
    expect(data).toMatchObject({ amount: '4.50', currency: 'USDC', mode: 'amount', address: MERCHANT, description: 'Flat white', orderId: 'A-17', status: 'open', network: 'testnet' });
    expect(data!.links.native).toBe(`ethereum:${MERCHANT}@5042002?value=${BigInt(data!.due) * 10n ** 12n}`);
    expect(data!.checkoutUrl).toBe(`http://shop.test/pay/${data!.id}`);
    const listed = await h.json(await h.call('GET', '/v1/invoices?status=open'));
    expect((listed.data as unknown as unknown[]).length).toBe(1);
    expect((await h.call('GET', `/v1/invoices/${data!.id}`)).status).toBe(200);
  });

  it('needs the API key, and compares it whole', async () => {
    const h = harness();
    expect((await h.call('POST', '/v1/invoices', { amount: '1' }, null)).status).toBe(401);
    expect((await h.call('POST', '/v1/invoices', { amount: '1' }, `${KEY}x`)).status).toBe(401);
    expect((await h.call('GET', '/v1/invoices', undefined, KEY.slice(0, -1))).status).toBe(401);
    expect((await h.call('GET', '/v1/unmatched')).status).toBe(200);
  });

  it('refuses bad input with a code, and leaks nothing on an unexpected failure', async () => {
    const h = harness();
    const code = async (body: unknown) => (await h.json(await h.call('POST', '/v1/invoices', body))).error?.code;
    expect(await code({ amount: 4.5 })).toBe('INVALID_AMOUNT');
    expect(await code({ amount: '0' })).toBe('INVALID_AMOUNT');
    expect(await code({ amount: '1', mode: 'address' })).toBe('MODE_NOT_SET_UP');
    expect(await code({ amount: '1', currency: 'BTC' })).toBe('INVALID_FIELD');
    expect(await code('{nope')).toBe('INVALID_BODY');
    expect(await code([1])).toBe('INVALID_BODY');
    expect((await h.call('GET', '/v1/invoices?status=weird')).status).toBe(400);
    expect((await h.call('GET', '/v1/nothing')).status).toBe(404);
    expect(() => createCheckout({ gateway: h.gateway, network: 'testnet', apiKey: 'short', shopName: 'x' })).toThrow(/24/);
  });
});

describe('the payment page', () => {
  it('serves a page with the exact amount, the address, a QR code and a strict security policy, escaping the shop\'s text', async () => {
    const h = harness();
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '4.50', description: '<script>alert(1)</script>' }));
    const page = await h.call('GET', `/pay/${data!.id}`, undefined, null);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(String(data!.dueAmount));
    expect(html).toContain(MERCHANT);
    expect(html).toContain('Coffee &lt;&amp;&gt; Co');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('testnet');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('draws the QR code and reports the status as the payment arrives', async () => {
    const h = harness();
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '4.50' }));
    const qr = await h.call('GET', `/pay/${data!.id}/qr.svg?kind=token`, undefined, null);
    expect(qr.headers.get('content-type')).toBe('image/svg+xml');
    expect((await qr.text()).startsWith('<svg')).toBe(true);
    const before = await (await h.call('GET', `/pay/${data!.id}/status`, undefined, null)).json();
    expect(before).toMatchObject({ status: 'open', received: '0.00', lastTx: null });
    // The public status says nothing private: no order id, no metadata, no payer.
    expect(Object.keys(before as object).sort()).toEqual(['address', 'currency', 'dueAmount', 'expiresAt', 'id', 'lastTx', 'late', 'received', 'status']);
    await h.gateway.applyPayments([paid(data!, h.at())]);
    const after = await (await h.call('GET', `/pay/${data!.id}/status`, undefined, null)).json();
    expect(after).toMatchObject({ status: 'paid', lastTx: '0xpay' });
  });

  it('answers an unknown or malformed invoice id with 404, and limits how often one client asks', async () => {
    const h = harness({ publicPerMinute: 3 });
    expect((await h.call('GET', '/pay/inv_000000000000000000000000', undefined, null)).status).toBe(404);
    // The URL is normalised before routing: this is /etc/passwd, which is no route at all.
    expect((await h.call('GET', '/pay/../../etc/passwd', undefined, null)).status).toBe(404);
    expect((await h.call('GET', '/pay/x', undefined, null)).status).toBe(404);
    expect((await h.call('GET', '/pay/x', undefined, null)).status).toBe(404);
    const limited = await h.call('GET', '/pay/x', undefined, null);
    expect(limited.status).toBe(429);
    expect((await h.call('GET', '/pay/x', undefined, null, 'another')).status).toBe(404);
  });

  it('reports health without a key', async () => {
    const h = harness();
    expect(await (await h.call('GET', '/health', undefined, null)).json()).toEqual({ ok: true, network: 'testnet', cursor: null, modes: ['amount'] });
  });
});

describe('settings', () => {
  const base = { ARC_NETWORK: 'testnet', RECEIVE_ADDRESS: MERCHANT, API_KEY: KEY };

  it('reads a complete configuration', () => {
    const settings = readSettings({ ...base, WEBHOOK_URL: 'https://shop.example/hook', WEBHOOK_SECRET: 'whsec_0123456789abcdef', RECEIVE_XPUB: XPUB });
    expect(settings).toMatchObject({ network: 'testnet', rpcUrl: 'https://rpc.testnet.arc.io', port: 8790, host: '127.0.0.1', webhook: { url: 'https://shop.example/hook' }, receive: { address: MERCHANT, xpub: XPUB } });
  });

  it('stops at start on a setting that is missing or malformed', () => {
    expect(() => readSettings({ ...base, ARC_NETWORK: undefined })).toThrow(/ARC_NETWORK/);
    expect(() => readSettings({ ...base, RECEIVE_ADDRESS: undefined })).toThrow(/RECEIVE_ADDRESS or RECEIVE_XPUB/);
    expect(() => readSettings({ ...base, RECEIVE_ADDRESS: '0x12' })).toThrow(/not an address/);
    // One character off: the key's checksum catches it, and the message names the setting.
    expect(() => readSettings({ ...base, RECEIVE_XPUB: `${XPUB.slice(0, -1)}5` })).toThrow(/RECEIVE_XPUB: not an extended public key/);
    expect(() => readSettings({ ...base, RECEIVE_XPUB: `xprv${XPUB.slice(4)}` })).toThrow(/RECEIVE_XPUB: that is an extended PRIVATE key/);
    expect(() => readSettings({ ...base, API_KEY: 'short' })).toThrow(/API_KEY/);
    expect(() => readSettings({ ...base, WEBHOOK_URL: 'https://x.example' })).toThrow(/go together/);
    expect(() => readSettings({ ...base, WEBHOOK_URL: 'https://x.example', WEBHOOK_SECRET: 'short' })).toThrow(/16/);
    expect(() => readSettings({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });
});
