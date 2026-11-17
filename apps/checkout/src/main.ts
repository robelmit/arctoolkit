/**
 * Starts the checkout server on a plain Node HTTP server. Every setting is an
 * environment variable; a missing or malformed one stops it at start.
 *
 *   ARC_NETWORK       required: mainnet or testnet
 *   RECEIVE_ADDRESS   the shop's address (amount mode), and/or
 *   RECEIVE_XPUB      the shop's extended public key (address mode). Never a private key.
 *   API_KEY           required: at least 24 characters; merchant routes need it as a bearer token
 *   WEBHOOK_URL       optional, with WEBHOOK_SECRET (at least 16 characters)
 *   ARC_RPC_URL       default: the network's public endpoint
 *   PUBLIC_URL        where customers reach this server, for checkout links (default: each request's origin)
 *   SHOP_NAME         shown on the payment page (default "Checkout")
 *   STORE_PATH        default ./data/checkout.json
 *   PORT, HOST        default 8790, 127.0.0.1
 *   TRUST_PROXY       1 when exactly one reverse proxy of yours is in front
 *   CROSS_CHAIN       0 to hide "pay from another chain" (default on, for address-mode USDC invoices)
 *   WEB_DIR           the built pages (default: @arctoolkit/checkout-web's dist folder)
 */

import { createEvmRpc, chainId } from '@arctoolkit/evm';
import { AddressDeriver, Gateway, JsonFilePayStore, NETWORKS, type Network } from '@arctoolkit/pay';
import { createServer, type IncomingMessage } from 'node:http';
import { createCheckout } from './app';
import { defaultWebDir, loadWeb } from './web';

const log = (level: string, message: string, fields: Record<string, unknown> = {}): void => console.error(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));

export function readSettings(env: Readonly<Record<string, string | undefined>>) {
  const get = (name: string): string | undefined => env[name]?.trim() || undefined;
  const network = get('ARC_NETWORK');
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('ARC_NETWORK is required: mainnet or testnet');
  const address = get('RECEIVE_ADDRESS');
  const xpub = get('RECEIVE_XPUB');
  if (!address && !xpub) throw new Error('RECEIVE_ADDRESS or RECEIVE_XPUB is required: where the money goes');
  if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('RECEIVE_ADDRESS is not an address');
  if (xpub) {
    try {
      new AddressDeriver(xpub);
    } catch (error) {
      throw new Error(`RECEIVE_XPUB: ${error instanceof Error ? error.message : 'not an extended public key'}`);
    }
  }
  const apiKey = get('API_KEY');
  if (!apiKey || apiKey.length < 24) throw new Error('API_KEY is required: at least 24 characters');
  const webhookUrl = get('WEBHOOK_URL');
  const webhookSecret = get('WEBHOOK_SECRET');
  if (Boolean(webhookUrl) !== Boolean(webhookSecret)) throw new Error('WEBHOOK_URL and WEBHOOK_SECRET go together');
  if (webhookSecret && webhookSecret.length < 16) throw new Error('WEBHOOK_SECRET is at least 16 characters');
  const port = Number(get('PORT') ?? '8790');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is a whole number from 1 to 65535');
  const trust = get('TRUST_PROXY');
  if (trust !== undefined && trust !== '0' && trust !== '1') throw new Error('TRUST_PROXY is 1 or 0');
  const cross = get('CROSS_CHAIN');
  if (cross !== undefined && cross !== '0' && cross !== '1') throw new Error('CROSS_CHAIN is 1 or 0');
  const rpcUrl = get('ARC_RPC_URL') ?? NETWORKS[network as Network].rpc;
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('ARC_RPC_URL must start with http:// or https://');
  const publicUrl = get('PUBLIC_URL') ?? null;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error('PUBLIC_URL must start with http:// or https://');
  return {
    network: network as Network,
    receive: { ...(address ? { address } : {}), ...(xpub ? { xpub } : {}) },
    apiKey,
    webhook: webhookUrl && webhookSecret ? { url: webhookUrl, secret: webhookSecret } : null,
    rpcUrl,
    publicUrl,
    shopName: get('SHOP_NAME') ?? 'Checkout',
    storePath: get('STORE_PATH') ?? './data/checkout.json',
    port,
    host: get('HOST') ?? '127.0.0.1',
    trustProxy: trust === '1',
    crossChain: cross !== '0',
    webDir: get('WEB_DIR') ?? null,
  };
}

function clientOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const list = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((part) => part.trim()).filter(Boolean);
    const last = list[list.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function main(): Promise<void> {
  const settings = readSettings(process.env);
  const web = loadWeb(settings.webDir ?? defaultWebDir());
  const rpc = createEvmRpc({ url: settings.rpcUrl });
  const expected = NETWORKS[settings.network].chainId;
  const id = await chainId(rpc);
  if (id !== expected) throw new Error(`ARC_RPC_URL serves chain ${id}, not Arc ${settings.network} (${expected})`);

  const gateway = new Gateway({
    network: settings.network,
    rpc,
    store: new JsonFilePayStore(settings.storePath),
    receive: settings.receive,
    webhook: settings.webhook,
    log: (level, message, fields) => log(level, message, fields),
  });
  await gateway.load();
  const checkout = createCheckout({ gateway, network: settings.network, apiKey: settings.apiKey, shopName: settings.shopName, publicUrl: settings.publicUrl, crossChain: settings.crossChain, web });

  const stop = new AbortController();
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64_000) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) });
      const response = await checkout.handle(request, clientOf(req, settings.trustProxy));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      log('error', 'request failed', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"FAILED","message":"The request could not be answered."}}');
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    log('info', 'stopping');
    stop.abort();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  void gateway.run(stop.signal);
  server.listen(settings.port, settings.host, () => log('info', 'checkout listening', { host: settings.host, port: settings.port, network: settings.network, modes: gateway.modes, webhooks: settings.webhook !== null }));
}

if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
