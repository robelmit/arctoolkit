/**
 * Live checks against Arc mainnet. They run only with LIVE=1, and only read.
 *
 *   LIVE=1 pnpm --filter @arctoolkit/pay test
 *   ARC_RPC_URL=<your endpoint> picks the endpoint (default: the public one)
 */

import { ARC_CHAIN_ID, ARC_PUBLIC_RPC, blockNumber, chainId, createEvmRpc, getLogs, topicAddress, uintAt } from '@arctoolkit/evm';
import { describe, expect, it } from 'vitest';
import { CCTP, NETWORKS, SYSTEM_EMITTER, TRANSFER_TOPIC, cctpFees, cctpPlan, cctpSource, readPayments } from '../src';

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

  it('reads a real CCTP mint: the system emitter logs it as a transfer from the zero address', async () => {
    const head = await blockNumber(rpc);
    const messenger = CCTP.mainnet.tokenMessenger.toLowerCase();
    for (let to = head; to > head - 40_000; to -= 2_000) {
      const logs = await getLogs(rpc, { address: messenger }, to - 1_999, to, 2_000);
      for (const log of logs) {
        const receipt = await rpc.call<{ logs: { address: string; topics: string[]; data: string; logIndex: string }[] }>('eth_getTransactionReceipt', [log.transactionHash]);
        const mint = receipt.logs.find((l) => l.address.toLowerCase() === SYSTEM_EMITTER && l.topics[0] === TRANSFER_TOPIC && topicAddress(l.topics[1]!) === '0x0000000000000000000000000000000000000000');
        if (!mint) continue;
        const recipient = topicAddress(mint.topics[2]!);
        const payments = await readPayments(rpc, 'mainnet', log.blockNumber, log.blockNumber, { watched: (address) => address === recipient });
        expect(payments.find((p) => p.tx === log.transactionHash)).toMatchObject({ currency: 'USDC', from: '0x0000000000000000000000000000000000000000', to: recipient });
        console.log(`CCTP mint ${log.transactionHash}: seen as a payment to ${recipient}`);
        return;
      }
    }
    throw new Error('no CCTP mint in the last 40,000 blocks');
  }, 180_000);
});

// Public endpoints of each source chain, for dry runs only (eth_call: nothing is sent).
const SOURCE_RPC: Record<string, string> = {
  base: 'https://mainnet.base.org',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
};

describe.runIf(live)('paying from another chain with CCTP, live', () => {
  it.each(CCTP.mainnet.sources.map((s) => s.key))('%s: Circle quotes forwarding to Arc, the USDC address is USDC, and the burn call is accepted up to the allowance', async (key) => {
    const source = cctpSource('mainnet', key)!;
    const fee = await cctpFees('mainnet', source);
    expect(fee.forwardFee).toBeGreaterThan(0n);
    const plan = cctpPlan({ network: 'mainnet', source, recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', units: 1_000_000n, fee });
    const chain = createEvmRpc({ url: SOURCE_RPC[key]! });
    expect(await chainId(chain)).toBe(source.chainId);
    const symbol = await chain.call<string>('eth_call', [{ to: source.usdc, data: '0x95d89b41' }, 'latest']);
    expect(Buffer.from(symbol.slice(130), 'hex').toString('utf8').replace(/\0+$/, '')).toBe('USDC');
    // From an address with no allowance, the burn must get as far as taking the USDC and stop there.
    const error = await chain.call('eth_call', [{ from: '0x00000000000000000000000000000000000000bb', to: plan.burn.to, data: plan.burn.data }, 'latest']).then(() => null, (e: unknown) => String(e));
    expect(error).toMatch(/allowance|exceeds/i);
    console.log(`${source.name}: forward fee ${fee.forwardFee} units, send ${plan.sendAmount} USDC to receive ${plan.receiveAmount}; dry run stopped at: ${error!.slice(0, 120)}`);
  }, 60_000);
});
