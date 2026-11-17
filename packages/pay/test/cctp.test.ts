import { describe, expect, it } from 'vitest';
import {
  APPROVE_SELECTOR,
  ARC_CCTP_DOMAIN,
  CCTP,
  CctpError,
  DEPOSIT_FOR_BURN_WITH_HOOK_SELECTOR,
  FORWARD_HOOK,
  cctpFees,
  cctpPlan,
  cctpSource,
  cctpStatus,
  microBps,
} from '../src';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const base = cctpSource('mainnet', 'base')!;

// Circle's answer for Base → Arc with forwarding, recorded from the live API (November 2026).
const FEES_BASE_TO_ARC = [
  { finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { low: 16513, med: 16561, high: 17186 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 16513, med: 16561, high: 17186 } },
];

const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

/** Splits calldata into its selector and 32-byte words. */
const words = (data: string) => ({ selector: data.slice(2, 10), words: data.slice(10).match(/.{64}/g)! });

describe('CCTP fees', () => {
  it('reads basis points with decimals exactly, rounding up past a millionth', () => {
    expect(microBps(0.325)).toBe(325_000n);
    expect(microBps(1.3)).toBe(1_300_000n);
    expect(microBps(0)).toBe(0n);
    expect(microBps('0.0000001')).toBe(1n);
    expect(() => microBps('-1')).toThrow(CctpError);
  });

  it('takes the fast route\'s protocol rate and Circle\'s high forwarding estimate', async () => {
    expect(await cctpFees('mainnet', base, { fetch: answering(200, FEES_BASE_TO_ARC) })).toEqual({ protocolMicroBps: 325_000n, forwardFee: 17_186n });
    expect(await cctpFees('mainnet', base, { fetch: answering(200, FEES_BASE_TO_ARC), speed: 'standard' })).toEqual({ protocolMicroBps: 0n, forwardFee: 17_186n });
  });

  it('refuses a route Circle quotes no forwarding for, or an answer it cannot read', async () => {
    await expect(cctpFees('mainnet', base, { fetch: answering(200, [{ finalityThreshold: 1000, minimumFee: 1 }]) })).rejects.toMatchObject({ code: 'FEES_UNAVAILABLE' });
    await expect(cctpFees('mainnet', base, { fetch: answering(503, {}) })).rejects.toMatchObject({ code: 'FEES_UNAVAILABLE' });
    await expect(cctpFees('mainnet', base, { fetch: answering(200, { error: 'x' }) })).rejects.toMatchObject({ code: 'FEES_UNAVAILABLE' });
  });
});

describe('CCTP payment plan', () => {
  it('approves, then burns the amount plus a fee allowance, to the invoice address on Arc, with the forwarding hook', () => {
    const plan = cctpPlan({ network: 'mainnet', source: base, recipient: RECIPIENT, units: 10_000_000n, fee: { protocolMicroBps: 325_000n, forwardFee: 17_186n } });
    // 0.325 bp of 10.017187… is 326 units after rounding up; with forwarding, 17,512.
    expect(plan).toMatchObject({ receive: '10000000', maxFee: '17512', amount: '10017512', receiveAmount: '10.00', sendAmount: '10.017512', spender: CCTP.mainnet.tokenMessenger, speed: 'fast' });
    const approve = words(plan.approve.data);
    expect(plan.approve.to).toBe(base.usdc);
    expect(approve.selector).toBe(APPROVE_SELECTOR);
    expect(approve.words).toEqual([CCTP.mainnet.tokenMessenger.toLowerCase().slice(2).padStart(64, '0'), BigInt(plan.amount).toString(16).padStart(64, '0')]);
    const burn = words(plan.burn.data);
    expect(plan.burn.to).toBe(CCTP.mainnet.tokenMessenger);
    expect(burn.selector).toBe(DEPOSIT_FOR_BURN_WITH_HOOK_SELECTOR);
    const n = (i: number) => BigInt(`0x${burn.words[i]}`);
    expect(n(0)).toBe(10_017_512n);
    expect(n(1)).toBe(BigInt(ARC_CCTP_DOMAIN));
    expect(burn.words[2]).toBe(RECIPIENT.toLowerCase().slice(2).padStart(64, '0'));
    expect(burn.words[3]).toBe(base.usdc.toLowerCase().slice(2).padStart(64, '0'));
    expect(n(4)).toBe(0n);
    expect(n(5)).toBe(17_512n);
    expect(n(6)).toBe(1000n);
    expect(n(7)).toBe(256n);
    expect(n(8)).toBe(32n);
    expect(`0x${burn.words[9]}`).toBe(FORWARD_HOOK);
    expect(burn.words).toHaveLength(10);
  });

  it('always leaves at least the invoice\'s amount once the most Circle may take is taken', () => {
    for (const units of [1n, 999n, 4_500_000n, 1_234_567_890_123n]) {
      for (const protocolMicroBps of [0n, 250_000n, 1_300_000n, 10_000_000n]) {
        const plan = cctpPlan({ network: 'testnet', source: cctpSource('testnet', 'ethereum')!, recipient: RECIPIENT, units, fee: { protocolMicroBps, forwardFee: 19_899n } });
        const amount = BigInt(plan.amount);
        const maxFee = BigInt(plan.maxFee);
        const protocol = (amount * protocolMicroBps + 9_999_999_999n) / 10_000_000_000n;
        expect(maxFee >= 19_899n + protocol).toBe(true);
        expect(amount - maxFee).toBe(units);
      }
    }
  });

  it('uses the standard finality on request, and refuses a bad recipient or amount', () => {
    const plan = cctpPlan({ network: 'mainnet', source: base, recipient: RECIPIENT, units: 1n, fee: { protocolMicroBps: 0n, forwardFee: 17_186n }, speed: 'standard' });
    expect(BigInt(`0x${words(plan.burn.data).words[6]}`)).toBe(2000n);
    expect(() => cctpPlan({ network: 'mainnet', source: base, recipient: '0x12', units: 1n, fee: { protocolMicroBps: 0n, forwardFee: 1n } })).toThrow(CctpError);
    expect(() => cctpPlan({ network: 'mainnet', source: base, recipient: RECIPIENT, units: 0n, fee: { protocolMicroBps: 0n, forwardFee: 1n } })).toThrow(CctpError);
  });

  it('knows each source by key, on each network', () => {
    expect(cctpSource('mainnet', 'ethereum')).toMatchObject({ domain: 0, chainId: 1 });
    expect(cctpSource('testnet', 'base')).toMatchObject({ domain: 6, chainId: 84532 });
    expect(cctpSource('mainnet', 'arc')).toBeNull();
    expect(new Set(CCTP.mainnet.sources.map((s) => s.domain)).size).toBe(CCTP.mainnet.sources.length);
  });
});

describe('CCTP status', () => {
  const tx = `0x${'ab'.repeat(32)}`;
  const mint = `0x${'cd'.repeat(32)}`;
  it('reads Circle\'s message: not seen, waiting, attested, delivered', async () => {
    expect(await cctpStatus('mainnet', base, tx, { fetch: answering(404, { error: 'Message not found' }) })).toEqual({ state: 'not_found', mintTx: null, delayReason: null });
    expect((await cctpStatus('mainnet', base, tx, { fetch: answering(200, { messages: [{ status: 'pending_confirmations', decodedMessage: { destinationDomain: '26' } }] }) })).state).toBe('pending');
    expect((await cctpStatus('mainnet', base, tx, { fetch: answering(200, { messages: [{ status: 'complete', decodedMessage: { destinationDomain: '26' } }] }) })).state).toBe('attested');
    // The shape Circle answered with for a real transfer: the mint's hash in destinationMintTxHash.
    expect(await cctpStatus('mainnet', base, tx, { fetch: answering(200, { messages: [{ status: 'complete', delayReason: null, destinationMintTxHash: mint, decodedMessage: { destinationDomain: '26' } }] }) })).toEqual({ state: 'delivered', mintTx: mint, delayReason: null });
  });

  it('ignores a message bound elsewhere, and refuses what is not a transaction hash', async () => {
    expect((await cctpStatus('mainnet', base, tx, { fetch: answering(200, { messages: [{ status: 'complete', destinationMintTxHash: mint, decodedMessage: { destinationDomain: '0' } }] }) })).state).toBe('not_found');
    await expect(cctpStatus('mainnet', base, '0x1234')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(cctpStatus('mainnet', base, tx, { fetch: answering(500, {}) })).rejects.toMatchObject({ code: 'STATUS_UNAVAILABLE' });
  });
});
