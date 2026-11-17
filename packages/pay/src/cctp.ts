/**
 * Paying an Arc invoice with USDC held on another chain, through Circle's
 * Cross-Chain Transfer Protocol (CCTP V2) and its Forwarding Service.
 *
 * The payer's own wallet, on the chain where their USDC is, sends two
 * transactions: an approval, then `depositForBurnWithHook` on Circle's
 * TokenMessengerV2. That burns the USDC there, names the invoice's Arc address
 * as the recipient, and asks Circle (through the `cctp-forward` hook) to mint
 * it on Arc. Circle submits the mint and takes its fee from the amount, so
 * nobody needs Arc gas and nothing here holds a key.
 *
 * What arrives is the burned amount less the fees actually charged, never
 * less than the amount asked for. It is not exact, so a cross-chain payment
 * belongs to an `address`-mode invoice, whose own address attributes it. The
 * mint is logged by Arc's system emitter like any other USDC movement (checked
 * on Arc mainnet), so the gateway sees it with no extra work.
 *
 * Addresses, domains and the fee API were read from Circle's documentation and
 * checked against the live API and contracts in November 2026.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { formatAmount } from './amount';
import type { Network } from './constants';

/** Arc's CCTP domain, on mainnet and testnet. */
export const ARC_CCTP_DOMAIN = 26;

/** Hook data asking Circle to forward (mint on the destination): "cctp-forward", version 0, no extra data. */
export const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';

/** Finality thresholds: fast (soft finality, a small fee) or standard (hard finality, no protocol fee). */
export const FINALITY = Object.freeze({ fast: 1000, standard: 2000 });
export type CctpSpeed = keyof typeof FINALITY;

export interface CctpSource {
  /** A short name for links and settings: `base`, `ethereum`… */
  readonly key: string;
  readonly name: string;
  readonly domain: number;
  readonly chainId: number;
  /** Native USDC on that chain. */
  readonly usdc: string;
  readonly explorer: string;
}

export interface CctpNetwork {
  /** TokenMessengerV2: the same address on every EVM chain of the network. */
  readonly tokenMessenger: string;
  /** Circle's attestation and fee API. */
  readonly iris: string;
  readonly sources: readonly CctpSource[];
}

const source = (key: string, name: string, domain: number, chainId: number, usdc: string, explorer: string): CctpSource => Object.freeze({ key, name, domain, chainId, usdc, explorer });

export const CCTP: Readonly<Record<Network, CctpNetwork>> = Object.freeze({
  mainnet: Object.freeze({
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    iris: 'https://iris-api.circle.com',
    sources: Object.freeze([
      source('base', 'Base', 6, 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'https://basescan.org'),
      source('ethereum', 'Ethereum', 0, 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'https://etherscan.io'),
      source('arbitrum', 'Arbitrum', 3, 42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'https://arbiscan.io'),
      source('optimism', 'OP Mainnet', 2, 10, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'https://optimistic.etherscan.io'),
      source('polygon', 'Polygon', 7, 137, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'https://polygonscan.com'),
      source('avalanche', 'Avalanche', 1, 43114, '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'https://snowtrace.io'),
    ]),
  }),
  testnet: Object.freeze({
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    iris: 'https://iris-api-sandbox.circle.com',
    sources: Object.freeze([
      source('base', 'Base Sepolia', 6, 84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'https://sepolia.basescan.org'),
      source('ethereum', 'Ethereum Sepolia', 0, 11155111, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'https://sepolia.etherscan.io'),
      source('arbitrum', 'Arbitrum Sepolia', 3, 421614, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 'https://sepolia.arbiscan.io'),
      source('optimism', 'OP Sepolia', 2, 11155420, '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', 'https://sepolia-optimism.etherscan.io'),
      source('polygon', 'Polygon Amoy', 7, 80002, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', 'https://amoy.polygonscan.com'),
      source('avalanche', 'Avalanche Fuji', 1, 43113, '0x5425890298aed601595a70AB815c96711a31Bc65', 'https://testnet.snowtrace.io'),
    ]),
  }),
});

export function cctpSource(network: Network, key: string): CctpSource | null {
  return CCTP[network].sources.find((s) => s.key === key) ?? null;
}

export class CctpError extends Error {
  constructor(
    readonly code: 'FEES_UNAVAILABLE' | 'STATUS_UNAVAILABLE' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'CctpError';
  }
}

/** What Circle charges for one route at one speed. */
export interface CctpFee {
  /** The protocol fee, in millionths of a basis point (Circle quotes basis points with decimals). */
  readonly protocolMicroBps: bigint;
  /** The Forwarding Service fee, in 6-decimal units: Circle's `high` estimate, so the mint is not left waiting. */
  readonly forwardFee: bigint;
}

/** Basis points as Circle writes them (`0.325`, `1.3`) to millionths of a basis point, rounded up. */
export function microBps(value: unknown): bigint {
  const text = typeof value === 'number' ? value.toFixed(9) : String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new CctpError('FEES_UNAVAILABLE', `Circle quoted a fee rate that is not a number: ${text.slice(0, 20)}`);
  const decimals = (match[2] ?? '').padEnd(6, '0');
  const kept = BigInt(match[1]!) * 1_000_000n + BigInt(decimals.slice(0, 6));
  return /[1-9]/.test(decimals.slice(6)) ? kept + 1n : kept;
}

/** Reads Circle's fees for a transfer from `source` to Arc with forwarding. */
export async function cctpFees(network: Network, from: CctpSource, options: { fetch?: typeof fetch; speed?: CctpSpeed } = {}): Promise<CctpFee> {
  const doFetch = options.fetch ?? fetch;
  const url = `${CCTP[network].iris}/v2/burn/USDC/fees/${from.domain}/${ARC_CCTP_DOMAIN}?forward=true`;
  let body: unknown;
  try {
    const response = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new CctpError('FEES_UNAVAILABLE', `Circle's fee service did not answer: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const threshold = FINALITY[options.speed ?? 'fast'];
  const entry = Array.isArray(body) ? (body as { finalityThreshold?: unknown; minimumFee?: unknown; forwardFee?: { high?: unknown } }[]).find((e) => e.finalityThreshold === threshold) : undefined;
  const high = entry?.forwardFee?.high;
  if (!entry || (typeof high !== 'number' && typeof high !== 'string') || !/^\d+$/.test(String(high))) {
    // No forwarding fee for this route means Circle would not deliver it: refuse rather than guess.
    throw new CctpError('FEES_UNAVAILABLE', `Circle quoted no forwarding to Arc from ${from.name}`);
  }
  return { protocolMicroBps: microBps(entry.minimumFee ?? 0), forwardFee: BigInt(String(high)) };
}

export interface CctpPlan {
  readonly source: CctpSource;
  readonly speed: CctpSpeed;
  /** Who receives on Arc. */
  readonly recipient: string;
  /** What the invoice needs to receive, in 6-decimal units. */
  readonly receive: string;
  /** What the payer burns on the source chain: `receive` plus `maxFee`. */
  readonly amount: string;
  /** The most Circle may take, protocol fee and forwarding together. */
  readonly maxFee: string;
  readonly receiveAmount: string;
  readonly sendAmount: string;
  /** The contract the approval is for. */
  readonly spender: string;
  /** The two transactions for the payer's wallet, on the source chain, in order. */
  readonly approve: { readonly to: string; readonly data: string };
  readonly burn: { readonly to: string; readonly data: string };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const selector = (signature: string): string => hex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (address: string): string => address.toLowerCase().slice(2).padStart(64, '0');

export const APPROVE_SELECTOR = selector('approve(address,uint256)');
export const DEPOSIT_FOR_BURN_WITH_HOOK_SELECTOR = selector('depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)');

/**
 * The transactions that pay `units` to `recipient` on Arc from `source`. `maxFee` covers Circle's forwarding fee
 * and the protocol fee on the whole burned amount, rounded up, so what arrives is at least `units`.
 */
export function cctpPlan(input: { network: Network; source: CctpSource; recipient: string; units: bigint; fee: CctpFee; speed?: CctpSpeed }): CctpPlan {
  const { network, source: from, recipient, units, fee } = input;
  const speed = input.speed ?? 'fast';
  if (!ADDRESS.test(recipient)) throw new CctpError('INVALID', 'the recipient is not an address');
  if (units <= 0n) throw new CctpError('INVALID', 'the amount must be more than zero');
  if (fee.forwardFee < 0n || fee.protocolMicroBps < 0n) throw new CctpError('INVALID', 'a fee cannot be negative');
  // The protocol fee is charged on the burned amount, which includes maxFee itself: settle on a maxFee that covers both.
  const protocolOn = (burned: bigint): bigint => (burned * fee.protocolMicroBps + 9_999_999_999n) / 10_000_000_000n;
  let maxFee = fee.forwardFee + protocolOn(units + fee.forwardFee);
  for (let i = 0; i < 8 && fee.forwardFee + protocolOn(units + maxFee) > maxFee; i += 1) maxFee = fee.forwardFee + protocolOn(units + maxFee);
  const amount = units + maxFee;
  const messenger = CCTP[network].tokenMessenger;
  const hook = FORWARD_HOOK.slice(2);
  const burnData =
    `0x${DEPOSIT_FOR_BURN_WITH_HOOK_SELECTOR}` +
    word(amount) +
    word(ARC_CCTP_DOMAIN) +
    addressWord(recipient) +
    addressWord(from.usdc) +
    word(0) + // destinationCaller: anyone, so Circle's forwarder may submit the mint
    word(maxFee) +
    word(FINALITY[speed]) +
    word(8 * 32) + // where the hook's bytes start
    word(hook.length / 2) +
    hook;
  return {
    source: from,
    speed,
    recipient: recipient.toLowerCase(),
    receive: units.toString(),
    amount: amount.toString(),
    maxFee: maxFee.toString(),
    receiveAmount: formatAmount(units),
    sendAmount: formatAmount(amount),
    spender: messenger,
    approve: { to: from.usdc, data: `0x${APPROVE_SELECTOR}${addressWord(messenger)}${word(amount)}` },
    burn: { to: messenger, data: burnData },
  };
}

export type CctpState = 'not_found' | 'pending' | 'attested' | 'delivered';

export interface CctpStatus {
  readonly state: CctpState;
  /** The mint on Arc, once Circle has submitted it. */
  readonly mintTx: string | null;
  /** Circle's reason when a transfer is held back. */
  readonly delayReason: string | null;
}

/**
 * Where a burn stands at Circle: not seen yet, waiting for finality, attested, or delivered on Arc. For showing
 * progress only: an invoice is paid by the mint the gateway reads on Arc, never by this answer.
 */
export async function cctpStatus(network: Network, from: CctpSource, txHash: string, options: { fetch?: typeof fetch } = {}): Promise<CctpStatus> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new CctpError('INVALID', 'not a transaction hash');
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${CCTP[network].iris}/v2/messages/${from.domain}?transactionHash=${txHash}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    throw new CctpError('STATUS_UNAVAILABLE', `Circle's message service did not answer: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (response.status === 404) return { state: 'not_found', mintTx: null, delayReason: null };
  if (!response.ok) throw new CctpError('STATUS_UNAVAILABLE', `Circle's message service answered HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { messages?: { status?: unknown; forwardTxHash?: unknown; destinationMintTxHash?: unknown; delayReason?: unknown; decodedMessage?: { destinationDomain?: unknown } }[] } | null;
  // Only a message bound for Arc counts.
  const message = body?.messages?.find((m) => String(m.decodedMessage?.destinationDomain ?? ARC_CCTP_DOMAIN) === String(ARC_CCTP_DOMAIN));
  if (!message) return { state: 'not_found', mintTx: null, delayReason: null };
  const mint = [message.forwardTxHash, message.destinationMintTxHash].find((h): h is string => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) ?? null;
  const delayReason = typeof message.delayReason === 'string' && message.delayReason ? message.delayReason : null;
  if (mint) return { state: 'delivered', mintTx: mint, delayReason };
  return { state: message.status === 'complete' ? 'attested' : 'pending', mintTx: null, delayReason };
}
