/**
 * The JSON the checkout server hands the pages: embedded in the page for the first paint, and answered by its
 * public and merchant routes afterwards.
 */

export type Network = 'mainnet' | 'testnet';
export type Currency = 'USDC' | 'EURC';
export type InvoiceStatus = 'open' | 'paid' | 'expired';
export type MatchMode = 'amount' | 'address';

/** `GET /pay/{id}/status`: what anyone with the invoice's id may see. Amounts are decimals. */
export interface PublicStatus {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly currency: Currency;
  readonly dueAmount: string;
  readonly address: string;
  readonly received: string;
  readonly expiresAt: number;
  readonly late: boolean;
  readonly lastTx: string | null;
}

/** Embedded in the payment page. */
export interface PayData {
  readonly shopName: string;
  readonly network: Network;
  readonly explorer: string;
  readonly invoice: PublicStatus & {
    readonly mode: MatchMode;
    readonly amount: string;
    readonly description: string | null;
    readonly orderId: string | null;
  };
  /** ERC-681 links: USDC as Arc's native coin (null for EURC), and the token transfer. */
  readonly links: { readonly native: string | null; readonly token: string };
  /** Chains the customer may pay from through Circle's CCTP, or null when the invoice is paid on Arc only. */
  readonly crossChain: readonly { readonly key: string; readonly name: string }[] | null;
}

/** Embedded in the dashboard. */
export interface DashboardData {
  readonly shopName: string;
  readonly network: Network;
  readonly explorer: string;
}

/** `GET /pay/{id}/cctp?from=`: the two transactions for the customer's wallet. Amounts in units are strings. */
export interface CctpPlan {
  readonly source: { readonly key: string; readonly name: string; readonly chainId: number; readonly usdc: string; readonly explorer: string };
  readonly amount: string;
  readonly maxFee: string;
  readonly receive: string;
  readonly sendAmount: string;
  readonly receiveAmount: string;
  readonly spender: string;
  readonly approve: { readonly to: string; readonly data: string };
  readonly burn: { readonly to: string; readonly data: string };
}

/** `GET /pay/{id}/cctp/status`: where a sent transfer stands at Circle. */
export interface CctpProgress {
  readonly state: 'not_found' | 'pending' | 'attested' | 'delivered';
  readonly mintTx: string | null;
  readonly delayReason: string | null;
}

export interface Payment {
  readonly id: string;
  readonly tx: string;
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly currency: Currency;
  /** 6-decimal units. */
  readonly units: string;
}

/** An invoice as the merchant API returns it. Amounts in units are strings; decimals sit beside them. */
export interface Invoice {
  readonly id: string;
  readonly network: Network;
  readonly currency: Currency;
  readonly mode: MatchMode;
  readonly amount: string;
  readonly due: string;
  readonly dueAmount: string;
  readonly address: string;
  readonly description: string | null;
  readonly orderId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: InvoiceStatus;
  readonly received: string;
  readonly payments: readonly Payment[];
  readonly paidAt: number | null;
  readonly late: boolean;
  readonly checkoutUrl: string;
}

export type UnmatchedReason = 'no_invoice_with_this_amount' | 'invoice_already_paid' | 'amount_matches_several_invoices';

export interface UnmatchedPayment extends Payment {
  readonly reason: UnmatchedReason;
  readonly hints: readonly string[];
}

export interface PendingWebhook {
  readonly eventId: string;
  readonly attempts: number;
  readonly nextAt: number;
  readonly lastError: string | null;
}

export interface Health {
  readonly ok: boolean;
  readonly network: Network;
  readonly cursor: number | null;
  readonly modes: readonly MatchMode[];
}
