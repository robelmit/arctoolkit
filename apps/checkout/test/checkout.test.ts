import type { EvmRpc } from '@arctoolkit/evm';
import { CCTP, Gateway, MemoryPayStore, cctpSource, type Payment } from '@arctoolkit/pay';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckout } from '../src/app';
import { readSettings } from '../src/main';
import { DATA_SLOT, loadWeb, scriptJson, type WebBundle } from '../src/web';

// A stand-in for the built pages: the same slot and title the real build carries.
const template = (name: string) => `<!doctype html><html><head><title>${name}</title>${DATA_SLOT}<script type="module" crossorigin src="/assets/${name}-1a2b.js"></script></head><body><div id="root"></div></body></html>`;
const WEB: WebBundle = {
  pay: template('pay'),
  dashboard: template('dashboard'),
  files: new Map([
    ['assets/pay-1a2b.js', { body: new TextEncoder().encode('console.log(1)'), type: 'text/javascript; charset=utf-8', immutable: true }],
    ['favicon.svg', { body: new TextEncoder().encode('<svg/>'), type: 'image/svg+xml', immutable: false }],
  ]),
};
/** The JSON a page was given, read back the way the browser reads it. */
const embedded = (html: string): Record<string, unknown> => JSON.parse(/<script id="arc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as Record<string, unknown>;

const MERCHANT = '0x00000000000000000000000000000000000000aa';
const KEY = 'test-api-key-0123456789abcdef';
// m/44'/60'/0'/0 of the public Hardhat test mnemonic ("test test … junk"): never funded.
const XPUB = 'xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4';

function harness(over: { publicPerMinute?: number; xpub?: boolean; fetch?: typeof fetch; crossChain?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const rpc = { call: async () => { throw new Error('no chain in this test'); } } as EvmRpc;
  const gateway = new Gateway({ network: 'testnet', rpc, store: new MemoryPayStore(), receive: { address: MERCHANT, ...(over.xpub ? { xpub: XPUB } : {}) }, now: () => now });
  const checkout = createCheckout({ gateway, network: 'testnet', apiKey: KEY, shopName: 'Coffee <&> Co', web: WEB, publicPerMinute: over.publicPerMinute, fetch: over.fetch, crossChain: over.crossChain, now: () => now });
  const call = (method: string, path: string, body?: unknown, key: string | null = KEY, client = 'a') =>
    checkout.handle(new Request(`http://shop.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), client);
  const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown> & { id: string; due: string; address: string; links: { native: string | null; token: string }; checkoutUrl: string }; error?: { code: string } };
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
    expect(() => createCheckout({ gateway: h.gateway, network: 'testnet', apiKey: 'short', shopName: 'x', web: WEB })).toThrow(/24/);
  });
});

describe('the payment page', () => {
  it('serves the payment page with what it needs to draw, under a policy that runs this server\'s scripts only', async () => {
    const h = harness();
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '4.50', description: '</script><script>alert(1)</script>', orderId: 'A-17' }));
    const page = await h.call('GET', `/pay/${data!.id}`, undefined, null);
    expect(page.status).toBe(200);
    const html = await page.text();
    // The shop's text cannot close the data element or start a script.
    expect(html).not.toContain('<script>alert(1)');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain('<title>Pay Coffee &lt;&amp;&gt; Co</title>');
    expect(embedded(html)).toMatchObject({
      shopName: 'Coffee <&> Co',
      network: 'testnet',
      explorer: 'https://explorer.testnet.arc.io',
      invoice: { id: data!.id, status: 'open', currency: 'USDC', mode: 'amount', amount: '4.50', dueAmount: data!.dueAmount, address: MERCHANT, description: '</script><script>alert(1)</script>', orderId: 'A-17', received: '0.00', lastTx: null },
      links: { native: data!.links.native, token: data!.links.token },
      crossChain: null,
    });
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves the dashboard page, which holds no data until the key is entered, and the pages\' own files', async () => {
    const h = harness();
    const dashboard = await h.call('GET', '/dashboard', undefined, null);
    expect(dashboard.status).toBe(200);
    expect(embedded(await dashboard.text())).toEqual({ shopName: 'Coffee <&> Co', network: 'testnet', explorer: 'https://explorer.testnet.arc.io' });
    const home = await h.call('GET', '/', undefined, null);
    expect([home.status, home.headers.get('location')]).toEqual([302, '/dashboard']);
    const script = await h.call('GET', '/assets/pay-1a2b.js', undefined, null);
    expect([script.status, script.headers.get('content-type'), script.headers.get('cache-control')]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    expect((await h.call('GET', '/favicon.svg', undefined, null)).headers.get('cache-control')).toBe('public, max-age=86400');
    expect((await h.call('GET', '/assets/nope.js', undefined, null)).status).toBe(404);
    expect((await h.call('GET', '/assets/../package.json', undefined, null)).status).toBe(404);
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

describe('paying from another chain', () => {
  // Circle's answers, in the shapes its live API gave (November 2026).
  const FEES = [
    { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 18831, med: 19403, high: 19899 } },
    { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 18831, med: 19403, high: 19899 } },
  ];
  const MINT = `0x${'cd'.repeat(32)}`;
  function circle(over: { down?: boolean } = {}) {
    const asked: string[] = [];
    const fetchFake = (async (url: string | URL) => {
      const text = String(url);
      asked.push(text);
      if (over.down) return new Response('unavailable', { status: 503 });
      if (text.includes('/v2/burn/USDC/fees/6/26?forward=true')) return new Response(JSON.stringify(FEES), { status: 200 });
      if (text.includes('/v2/messages/6?transactionHash=')) return new Response(JSON.stringify({ messages: [{ status: 'complete', destinationMintTxHash: MINT, decodedMessage: { destinationDomain: '26' } }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFake, asked };
  }

  it('offers it on address-mode USDC invoices only', async () => {
    const h = harness({ xpub: true, fetch: circle().fetchFake });
    const own = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'address' }));
    const tagged = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'amount' }));
    const eurc = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'address', currency: 'EURC' }));
    const offered = async (id: string, gateway = h) => embedded(await (await gateway.call('GET', `/pay/${id}`, undefined, null)).text())['crossChain'];
    expect(await offered(own.data!.id)).toEqual(expect.arrayContaining([{ key: 'base', name: 'Base Sepolia' }]));
    expect(await offered(tagged.data!.id)).toBeNull();
    expect(await offered(eurc.data!.id)).toBeNull();
    // An amount-mode invoice needs an exact amount, which a transfer with fees taken off cannot promise.
    expect((await h.json(await h.call('GET', `/pay/${tagged.data!.id}/cctp?from=base`, undefined, null))).error?.code).toBe('CROSS_CHAIN_NOT_AVAILABLE');
    const off = harness({ xpub: true, crossChain: false });
    const offInvoice = await off.json(await off.call('POST', '/v1/invoices', { amount: '10', mode: 'address' }));
    expect(await offered(offInvoice.data!.id, off)).toBeNull();
  });

  it('prepares the wallet\'s two transactions from Circle\'s fee, for what is still due, asking Circle once', async () => {
    const c = circle();
    const h = harness({ xpub: true, fetch: c.fetchFake });
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'address' }));
    const plan = (await (await h.call('GET', `/pay/${data!.id}/cctp?from=base`, undefined, null)).json()) as { recipient: string; receive: string; sendAmount: string; spender: string; burn: { to: string; data: string }; approve: { to: string }; source: { chainId: number } };
    expect(plan).toMatchObject({ recipient: data!.address, receive: '10000000', spender: CCTP.testnet.tokenMessenger, source: { chainId: 84532 } });
    expect(plan.burn.to).toBe(CCTP.testnet.tokenMessenger);
    expect(plan.approve.to).toBe(cctpSource('testnet', 'base')!.usdc);
    expect(plan.burn.data).toContain(data!.address.slice(2).toLowerCase());
    // Part paid on Arc already: only the rest is asked for.
    await h.gateway.applyPayments([{ ...paid({ due: '4000000' }, h.at()), to: data!.address }]);
    const rest = (await (await h.call('GET', `/pay/${data!.id}/cctp?from=base`, undefined, null)).json()) as { receive: string };
    expect(rest.receive).toBe('6000000');
    expect(c.asked.filter((u) => u.includes('/fees/'))).toHaveLength(1);
    expect((await h.call('GET', `/pay/${data!.id}/cctp?from=solana`, undefined, null)).status).toBe(400);
    await h.gateway.applyPayments([{ ...paid({ due: '6000000' }, h.at()), id: '0xrest:0', tx: '0xrest', to: data!.address }]);
    expect((await h.json(await h.call('GET', `/pay/${data!.id}/cctp?from=base`, undefined, null))).error?.code).toBe('INVOICE_NOT_OPEN');
  });

  it('says so when Circle is not answering', async () => {
    const h = harness({ xpub: true, fetch: circle({ down: true }).fetchFake });
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'address' }));
    const response = await h.call('GET', `/pay/${data!.id}/cctp?from=base`, undefined, null);
    expect(response.status).toBe(503);
    expect((await h.json(response)).error?.code).toBe('FEES_UNAVAILABLE');
  });

  it('reports a sent transfer\'s progress from Circle, without crediting anything on Circle\'s word', async () => {
    const h = harness({ xpub: true, fetch: circle().fetchFake });
    const { data } = await h.json(await h.call('POST', '/v1/invoices', { amount: '10', mode: 'address' }));
    const status = await (await h.call('GET', `/pay/${data!.id}/cctp/status?from=base&tx=0x${'ab'.repeat(32)}`, undefined, null)).json();
    expect(status).toEqual({ state: 'delivered', mintTx: MINT, delayReason: null });
    expect(h.gateway.invoice(data!.id)!.status).toBe('open');
    expect((await h.call('GET', `/pay/${data!.id}/cctp/status?from=base&tx=nope`, undefined, null)).status).toBe(400);
  });
});

describe('the built pages', () => {
  it('loads both templates and every asset, and refuses a folder that is not the build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-web-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'pay.html'), template('pay'));
      writeFileSync(join(dir, 'dashboard.html'), template('dashboard'));
      writeFileSync(join(dir, 'assets', 'pay-1a2b.js'), 'x');
      writeFileSync(join(dir, 'assets', 'geist-latin.woff2'), 'x');
      writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
      writeFileSync(join(dir, 'notes.txt'), 'not served');
      const web = loadWeb(dir);
      expect([...web.files.keys()].sort()).toEqual(['assets/geist-latin.woff2', 'assets/pay-1a2b.js', 'favicon.svg']);
      expect(web.files.get('assets/geist-latin.woff2')).toMatchObject({ type: 'font/woff2', immutable: true });
      writeFileSync(join(dir, 'pay.html'), '<html><title>x</title></html>');
      expect(() => loadWeb(dir)).toThrow(/no data slot/);
      rmSync(join(dir, 'pay.html'));
      expect(() => loadWeb(dir)).toThrow(/not built/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes JSON that no string inside can break out of', () => {
    const text = scriptJson({ a: '</script><!-- & \u2028' });
    expect(text).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(text)).toEqual({ a: '</script><!-- & \u2028' });
  });
});

describe('settings', () => {
  const base = { ARC_NETWORK: 'testnet', RECEIVE_ADDRESS: MERCHANT, API_KEY: KEY };

  it('reads a complete configuration', () => {
    const settings = readSettings({ ...base, WEBHOOK_URL: 'https://shop.example/hook', WEBHOOK_SECRET: 'whsec_0123456789abcdef', RECEIVE_XPUB: XPUB });
    expect(settings).toMatchObject({ network: 'testnet', rpcUrl: 'https://rpc.testnet.arc.io', port: 8790, host: '127.0.0.1', webhook: { url: 'https://shop.example/hook' }, receive: { address: MERCHANT, xpub: XPUB }, crossChain: true, webDir: null });
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
