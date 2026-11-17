# Checkout

A self-hosted USDC and EURC checkout for [Arc](https://arc.io). The shop's server asks it for an invoice; the customer opens a payment page with the exact amount, a QR code and an "Open in wallet" button; the page turns to "Paid" within seconds of the payment; the shop gets a signed webhook.

The money goes straight from the customer's wallet to the shop's own address. The checkout holds no key and cannot move anything.

A customer whose USDC is on Base, Ethereum, Arbitrum, OP Mainnet, Polygon or Avalanche can pay from there: the page asks their browser wallet to send it through Circle's CCTP, and Circle delivers it to the invoice's address on Arc.

It is a thin server around [`@arctoolkit/pay`](../../packages/pay), which reads the chain, matches payments to invoices and signs the webhooks.

## Run it

```
cp apps/checkout/.env.example apps/checkout/.env    # fill it in
pnpm install
pnpm --filter @arctoolkit/checkout start
```

Or with Docker, from the repository root:

```
docker build -f apps/checkout/Dockerfile -t arc-checkout .
docker run --env-file apps/checkout/.env -p 127.0.0.1:8790:8790 -v arc-checkout:/data arc-checkout
```

Start on `ARC_NETWORK=testnet`; testnet USDC comes from Circle's faucet.

## Take a payment

```
curl -X POST http://127.0.0.1:8790/v1/invoices \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"amount":"4.50","description":"Flat white","orderId":"A-17"}'
```

```json
{
  "data": {
    "id": "inv_a8be078c4a7a5fb0fd8b57d2",
    "status": "open",
    "amount": "4.50",
    "dueAmount": "4.504452",
    "currency": "USDC",
    "address": "0x…",
    "links": { "native": "ethereum:0x…@5042002?value=4504452000000000000", "token": "ethereum:0x3600…@5042002/transfer?address=0x…&uint256=4504452" },
    "checkoutUrl": "http://127.0.0.1:8790/pay/inv_a8be078c4a7a5fb0fd8b57d2",
    "...": "…"
  }
}
```

Send the customer to `checkoutUrl`, or draw `links.native` yourself. When the payment lands, the checkout POSTs `invoice.paid` to your `WEBHOOK_URL`; ship on that event, not on the page. [`examples/webhook-receiver`](../../examples/webhook-receiver) is a receiver that checks the signature and handles each event once.

`dueAmount` is not a typo. With a single receiving address, each open invoice asks for a slightly different amount (the last digits are its tag), and that is how a payment is told apart. With `RECEIVE_XPUB` set, pass `"mode": "address"` and each invoice gets its own address and asks for the amount as given. The [pay README](../../packages/pay/README.md#telling-payments-apart) explains both.

## Routes

Every API answer is JSON: `{ "data": … }` or `{ "error": { "code", "message" } }`.

### For the shop (`Authorization: Bearer <API_KEY>`)

| Route | What |
|---|---|
| `POST /v1/invoices` | Creates an invoice. Body: `amount` (decimal string, required), `currency` (`USDC` or `EURC`), `mode` (`amount` or `address`), `description`, `orderId`, `metadata` (strings), `expiresInSeconds` (default 1,800) |
| `GET /v1/invoices?status=&limit=` | Invoices, newest first; `status` is `open`, `paid` or `expired` |
| `GET /v1/invoices/{id}` | One invoice with every payment toward it |
| `GET /v1/unmatched` | Payments the checkout would not credit to any invoice, with the reason and the invoices to look at |
| `GET /v1/webhooks` | Webhooks still waiting to be delivered, with the last error |

### For the customer (public)

| Route | What |
|---|---|
| `GET /pay/{id}` | The payment page |
| `GET /pay/{id}/status` | `status`, `dueAmount`, `received`, `expiresAt`, `late`, `lastTx`. Nothing about the order or the payer |
| `GET /pay/{id}/qr.svg?kind=native\|token` | The QR code |
| `GET /pay/{id}/cctp?from=base` | For paying from another chain: the two transactions for the customer's wallet, built from Circle's current fee for what is still due. Address-mode USDC invoices only. `from` is `base`, `ethereum`, `arbitrum`, `optimism`, `polygon` or `avalanche` |
| `GET /pay/{id}/cctp/status?from=base&tx=0x…` | Where a sent transfer stands at Circle: `not_found`, `pending`, `attested` or `delivered`. For the page to show progress; the invoice is paid by the mint the checkout reads on Arc |
| `GET /health` | `{ ok, network, cursor, modes }` |

Anyone who has an invoice's id can see what is due and whether it is paid. Ids are 96 random bits.

### Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_BODY`, `INVALID_AMOUNT`, `INVALID_FIELD`, `MODE_NOT_SET_UP` | The message says which field and why |
| 401 | `UNAUTHORIZED` | No API key, or the wrong one |
| 404 | `NOT_FOUND`, `NO_ROUTE` | No such invoice or route |
| 409 | `NO_FREE_TAG` | Every tag for that amount is taken by an open invoice: use `address` mode, or wait for some to expire |
| 409 | `CROSS_CHAIN_NOT_AVAILABLE`, `INVOICE_NOT_OPEN` | The invoice is paid on Arc only (amount mode, EURC, or `CROSS_CHAIN=0`), or it is no longer open |
| 503 | `FEES_UNAVAILABLE`, `STATUS_UNAVAILABLE` | Circle's API did not answer, or quoted no forwarding for that route |
| 413 | `TOO_LARGE` | Bodies are at most 16 KB |
| 429 | `RATE_LIMITED` | Public routes: 120 requests a minute per client; `Retry-After` says how long |
| 500 | `FAILED` | Anything else. The message is general on purpose |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ARC_NETWORK` | required | `mainnet` or `testnet` |
| `RECEIVE_ADDRESS` | — | The shop's address, for `amount` mode |
| `RECEIVE_XPUB` | — | The shop's extended **public** key, for `address` mode. A private key is refused |
| `API_KEY` | required | At least 24 characters |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | — | Set both or neither; the secret is at least 16 characters |
| `ARC_RPC_URL` | the network's public endpoint | Checked at start: it must serve the chosen network |
| `PUBLIC_URL` | each request's origin | The address customers reach, for `checkoutUrl` |
| `SHOP_NAME` | `Checkout` | Shown on the payment page |
| `STORE_PATH` | `./data/checkout.json` | Invoices, the chain position, undelivered webhooks |
| `PORT`, `HOST` | `8790`, `127.0.0.1` | Where it listens |
| `TRUST_PROXY` | unset | `1` when exactly one reverse proxy of yours is in front; clients are then counted by the address it appended to `X-Forwarded-For` |
| `CROSS_CHAIN` | `1` | `0` hides "pay from another chain". It is offered only on address-mode USDC invoices, so it also needs `RECEIVE_XPUB` |

At least one of `RECEIVE_ADDRESS` and `RECEIVE_XPUB` is required. A setting that is missing or malformed stops the server at start.

## In production

- Put it behind HTTPS (a reverse proxy) and set `PUBLIC_URL` and `TRUST_PROXY=1`.
- Keep the merchant routes off the public internet if you can; only `/pay/*` needs to be reachable by customers.
- Back up `STORE_PATH`. Losing it loses the open invoices, not the money: payments are on chain and the money is already in your wallet.
- One process per store file.

## The payment page

One HTML document with its CSS and one small script inline: no outside font, image or script, so it loads fast on a phone and its content security policy allows nothing else. It follows the system's light or dark setting, asks for the status every two seconds, and links to the transaction on the Arc explorer once paid. A testnet invoice says "testnet" beside the shop's name.

On an address-mode USDC invoice the page also offers **USDC on another chain?** The customer picks the chain and presses "Pay with wallet". The page then uses the browser wallet (a wallet extension, or the browser inside a wallet app) to:

1. connect, and switch to that chain;
2. check the USDC balance there, and say so if it is short;
3. ask for an approval, unless one is already in place;
4. ask for the transfer: the invoice's amount plus Circle's fee, shown before the wallet opens;
5. follow it at Circle ("confirmed on Base… bringing it to Arc…") until the invoice turns to paid.

The wallet signs and sends; the checkout only builds the two transactions. Walking away or rejecting at any step leaves nothing half done: the approval alone moves no money.

## Tests

```
pnpm --filter @arctoolkit/checkout test
```

13 tests call the server as a function from `Request` to `Response`, with Circle's API answered from recorded responses. The server was also run against Arc testnet: it checked the chain id, followed new blocks, created invoices in both modes, and served the page, its QR code and its status, in light and dark mode on a phone-sized screen. "Pay with wallet" was driven in that page with a stand-in wallet and Circle's real testnet fees: it switched to Base Sepolia, checked balance and allowance, and asked for exactly the approval and transfer the server planned; no wallet, a cancelled request and a short balance each gave their message. No real payment was sent; that needs faucet USDC in a wallet.

## Licence

MIT
