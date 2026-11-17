/**
 * Live checks against Arc mainnet. They run only with LIVE=1, and only read.
 *
 *   LIVE=1 pnpm --filter @arctoolkit/pay test
 *   ARC_RPC_URL=<your endpoint> picks the endpoint (default: the public one)
 */

import { ARC_CHAIN_ID, ARC_PUBLIC_RPC, blockNumber, chainId, createEvmRpc, getLogs, topicAddress, uintAt } from '@arctoolkit/evm';
import { describe, expect, it } from 'vitest';
import { NETWORKS, SYSTEM_EMITTER, TRANSFER_TOPIC, readPayments } from '../src';

const live = process.env['LIVE'] === '1';
const rpc = createEvmRpc({ url: process.env['ARC_RPC_URL'] ?? ARC_PUBLIC_RPC });

describe.runIf(live)('payments on Arc mainnet, live', () => {
  it('reads a real ERC-20 USDC transfer once, with the amount the 6-decimal log reports', async () => {
    expect(await chainId(rpc)).toBe(ARC_CHAIN_ID);
    const head = await blockNumber(rpc);
    const erc20 = await getLogs(rpc, { address: NETWORKS.mainnet.usdc, topics: [TRANSFER_TOPIC] }, head - 1_999, head, 2_000);
    const sample = erc20.find((log) => uintAt(log.data, 0) > 0n);
    expect(sample).toBeDefined();
    const to = topicAddress(sample!.topics[2]!);
    const payments = await readPayments(rpc, 'mainnet', sample!.blockNumber, sample!.blockNumber, { watched: (address) => address === to });
    const mine = payments.filter((p) => p.tx === sample!.transactionHash);
    // The system emitter logs it once; the interface's own log is not counted a second time.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ currency: 'USDC', to, units: uintAt(sample!.data, 0).toString() });
    console.log(`ERC-20 transfer ${sample!.transactionHash}: ${mine[0]!.units} units to ${to}`);
  }, 120_000);

  it('reads a real native USDC send, which has no ERC-20 log at all', async () => {
    const head = await blockNumber(rpc);
    const system = await getLogs(rpc, { address: SYSTEM_EMITTER, topics: [TRANSFER_TOPIC] }, head - 999, head, 2_000);
    const erc20 = await getLogs(rpc, { address: NETWORKS.mainnet.usdc, topics: [TRANSFER_TOPIC] }, head - 999, head, 2_000);
    const viaInterface = new Set(erc20.map((log) => log.transactionHash));
    // A transfer with no ERC-20 log in its transaction moved native USDC: a plain send or a contract paying out.
    const native = system.find((log) => !viaInterface.has(log.transactionHash) && uintAt(log.data, 0) > 0n && topicAddress(log.topics[1]!) !== '0x0000000000000000000000000000000000000000');
    expect(native).toBeDefined();
    const to = topicAddress(native!.topics[2]!);
    const value = uintAt(native!.data, 0);
    const payments = await readPayments(rpc, 'mainnet', native!.blockNumber, native!.blockNumber, { watched: (address) => address === to });
    const mine = payments.find((p) => p.id === `${native!.transactionHash}:${native!.logIndex}`);
    expect(mine).toMatchObject({ currency: 'USDC', to, units: (value / 10n ** 12n).toString(), dust: (value % 10n ** 12n).toString() });
    expect(mine!.at).toBeGreaterThan(Date.UTC(2025, 0, 1));
    console.log(`native send ${native!.transactionHash}: ${value} native units = ${mine!.units} units + ${mine!.dust} dust, to ${to}`);
  }, 120_000);
});
