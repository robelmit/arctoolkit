# arctoolkit

Open-source, non-custodial USDC and EURC payments on [Arc](https://arc.io), Circle's stablecoin chain.

A shop runs one small server. It creates invoices, shows customers a payment page with a QR code, follows the chain, and sends the shop a signed webhook when the money arrives. The money goes straight to the shop's own wallet: nothing here holds a key or can move funds.

| Package | What |
|---|---|
| [`@arctoolkit/pay`](packages/pay) | The library: invoices, payment matching, webhooks, payment links and QR codes |
| [`@arctoolkit/evm`](packages/evm) | A small JSON-RPC client with retries, call pacing and log range splitting, and the Arc network constants |
| [`apps/checkout`](apps/checkout) | The checkout server: a merchant API, the payment page, Docker image |
| [`examples/webhook-receiver`](examples/webhook-receiver) | The shop's side: checks each webhook and handles it once |

## Why another checkout

Arc pays gas in USDC, and USDC on Arc has two faces: the native coin (18 decimals) and an ERC-20 interface at `0x3600…0000` (6 decimals), one balance. A customer's wallet may pay either way. Every USDC movement is logged with 18 decimals by a system emitter at `0xffff…fffe`; only ERC-20 calls also log on the token interface. A checkout that watches the token interface misses every plain native send. This one watches the system emitter, and was checked against a real ERC-20 transfer and a real native send on Arc mainnet.

It also never guesses. A payment it cannot place with certainty (wrong amount, an invoice already paid, an amount two invoices could claim) is recorded and announced for a person to look at, not credited.

## Quick start

```
git clone <this repository> && cd arctoolkit
pnpm install
cp apps/checkout/.env.example apps/checkout/.env    # ARC_NETWORK=testnet, your address, an API key
pnpm --filter @arctoolkit/checkout start
```

Then create an invoice and open its `checkoutUrl`; the [checkout README](apps/checkout/README.md) has the requests. To use the library inside your own server instead, start from the [pay README](packages/pay/README.md).

## Working on it

Node 22.13 or later and pnpm 11 for development; the packages run on Node 20 or later.

```
pnpm install
pnpm check            # build, typecheck, test, lint
LIVE=1 pnpm test      # adds tests that read Arc mainnet; they never send
```

## Rules

- **Nothing holds a key or moves money.** Address mode uses an extended public key; a private key is refused.
- **Never guess.** Unplaceable payments go to a person.
- **Exact amounts.** Integer units everywhere; no float touches money.
- **Nothing lost on restart.** The chain position, counted payments and undelivered webhooks are saved.

See [SECURITY.md](SECURITY.md) to report a vulnerability and [CONTRIBUTING.md](CONTRIBUTING.md) to help.

## Licence

MIT
