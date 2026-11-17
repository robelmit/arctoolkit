# @arctoolkit/pay

Non-custodial USDC and EURC payments on [Arc](https://arc.io), Circle's stablecoin chain. Create an invoice, show the payer a link or a QR code, and get a signed webhook when the money arrives. The money goes straight to the merchant's own address, and this package never holds a key.

```ts
import { ARC_PUBLIC_RPC, createEvmRpc } from '@arctoolkit/evm';
import { Gateway, JsonFilePayStore, paymentLinks, qrSvg } from '@arctoolkit/pay';

const gateway = new Gateway({
  network: 'mainnet',
  rpc: createEvmRpc({ url: ARC_PUBLIC_RPC }),
  store: new JsonFilePayStore('./data/pay.json'),
  receive: { address: '0xYourShopAddress' },
  webhook: { url: 'https://your-shop.example/arc-webhook', secret: process.env.WEBHOOK_SECRET! },
});

const invoice = await gateway.createInvoice({ amount: '25.00', orderId: 'order-1001' });
// invoice.dueAmount → '25.004821' (the requested amount plus this invoice's tag)

const links = paymentLinks({ network: 'mainnet', currency: invoice.currency, to: invoice.address, units: BigInt(invoice.due) });
const svg = qrSvg(links.native!);

void gateway.run(new AbortController().signal); // follows the chain, expires invoices, sends webhooks
```

## Install

```
npm i @arctoolkit/pay @arctoolkit/evm
```

Node 20 or later.

## How Arc moves USDC, and why it matters here

Arc uses USDC as its gas coin. One balance has two faces:

- the **native coin**, with 18 decimals, used for gas and for plain sends;
- an **ERC-20 interface** at `0x3600…0000`, with 6 decimals.

A payer's wallet may send either way. Every USDC movement, of either kind, is logged with 18 decimals by a **system emitter** at `0xffff…fffe`. The ERC-20 interface also logs its own 6-decimal transfer, but only for ERC-20 calls. A checkout that watches only the ERC-20 logs misses every plain native send. This package watches the system emitter, so it sees every USDC payment exactly once, however it was sent. This was checked on Arc mainnet against a real ERC-20 transfer and a real native send.

## Telling payments apart

A plain transfer carries no reference, so the gateway offers two ways to know which invoice a payment is for:

| Mode | Setup | How | Good for |
|---|---|---|---|
| `amount` | One receiving address | Each open invoice asks for a slightly different amount: the requested amount plus a tag of 0.000001 to 0.009999. A payment of exactly that amount pays it | A shop that wants nothing more than an address |
| `address` | The merchant's extended public key (`xpub`) | Each invoice gets its own address, derived from the key. Whatever arrives there counts toward that invoice | Payments that may not be exact: partial payments, exchanges that round, USDC arriving from another chain |

In `address` mode only public keys are involved: the gateway can derive and watch the addresses, and cannot move anything. For an `xpub` of `m/44'/60'/0'/0`, invoice address *i* is the merchant wallet's account *i*. Because Arc's gas coin is USDC, money received at those addresses can be moved on without first sending them gas.

### What the gateway will not do

It never guesses. These payments are recorded as **unmatched**, with the invoices a person may want to look at, and announced with a `payment.unmatched` webhook:

- an amount that matches no open invoice (a wallet or an exchange dropped the tag);
- an exact amount for an invoice that is already paid;
- an exact amount that two invoices could both claim.

A payment of an `amount`-mode invoice's exact amount after it expired is still attributed to it within a window (24 hours by default) and flagged `late`.

## Invoices

`createInvoice({ amount, currency?, mode?, description?, orderId?, metadata?, expiresInSeconds? })`

- `amount` is a decimal string with at most six decimals. Amounts are integers throughout; no float touches money.
- `currency` is `USDC` (default) or `EURC`.
- An invoice is `open`, then `paid` or `expired`. `received` adds up every payment; `payments` lists them, each with its transaction.

## Webhooks

Events: `invoice.payment`, `invoice.paid`, `invoice.expired`, `payment.unmatched`. Each is POSTed as JSON with two headers:

- `Arc-Event-Id`: the event's id, to make your handler idempotent;
- `Arc-Signature`: `t=<unix seconds>,v1=<HMAC-SHA256 of "t.body">`.

Check every webhook before trusting it:

```ts
import { verifyWebhook } from '@arctoolkit/pay';

verifyWebhook({ header: request.headers.get('arc-signature'), body: rawBody, secret: process.env.WEBHOOK_SECRET! });
// throws WebhookVerificationError for a wrong signature, another secret, or one older than 5 minutes
```

A delivery that fails is retried after 5 s, 30 s, 2 min, 10 min, 1 h and 6 h, then dropped. Undelivered webhooks are kept in the store across restarts.

## Payment links and QR codes

`paymentLinks({ network, currency, to, units })` returns ERC-681 links a wallet opens with everything filled in: `native` asks for USDC as Arc's native coin (18-decimal value), `token` asks for an ERC-20 transfer (USDC or EURC). `qrSvg(link)` draws one as an SVG.

## Following the chain

`gateway.poll()` reads from the block it stopped at to the head; on a first start it begins at the head. Its position is saved, so after a restart it reads what it missed. A payment counted once is never counted again. `gateway.run(signal)` polls, expires and delivers webhooks every second. Arc blocks are final when made, so a payment is reported as soon as its block is read.

## Stores

`JsonFilePayStore(path)` keeps everything in one file, written through a temporary file. `MemoryPayStore` is for tests. One process owns one store; a store for several processes wants a database behind the two-method `PayStore` interface.

## Rules it keeps

- **Nothing here holds a key or moves money.**
- **Never guess.** A payment it cannot place is recorded and reported, not credited.
- **Exact amounts.** Integer units; a native send's sub-unit remainder is kept as `dust`.
- **Nothing lost on restart.** The chain position, the counted payments and the undelivered webhooks are saved.

## Tests

```
pnpm --filter @arctoolkit/pay test
LIVE=1 pnpm --filter @arctoolkit/pay test     # reads Arc mainnet; never sends
```

25 tests, plus 2 live tests that read a real ERC-20 transfer and a real native send on Arc mainnet.

## What it does not do

- No refunds, no fiat prices, no multi-currency conversion.
- No payment from another chain in `amount` mode: a cross-chain transfer arrives with fees taken off, so its amount is not exact. `address` mode attributes it.
- It was not run against a real payment to a gateway invoice; that needs a funded wallet (Arc testnet USDC comes from Circle's faucet).

## Licence

MIT
