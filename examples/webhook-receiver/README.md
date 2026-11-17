# Webhook receiver

The shop's side of the [checkout](../../apps/checkout): a small server that receives the checkout's webhooks and does the three things every receiver must do.

1. **Check the signature** over the body exactly as it arrived, before parsing it. A forged body, another secret, or a signature older than five minutes is refused with 400.
2. **Handle each event once.** A webhook can arrive twice, so the event id is remembered. The event is marked handled only after the shop's code succeeds; if it throws, the checkout retries and the next delivery gets another chance.
3. **Answer quickly** with a 2xx.

Ship an order on `invoice.paid` only. `invoice.expired` releases what was held for an order. `payment.unmatched` is money that arrived without a matching invoice (a wallet that rounded the amount, a second payment for a paid invoice): it is handed to a person, never credited by guess.

## Run it

```
WEBHOOK_SECRET=<the checkout's secret> pnpm --filter @arctoolkit/example-webhook-receiver start
```

It listens on `http://127.0.0.1:8791/arc-webhook` and prints what a shop would do. Set the checkout's `WEBHOOK_URL` to that address.

## Use it in your server

`createReceiver({ secret, shop, seen })` returns `handle(request: Request): Promise<Response>`, which fits any server that speaks web-standard requests (Node with a small adapter as in `src/main.ts`, Hono, Next.js route handlers, Cloudflare Workers, Deno, Bun).

- `shop.paid(orderId, event)`, `shop.expired(orderId, event)`, `shop.review(event)`: your code.
- `seen`: where handled event ids are kept. The default is memory, which a restart forgets; in production use a table with a unique key on the event id.

## Tests

```
pnpm --filter @arctoolkit/example-webhook-receiver test
```

3 tests run the receiver on the exact bodies a real gateway queues: a paid order ships once even when the event is delivered twice, unmatched money goes to review, and a missing, wrong, altered, replayed or mismatched signature is refused.

## Licence

MIT
