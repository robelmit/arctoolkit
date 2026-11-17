/**
 * Reading payments off the chain.
 *
 * USDC: the system emitter's 18-decimal `Transfer` logs, which cover native
 * sends and ERC-20 transfers alike (the ERC-20 interface's own 6-decimal logs
 * are ignored, or every ERC-20 payment would be counted twice). A mint to the
 * merchant, for example USDC arriving from another chain through CCTP, is a
 * `Transfer` from the zero address and counts like any other.
 *
 * EURC: the token's own `Transfer` logs.
 */

import { blockTime, getLogs, topicAddress, uintAt, type EvmLog, type EvmRpc } from '@arctoolkit/evm';
import { fromNative } from './amount';
import { NETWORKS, SYSTEM_EMITTER, TRANSFER_TOPIC, type Currency, type Network } from './constants';
import type { Payment } from './types';

/** A log's transfer as a payment, or null when it is not a USDC or EURC transfer this network knows. */
export function paymentOf(log: EvmLog, network: Network, atMs: number): Payment | null {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) return null;
  let currency: Currency;
  if (log.address === SYSTEM_EMITTER) currency = 'USDC';
  else if (log.address === NETWORKS[network].eurc) currency = 'EURC';
  else return null;
  let value: bigint;
  try {
    value = uintAt(log.data, 0);
  } catch {
    return null;
  }
  const { units, dust } = currency === 'USDC' ? fromNative(value) : { units: value, dust: 0n };
  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    tx: log.transactionHash,
    block: log.blockNumber,
    at: atMs,
    from: topicAddress(log.topics[1]!),
    to: topicAddress(log.topics[2]!),
    currency,
    units: units.toString(),
    dust: dust.toString(),
  };
}

export interface ReadOptions {
  /** Blocks per log query (default 2,000). */
  readonly span?: number;
  /** Only transfers to these addresses (lower case) are returned. */
  readonly watched: (address: string) => boolean;
}

/** Every USDC and EURC payment to a watched address in a block range, in chain order. */
export async function readPayments(rpc: EvmRpc, network: Network, fromBlock: number, toBlock: number, options: ReadOptions): Promise<Payment[]> {
  if (toBlock < fromBlock) return [];
  const logs = await getLogs(rpc, { address: [SYSTEM_EMITTER, NETWORKS[network].eurc], topics: [TRANSFER_TOPIC] }, fromBlock, toBlock, options.span ?? 2_000);
  const times = new Map<number, number>();
  const out: Payment[] = [];
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    let to: string;
    try {
      to = topicAddress(log.topics[2]!);
    } catch {
      continue;
    }
    if (!options.watched(to)) continue;
    let seconds = log.blockTimestamp;
    if (seconds === null) {
      seconds = times.get(log.blockNumber) ?? (await blockTime(rpc, log.blockNumber));
      times.set(log.blockNumber, seconds);
    }
    const payment = paymentOf(log, network, seconds * 1000);
    if (payment) out.push(payment);
  }
  return out;
}
