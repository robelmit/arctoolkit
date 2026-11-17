/**
 * A runnable receiver that prints what it would do. Point the checkout's
 * WEBHOOK_URL at it:
 *
 *   WEBHOOK_SECRET=<same secret as the checkout> pnpm --filter @arctoolkit/example-webhook-receiver start
 *   # listens on http://127.0.0.1:8791/arc-webhook
 */

import { createServer } from 'node:http';
import { createReceiver } from './receiver';

const secret = process.env['WEBHOOK_SECRET']?.trim() ?? '';
if (secret.length < 16) {
  console.error('WEBHOOK_SECRET is required: the same secret the checkout signs with (at least 16 characters)');
  process.exit(1);
}
const port = Number(process.env['PORT'] ?? '8791');

const receiver = createReceiver({
  secret,
  shop: {
    paid: (orderId, event) => console.log(`ship order ${orderId}: ${event.invoice?.dueAmount} ${event.invoice?.currency} in ${event.invoice?.payments.at(-1)?.tx}`),
    expired: (orderId) => console.log(`order ${orderId} expired unpaid: release it`),
    review: (event) => console.log(`for a person: ${event.type}`, JSON.stringify(event.payment ?? event.invoice)),
  },
});

createServer((req, res) => {
  void (async () => {
    if (req.url !== '/arc-webhook') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const response = await receiver.handle(new Request(`http://localhost${req.url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log(`receiving webhooks on http://127.0.0.1:${port}/arc-webhook`));
