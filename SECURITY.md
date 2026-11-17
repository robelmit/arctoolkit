# Security

This code tells merchants when they have been paid. Please treat a bug in it as one that can cost money.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. Include the package and version, what you expected, what happened, and a transaction that shows it if you have one.

You will get an answer within three working days. A fix for anything that can mark an unpaid invoice as paid is released before the report is made public, and you are credited unless you ask not to be.

## What counts

- An invoice marked paid without a matching payment on chain, or a payment counted twice.
- A payment credited to the wrong invoice.
- A webhook that `verifyWebhook` accepts without the secret, or after the tolerance.
- Anything in the checkout server that lets a caller without the API key create, list or read invoices beyond the public status page.

## What this repo never does

- It never holds, asks for or logs a private key. `address` mode takes an extended public key and refuses a private one.
- It never moves money.

## Using it safely

- Verify every webhook with `verifyWebhook` on the raw body before acting on it.
- Use your own Arc RPC endpoint for anything that matters.
- Keep the API key and the webhook secret out of your repository.
