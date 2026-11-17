import { describe, expect, it } from 'vitest';
import { formatUnits, groupDecimal, shortAddress, timeAgo, timeLeft } from '../src/lib/format';
import type { CctpPlan } from '../src/lib/types';
import { payWithWallet, WalletFlowError, type Eip1193, type StepKey, type StepState } from '../src/pay/wallet';

const ACCOUNT = '0x00000000000000000000000000000000000000bb';
const PLAN: CctpPlan = {
  source: { key: 'base', name: 'Base Sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', explorer: 'https://sepolia.basescan.org' },
  amount: '12420011',
  maxFee: '20011',
  receive: '12400000',
  sendAmount: '12.420011',
  receiveAmount: '12.40',
  spender: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  approve: { to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', data: '0x095ea7b3aa' },
  burn: { to: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', data: '0x779b432dbb' },
};
const HASH = `0x${'22'.repeat(32)}`;

/** A wallet that answers like a real one and records what it was asked. */
function wallet(over: { chainId?: string; balance?: bigint; allowance?: bigint; reject?: string; receipt?: string } = {}) {
  const asked: { method: string; params?: unknown[] }[] = [];
  const eth: Eip1193 = {
    async request({ method, params }) {
      asked.push({ method, params });
      if (method === over.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (method === 'eth_requestAccounts') return [ACCOUNT];
      if (method === 'eth_chainId') return over.chainId ?? '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_call') {
        const data = (params![0] as { data: string }).data;
        return `0x${(data.startsWith('0x70a08231') ? (over.balance ?? 100_000_000n) : (over.allowance ?? 0n)).toString(16)}`;
      }
      if (method === 'eth_sendTransaction') return (params![0] as { to: string }).to === PLAN.approve.to ? `0x${'11'.repeat(32)}` : HASH;
      if (method === 'eth_getTransactionReceipt') return { status: over.receipt ?? '0x1' };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { eth, asked };
}

const run = async (eth: Eip1193) => {
  const steps: string[] = [];
  const result = await payWithWallet(eth, PLAN, (step: StepKey, state: StepState) => steps.push(`${step}:${state}`), async () => {}).then(
    (hash) => ({ hash, error: null as WalletFlowError | null }),
    (error: WalletFlowError) => ({ hash: null, error }),
  );
  return { ...result, steps };
};

describe('paying from another chain with the browser wallet', () => {
  it('switches chain, approves, then sends exactly the planned transactions', async () => {
    const { eth, asked } = wallet();
    const { hash, steps } = await run(eth);
    expect(hash).toBe(HASH);
    expect(asked.find((a) => a.method === 'wallet_switchEthereumChain')!.params).toEqual([{ chainId: '0x14a34' }]);
    const sent = asked.filter((a) => a.method === 'eth_sendTransaction').map((a) => a.params![0]);
    expect(sent).toEqual([
      { from: ACCOUNT, to: PLAN.approve.to, data: PLAN.approve.data },
      { from: ACCOUNT, to: PLAN.burn.to, data: PLAN.burn.data },
    ]);
    expect(steps).toEqual(['connect:active', 'connect:done', 'approve:active', 'approve:done', 'send:active', 'send:done', 'arrive:active']);
  });

  it('skips the approval already in place, and the switch when already on the chain', async () => {
    const { eth, asked } = wallet({ chainId: '0x14a34', allowance: 20_000_000n });
    const { steps } = await run(eth);
    expect(asked.some((a) => a.method === 'wallet_switchEthereumChain')).toBe(false);
    expect(asked.filter((a) => a.method === 'eth_sendTransaction')).toHaveLength(1);
    expect(steps).toContain('approve:skipped');
  });

  it('stops before asking for anything when the balance is short, and says how much is needed', async () => {
    const { eth, asked } = wallet({ balance: 12_000_000n });
    const { error, steps } = await run(eth);
    expect(error?.message).toBe('This wallet has less than 12.420011 USDC on Base Sepolia.');
    expect(asked.some((a) => a.method === 'eth_sendTransaction')).toBe(false);
    expect(steps.at(-1)).toBe('connect:error');
  });

  it('says "cancelled" when the customer rejects, and stops at a failed approval', async () => {
    const cancelled = await run(wallet({ reject: 'eth_requestAccounts' }).eth);
    expect(cancelled.error).toMatchObject({ message: 'Cancelled in your wallet.', cancelled: true });
    const rejectedSend = await run(wallet({ reject: 'eth_sendTransaction' }).eth);
    expect(rejectedSend.error?.cancelled).toBe(true);
    expect(rejectedSend.steps.at(-1)).toBe('approve:error');
    const failed = wallet({ receipt: '0x0' });
    const result = await run(failed.eth);
    expect(result.error?.message).toMatch(/approval failed/);
    expect(failed.asked.filter((a) => a.method === 'eth_sendTransaction')).toHaveLength(1);
  });
});

describe('formatting', () => {
  it('shows amounts with every digit and thousands grouped', () => {
    expect(formatUnits('25000000')).toBe('25.00');
    expect(formatUnits('1234567891')).toBe('1,234.567891');
    expect(formatUnits(1n)).toBe('0.000001');
    expect(groupDecimal('12345.504452')).toBe('12,345.504452');
    expect(groupDecimal('4.50')).toBe('4.50');
  });

  it('shows addresses, time left and time since briefly', () => {
    expect(shortAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).toBe('0x7099…79c8');
    expect(timeLeft(29 * 60_000 + 41_000)).toBe('29:41');
    expect(timeLeft(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 05 min');
    expect(timeLeft(-5)).toBe('0:00');
    expect(timeAgo(1_000_000, 1_000_000 + 10_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 min ago');
  });
});
