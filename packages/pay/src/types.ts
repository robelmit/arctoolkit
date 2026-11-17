/**
 * The records the gateway keeps. Amounts are strings of whole 6-decimal units
 * in storage and in webhooks (`"25000123"` is 25.000123), so no digit is lost
 * in JSON; each carries a decimal form beside it for people.
 */

import type { Currency, Network } from './constants';

/**
 * How a payment is told apart from the others.
 *
 * - `amount`: one receiving address; each open invoice asks for a slightly different amount (the requested amount
 *   plus up to 0.009999 of the currency), and a payment of exactly that amount pays it. No setup.
 * - `address`: each invoice gets its own address, derived from the merchant's extended public key. Any amount sent
 *   there counts toward it, so partial and cross-chain payments are attributed too.
 */
export type MatchMode = 'amount' | 'address';

export type InvoiceStatus = 'open' | 'paid' | 'expired';

export interface Payment {
  /** `transactionHash:logIndex`: the same payment is never counted twice. */
  readonly id: string;
  readonly tx: string;
  readonly block: number;
  /** When it was made, in milliseconds. */
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly currency: Currency;
  /** 6-decimal units. */
  readonly units: string;
  /** For a native USDC send: what it carried below a 6-decimal unit, in 18-decimal units. */
  readonly dust: string;
}

export interface Invoice {
  readonly id: string;
  readonly network: Network;
  readonly currency: Currency;
  readonly mode: MatchMode;
  /** What the merchant asked for, as a decimal and in units. */
  readonly amount: string;
  readonly units: string;
  /** What the payer must send. In `amount` mode it carries the invoice's tag in the last digits. */
  readonly due: string;
  readonly dueAmount: string;
  /** Where to send it. */
  readonly address: string;
  /** The child index of `address` in `address` mode. */
  readonly addressIndex: number | null;
  readonly description: string | null;
  /** The merchant's own reference, returned in every webhook. */
  readonly orderId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: InvoiceStatus;
  /** Everything received toward it, in units. */
  received: string;
  payments: Payment[];
  paidAt: number | null;
  /** Paid after it expired. */
  late: boolean;
}

export type UnmatchedReason = 'no_invoice_with_this_amount' | 'invoice_already_paid' | 'amount_matches_several_invoices';

export interface UnmatchedPayment extends Payment {
  readonly reason: UnmatchedReason;
  /** Invoices a person may want to look at: same amount before the tag, or the one already paid. */
  readonly hints: readonly string[];
}

export type GatewayEventType = 'invoice.paid' | 'invoice.payment' | 'invoice.expired' | 'payment.unmatched';

export interface GatewayEvent {
  readonly id: string;
  readonly type: GatewayEventType;
  /** When the gateway recorded it, in milliseconds. */
  readonly at: number;
  readonly invoice?: Invoice;
  readonly payment?: Payment | UnmatchedPayment;
}
