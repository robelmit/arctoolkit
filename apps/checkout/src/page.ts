/**
 * The payment page a customer sees. One self-contained HTML document: no
 * external script, font or image, so it loads fast and the content security
 * policy can forbid everything else. It asks for the invoice's status every
 * two seconds and shows "paid" the moment the gateway sees the payment.
 */

import type { Invoice } from '@arctoolkit/pay';

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PageInput {
  readonly invoice: Invoice;
  readonly shopName: string;
  /** ERC-681 links: USDC as the native coin (null for EURC) and the token transfer. */
  readonly links: { readonly native: string | null; readonly token: string };
  readonly explorer: string;
  readonly testnet: boolean;
  /** A fresh value per response, allowing the one inline script. */
  readonly nonce: string;
}

export function checkoutPage(input: PageInput): string {
  const { invoice, links } = input;
  const qrKind = links.native ? 'native' : 'token';
  const walletLink = links.native ?? links.token;
  const amountNote =
    invoice.mode === 'amount'
      ? '<p class="note">Send exactly this amount: the last digits identify your payment.</p>'
      : '<p class="note">This address is for this payment only.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pay ${escapeHtml(input.shopName)}</title>
<style>
  :root { --bg: #f6f7f9; --card: #ffffff; --ink: #14171c; --muted: #5b6370; --line: #e3e6eb; --accent: #2a5bd7; --ok: #137a3f; --warn: #a3470d; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a20; --ink: #eef0f3; --muted: #a0a7b3; --line: #2a2f38; --accent: #7aa2ff; --ok: #4ccf86; --warn: #f0a868; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display: grid; place-items: center; padding: 16px; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: .9rem; margin: 0; }
  .amount { font-size: 2rem; font-weight: 650; margin: 20px 0 4px; font-variant-numeric: tabular-nums; word-break: break-all; }
  .note { color: var(--muted); font-size: .85rem; margin: 0 0 16px; }
  .qr { display: block; width: 100%; max-width: 260px; margin: 0 auto 16px; background: #fff; border-radius: 8px; padding: 8px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  code { flex: 1; font-size: .8rem; padding: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; word-break: break-all; }
  button, .button { font: inherit; font-size: .9rem; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 8px; padding: 8px 12px; cursor: pointer; text-decoration: none; }
  .button.primary { display: block; text-align: center; background: var(--accent); border-color: var(--accent); color: #fff; margin: 16px 0 8px; padding: 12px; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .button.primary { color: #0f1115; } }
  .status { margin-top: 16px; padding: 12px; border-radius: 8px; border: 1px solid var(--line); font-weight: 600; }
  .status[data-state="paid"] { color: var(--ok); border-color: var(--ok); }
  .status[data-state="expired"] { color: var(--warn); border-color: var(--warn); }
  .badge { display: inline-block; font-size: .75rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--warn); color: var(--warn); margin-left: 6px; }
  footer { margin-top: 16px; font-size: .75rem; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(input.shopName)}${input.testnet ? '<span class="badge">testnet</span>' : ''}</h1>
  <p class="muted">${invoice.description ? escapeHtml(invoice.description) : 'Payment'}${invoice.orderId ? ` · ${escapeHtml(invoice.orderId)}` : ''}</p>
  <p class="amount"><span id="due">${escapeHtml(invoice.dueAmount)}</span> ${escapeHtml(invoice.currency)}</p>
  ${amountNote}
  <img class="qr" src="/pay/${encodeURIComponent(invoice.id)}/qr.svg?kind=${qrKind}" alt="QR code to pay ${escapeHtml(invoice.dueAmount)} ${escapeHtml(invoice.currency)} on Arc">
  <a class="button primary" href="${escapeHtml(walletLink)}">Open in wallet</a>
  <div class="row"><code id="address">${escapeHtml(invoice.address)}</code><button type="button" data-copy="address">Copy</button></div>
  <div class="row"><code id="amount">${escapeHtml(invoice.dueAmount)}</code><button type="button" data-copy="amount">Copy</button></div>
  <p class="muted">Network: Arc ${input.testnet ? 'testnet' : 'mainnet'} · ${escapeHtml(invoice.currency)}</p>
  <div class="status" id="status" data-state="${invoice.status}" role="status" aria-live="polite">${statusText(invoice)}</div>
  <footer>Paid straight to the shop's own address. Arc payments are final within a second. <a id="tx" href="#" hidden>View transaction</a></footer>
</main>
<script nonce="${input.nonce}">
(() => {
  const id = ${JSON.stringify(invoice.id)};
  const explorer = ${JSON.stringify(input.explorer)};
  const status = document.getElementById('status');
  const tx = document.getElementById('tx');
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = document.getElementById(button.dataset.copy).textContent;
      try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; setTimeout(() => (button.textContent = 'Copy'), 1500); } catch {}
    });
  }
  const show = (s) => {
    status.dataset.state = s.status;
    status.textContent = s.status === 'paid' ? 'Paid. Thank you.' + (s.late ? ' (received after the invoice expired)' : '') : s.status === 'expired' ? 'This invoice expired. Ask the shop for a new one before paying.' : s.received !== '0.00' ? 'Partly paid: ' + s.received + ' received. Waiting for the rest…' : 'Waiting for payment… expires in ' + Math.max(0, Math.round((s.expiresAt - Date.now()) / 60000)) + ' min';
    if (s.lastTx) { tx.href = explorer + '/tx/' + s.lastTx; tx.hidden = false; }
  };
  const tick = async () => {
    try {
      const response = await fetch('/pay/' + encodeURIComponent(id) + '/status', { cache: 'no-store' });
      if (response.ok) { const s = await response.json(); show(s); if (s.status !== 'open') return; }
    } catch {}
    setTimeout(tick, 2000);
  };
  tick();
})();
</script>
</body>
</html>`;
}

function statusText(invoice: Invoice): string {
  if (invoice.status === 'paid') return 'Paid. Thank you.';
  if (invoice.status === 'expired') return 'This invoice expired. Ask the shop for a new one before paying.';
  return 'Waiting for payment…';
}
