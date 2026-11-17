/**
 * Paying from another chain with the customer's browser wallet (EIP-1193: an extension, or the browser inside a
 * wallet app). The checkout server built the two transactions; this only asks the wallet to send them, in order,
 * after checking it is on the right chain with enough USDC. Kept free of React so it is tested on its own.
 */

import type { CctpPlan } from '@/lib/types';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export type StepKey = 'connect' | 'approve' | 'send' | 'arrive';
export type StepState = 'idle' | 'active' | 'done' | 'skipped' | 'error';

export class WalletFlowError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'WalletFlowError';
  }
}

const BALANCE_OF = '0x70a08231';
const ALLOWANCE = '0xdd62ed3e';
const pad = (address: string): string => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toBig = (value: unknown): bigint => (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : 0n);
const isCancel = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 4001;

/** Waits until the wallet reports the transaction mined; throws if it failed. */
async function confirmed(eth: Eip1193, hash: string, sleep: (ms: number) => Promise<void>, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const receipt = (await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status !== '0x1') throw new WalletFlowError('The approval failed on chain. Nothing was sent; try again.');
      return;
    }
    await sleep(2_000);
  }
  throw new WalletFlowError('The approval is not confirmed yet. Check your wallet, then try again.');
}

/**
 * Connects, switches chain, checks the balance, approves if needed, and sends the transfer. Returns the transfer's
 * hash on the source chain. Reports each step as it goes; the step that failed is marked `error`.
 */
export async function payWithWallet(
  eth: Eip1193,
  plan: CctpPlan,
  onStep: (step: StepKey, state: StepState) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  let current: StepKey = 'connect';
  const step = (key: StepKey, state: StepState): void => {
    if (state === 'active') current = key;
    onStep(key, state);
  };
  try {
    step('connect', 'active');
    const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as unknown;
    const account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
    if (!account) throw new WalletFlowError('The wallet did not share an account.');
    const chain = `0x${plan.source.chainId.toString(16)}`;
    if ((await eth.request({ method: 'eth_chainId' })) !== chain) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain }] });
      } catch (error) {
        if (isCancel(error)) throw error;
        throw new WalletFlowError(`Switch your wallet to ${plan.source.name}, then try again.`);
      }
    }
    const read = async (data: string): Promise<bigint> => toBig(await eth.request({ method: 'eth_call', params: [{ to: plan.source.usdc, data }, 'latest'] }));
    const need = BigInt(plan.amount);
    if ((await read(BALANCE_OF + pad(account))) < need) throw new WalletFlowError(`This wallet has less than ${plan.sendAmount} USDC on ${plan.source.name}.`);
    step('connect', 'done');

    if ((await read(ALLOWANCE + pad(account) + pad(plan.spender))) >= need) {
      step('approve', 'skipped');
    } else {
      step('approve', 'active');
      const approval = (await eth.request({ method: 'eth_sendTransaction', params: [{ from: account, to: plan.approve.to, data: plan.approve.data }] })) as string;
      await confirmed(eth, approval, sleep);
      step('approve', 'done');
    }

    step('send', 'active');
    const hash = (await eth.request({ method: 'eth_sendTransaction', params: [{ from: account, to: plan.burn.to, data: plan.burn.data }] })) as string;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletFlowError('The wallet did not return a transaction.');
    step('send', 'done');
    step('arrive', 'active');
    return hash;
  } catch (error) {
    onStep(current, 'error');
    if (error instanceof WalletFlowError) throw error;
    if (isCancel(error)) throw new WalletFlowError('Cancelled in your wallet.', true);
    throw new WalletFlowError(error instanceof Error && error.message ? error.message : 'The payment was not sent.');
  }
}
