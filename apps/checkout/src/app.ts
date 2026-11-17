/**
 * The checkout server's routes, as a function from a web-standard `Request`
 * to a `Response`, so it is tested without a socket.
 *
 * Merchant routes need the API key as a bearer token. The payment page, its
 * status and its QR code are public: anyone with an invoice's id can see what
 * to pay and whether it is paid, and nothing else.
 */

import { InvoiceError, NETWORKS, formatAmount, paymentLinks, qrSvg, type Gateway, type Invoice, type Network } from '@arctoolkit/pay';
import { RateLimiter } from './guards';
import { checkoutPage } from './page';

export interface CheckoutOptions {
  readonly gateway: Gateway;
  readonly network: Network;
  readonly apiKey: string;
  readonly shopName: string;
  /** Where this server is reached, for the checkout links it hands out (default: the request's own origin). */
  readonly publicUrl?: string | null;
  /** Public requests a minute per client (default 120: a payment page asks every two seconds). */
  readonly publicPerMinute?: number;
  readonly now?: () => number;
}

export interface Checkout {
  handle(request: Request, client: string): Promise<Response>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}): Response => json(status, { error: { code, message } }, headers);
const MAX_BODY = 16_384;

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const nonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
};

export function createCheckout(options: CheckoutOptions): Checkout {
  const { gateway } = options;
  if (options.apiKey.length < 24) throw new Error('the API key is at least 24 characters');
  const limiter = new RateLimiter(options.publicPerMinute ?? 120, undefined, options.now);
  const net = NETWORKS[options.network];

  const linksOf = (invoice: Invoice) => paymentLinks({ network: invoice.network, currency: invoice.currency, to: invoice.address, units: BigInt(invoice.due) });
  const withLinks = (invoice: Invoice, origin: string) => ({ ...invoice, links: linksOf(invoice), checkoutUrl: `${origin}/pay/${invoice.id}` });
  const publicStatus = (invoice: Invoice) => ({
    id: invoice.id,
    status: invoice.status,
    currency: invoice.currency,
    dueAmount: invoice.dueAmount,
    address: invoice.address,
    received: formatAmount(BigInt(invoice.received)),
    expiresAt: invoice.expiresAt,
    late: invoice.late,
    lastTx: invoice.payments.at(-1)?.tx ?? null,
  });

  async function handle(request: Request, client: string): Promise<Response> {
    const url = new URL(request.url);
    const origin = (options.publicUrl ?? url.origin).replace(/\/$/, '');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    if (parts.length === 1 && parts[0] === 'health' && method === 'GET') return json(200, { ok: true, network: options.network, cursor: gateway.cursor, modes: gateway.modes });

    // The public side: the payment page, its status and its QR code.
    if (parts[0] === 'pay' && parts.length >= 2 && method === 'GET') {
      const retryAfter = limiter.take(client);
      if (retryAfter !== null) return refuse(429, 'RATE_LIMITED', 'Too many requests.', { 'retry-after': String(retryAfter) });
      const invoice = /^inv_[0-9a-f]{24}$/.test(parts[1]!) ? gateway.invoice(parts[1]!) : null;
      if (!invoice) return refuse(404, 'NOT_FOUND', 'No such invoice.');
      if (parts.length === 2) {
        const n = nonce();
        const html = checkoutPage({ invoice, shopName: options.shopName, links: linksOf(invoice), explorer: net.explorer, testnet: options.network === 'testnet', nonce: n });
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'x-frame-options': 'DENY',
            'content-security-policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          },
        });
      }
      if (parts.length === 3 && parts[2] === 'status') return json(200, publicStatus(invoice));
      if (parts.length === 3 && parts[2] === 'qr.svg') {
        const links = linksOf(invoice);
        const kind = url.searchParams.get('kind') === 'token' || !links.native ? 'token' : 'native';
        return new Response(qrSvg(kind === 'native' ? links.native! : links.token), { status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
      }
      return refuse(404, 'NO_ROUTE', 'No such route.');
    }

    // The merchant side: the API key, as a bearer token.
    if (parts[0] === 'v1') {
      const auth = request.headers.get('authorization') ?? '';
      if (!auth.startsWith('Bearer ') || !sameText(auth.slice(7), options.apiKey)) return refuse(401, 'UNAUTHORIZED', 'Send the API key as "Authorization: Bearer <key>".', { 'www-authenticate': 'Bearer' });

      if (parts.length === 2 && parts[1] === 'invoices' && method === 'POST') {
        if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY) return refuse(413, 'TOO_LARGE', 'The body is too large.');
        let body: unknown;
        try {
          const text = await request.text();
          if (text.length > MAX_BODY) return refuse(413, 'TOO_LARGE', 'The body is too large.');
          body = JSON.parse(text);
        } catch {
          return refuse(400, 'INVALID_BODY', 'The body is not JSON.');
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'INVALID_BODY', 'The body is a JSON object.');
        const b = body as Record<string, unknown>;
        if (typeof b['amount'] !== 'string') return refuse(400, 'INVALID_AMOUNT', 'amount is a decimal string, for example "25.00".');
        try {
          const invoice = await gateway.createInvoice({
            amount: b['amount'],
            currency: b['currency'] as never,
            mode: b['mode'] as never,
            description: b['description'] as never,
            orderId: b['orderId'] as never,
            metadata: b['metadata'] as never,
            expiresInSeconds: b['expiresInSeconds'] as never,
          });
          return json(201, { data: withLinks(invoice, origin) });
        } catch (error) {
          if (error instanceof InvoiceError) return refuse(error.code === 'NO_FREE_TAG' ? 409 : 400, error.code, error.message);
          throw error;
        }
      }
      if (parts.length === 2 && parts[1] === 'invoices' && method === 'GET') {
        const status = url.searchParams.get('status');
        if (status !== null && !['open', 'paid', 'expired'].includes(status)) return refuse(400, 'INVALID_FIELD', 'status is open, paid or expired.');
        const limit = Number(url.searchParams.get('limit') ?? '100');
        return json(200, { data: gateway.invoices({ status: (status ?? undefined) as Invoice['status'] | undefined, limit: Number.isInteger(limit) ? limit : 100 }).map((i) => withLinks(i, origin)) });
      }
      if (parts.length === 3 && parts[1] === 'invoices' && method === 'GET') {
        const invoice = gateway.invoice(parts[2]!);
        return invoice ? json(200, { data: withLinks(invoice, origin) }) : refuse(404, 'NOT_FOUND', 'No such invoice.');
      }
      if (parts.length === 2 && parts[1] === 'unmatched' && method === 'GET') return json(200, { data: gateway.unmatched() });
      if (parts.length === 2 && parts[1] === 'webhooks' && method === 'GET') return json(200, { data: gateway.pendingWebhooks().map((d) => ({ eventId: d.eventId, attempts: d.attempts, nextAt: d.nextAt, lastError: d.lastError })) });
      return refuse(404, 'NO_ROUTE', 'No such route.');
    }

    return refuse(404, 'NO_ROUTE', 'No such route.');
  }

  return {
    async handle(request, client) {
      try {
        return await handle(request, client);
      } catch {
        // What went wrong inside stays inside.
        return refuse(500, 'FAILED', 'The request could not be answered.');
      }
    },
  };
}
