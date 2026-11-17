import { ArrowUpRightIcon, CircleCheckIcon, CircleXIcon, Loader2Icon, WalletIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUnits, groupDecimal } from '@/lib/format';
import type { CctpPlan, CctpProgress } from '@/lib/types';
import { payWithWallet, WalletFlowError, type Eip1193, type StepKey, type StepState } from './wallet';

const STEPS: readonly StepKey[] = ['connect', 'approve', 'send', 'arrive'];
const idle = (): Record<StepKey, StepState> => ({ connect: 'idle', approve: 'idle', send: 'idle', arrive: 'idle' });

function stepLabel(step: StepKey, chain: string, state: StepState): string {
  if (step === 'connect') return 'Connect your wallet';
  if (step === 'approve') return state === 'skipped' ? 'USDC already approved' : 'Approve USDC';
  if (step === 'send') return `Send on ${chain}`;
  return 'Arrive on Arc';
}

function StepIcon({ state, index }: { state: StepState; index: number }) {
  if (state === 'active') return <Loader2Icon className="size-5 animate-spin text-foreground" />;
  if (state === 'done') return <CircleCheckIcon className="size-5 text-success" />;
  if (state === 'skipped') return <CircleCheckIcon className="size-5 text-muted-foreground" />;
  if (state === 'error') return <CircleXIcon className="size-5 text-destructive" />;
  return <span className="grid size-5 place-items-center rounded-full border text-[0.6875rem] font-medium text-muted-foreground">{index + 1}</span>;
}

/** "USDC on another chain?": pick a chain, see what leaves the wallet, pay, and follow it to Arc. */
export function CrossChain({ invoiceId, sources, open }: { invoiceId: string; sources: readonly { key: string; name: string }[]; open: boolean }) {
  const [source, setSource] = useState(sources[0]?.key ?? '');
  const [plan, setPlan] = useState<CctpPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [steps, setSteps] = useState(idle);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; plan: CctpPlan } | null>(null);
  const [progress, setProgress] = useState<CctpProgress | null>(null);
  const busy = running || sent !== null;
  const chainName = sources.find((s) => s.key === source)?.name ?? '';

  // The fee changes with gas prices: ask again whenever the chain changes, and every 30 seconds.
  useEffect(() => {
    if (busy || !open) return;
    let stopped = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/pay/${encodeURIComponent(invoiceId)}/cctp?from=${encodeURIComponent(source)}`, { cache: 'no-store' });
        const body = (await response.json()) as CctpPlan & { error?: { message?: string } };
        if (stopped) return;
        if (!response.ok) {
          setPlan(null);
          setPlanError(body.error?.message ?? 'Circle did not quote this route right now.');
        } else {
          setPlan(body);
          setPlanError(null);
        }
      } catch {
        if (!stopped) setPlanError('Could not reach the checkout. Check your connection.');
      }
    };
    setPlan(null);
    setPlanError(null);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [invoiceId, source, busy, open]);

  // Once sent, follow the transfer at Circle until the invoice is paid.
  const following = useRef(false);
  useEffect(() => {
    if (!sent || !open || following.current) return;
    following.current = true;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`/pay/${encodeURIComponent(invoiceId)}/cctp/status?from=${encodeURIComponent(sent.plan.source.key)}&tx=${encodeURIComponent(sent.hash)}`, { cache: 'no-store' });
        if (response.ok && !stopped) setProgress((await response.json()) as CctpProgress);
      } catch {
        // Ask again.
      }
      if (!stopped) setTimeout(() => void tick(), 4_000);
    };
    void tick();
    return () => {
      stopped = true;
      following.current = false;
    };
  }, [sent, invoiceId, open]);

  const pay = async (): Promise<void> => {
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    setError(null);
    if (!eth) {
      setError('No browser wallet found. Open this page in your wallet app, or pay on Arc.');
      return;
    }
    if (!plan) return;
    setSteps(idle());
    setRunning(true);
    try {
      const hash = await payWithWallet(eth, plan, (step, state) => setSteps((s) => ({ ...s, [step]: state })));
      setSent({ hash, plan });
    } catch (e) {
      setError(e instanceof WalletFlowError ? e.message : 'The payment was not sent.');
    } finally {
      setRunning(false);
    }
  };

  const arriveNote =
    progress?.state === 'delivered'
      ? 'Arrived on Arc. Confirming…'
      : progress?.state === 'attested'
        ? 'Confirmed. Circle is minting it on Arc…'
        : sent
          ? `Waiting for ${sent.plan.source.name} to confirm…`
          : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Pay with USDC you hold on another chain. Circle's CCTP brings it to Arc; its fee is added to what you send, so the shop receives the full amount.</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cross-from" className="text-xs text-muted-foreground">
          Pay from
        </Label>
        <Select name="from" value={source} onValueChange={setSource} disabled={busy}>
          <SelectTrigger id="cross-from" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        {plan ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">You send</dt>
            <dd className="text-right font-medium tabular-nums">{groupDecimal(plan.sendAmount)} USDC</dd>
            <dt className="text-muted-foreground">Circle's fee, at most</dt>
            <dd className="text-right tabular-nums text-muted-foreground">{formatUnits(plan.maxFee)} USDC</dd>
            <dt className="text-muted-foreground">Shop receives on Arc</dt>
            <dd className="text-right font-medium tabular-nums">{groupDecimal(plan.receiveAmount)} USDC</dd>
          </dl>
        ) : planError ? (
          <p className="text-muted-foreground">{planError}</p>
        ) : (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-full" />
          </div>
        )}
      </div>

      {(running || sent || STEPS.some((s) => steps[s] === 'error')) && (
        <ol className="flex flex-col gap-2.5" aria-label="Progress">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-3 text-sm">
              <StepIcon state={steps[step]} index={index} />
              <div className="flex flex-col gap-0.5">
                <span className={steps[step] === 'idle' ? 'text-muted-foreground' : ''}>{stepLabel(step, plan?.source.name ?? chainName, steps[step])}</span>
                {step === 'arrive' && arriveNote && <span className="text-xs text-muted-foreground">{arriveNote}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {error && (
        <Alert variant="destructive">
          <CircleXIcon />
          <AlertTitle>Not sent</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {sent ? (
        <Button variant="outline" asChild className="w-full">
          <a href={`${sent.plan.source.explorer}/tx/${sent.hash}`} target="_blank" rel="noreferrer">
            View the transfer on {sent.plan.source.name}
            <ArrowUpRightIcon data-icon="inline-end" />
          </a>
        </Button>
      ) : (
        <Button size="lg" className="h-11 w-full text-base" disabled={!plan || running} onClick={() => void pay()}>
          {running ? <Loader2Icon className="animate-spin" /> : <WalletIcon />}
          {running ? 'Continue in your wallet' : plan ? `Pay ${groupDecimal(plan.sendAmount)} USDC` : 'Pay with wallet'}
        </Button>
      )}
    </div>
  );
}
