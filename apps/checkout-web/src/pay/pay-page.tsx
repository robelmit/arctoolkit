import { ArrowLeftRightIcon, ArrowUpRightIcon, CircleCheckIcon, ClockIcon, InfoIcon, ShieldCheckIcon, TimerOffIcon, WalletIcon, ZapIcon } from 'lucide-react';
import { CopyField } from '@/components/copy-field';
import { ShopMark } from '@/components/shop-mark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { groupDecimal, timeLeft } from '@/lib/format';
import type { PayData, PublicStatus } from '@/lib/types';
import { CrossChain } from './cross-chain';
import { useInvoiceStatus, useNow } from './hooks';

const toUnits = (decimal: string): number => Number(decimal.replace(/,/g, '')) || 0;

function Amount({ status }: { status: PublicStatus }) {
  // Every digit in full colour: in tagged-amount mode the last ones are what identify the payment.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Amount due</span>
      <p className="flex flex-wrap items-baseline gap-x-2 font-semibold tracking-tight tabular-nums">
        <span className="text-4xl break-all">{groupDecimal(status.dueAmount)}</span>
        <span className="text-lg text-muted-foreground">{status.currency}</span>
      </p>
    </div>
  );
}

function Waiting({ status }: { status: PublicStatus }) {
  const now = useNow();
  const left = status.expiresAt - now;
  const received = toUnits(status.received);
  const due = toUnits(status.dueAmount);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
          </span>
          {received > 0 ? 'Partly paid' : 'Waiting for payment'}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
          <ClockIcon className="size-3.5" />
          {left > 0 ? `Expires in ${timeLeft(left)}` : 'Expiring…'}
        </span>
      </div>
      {received > 0 && (
        <div className="flex flex-col gap-1.5">
          <Progress value={Math.min(100, (received / due) * 100)} aria-label="Received so far" />
          <span className="text-xs text-muted-foreground tabular-nums">
            {groupDecimal(status.received)} of {groupDecimal(status.dueAmount)} {status.currency} received. Send the rest to the same address.
          </span>
        </div>
      )}
    </div>
  );
}

function PayOnArc({ data, status }: { data: PayData; status: PublicStatus }) {
  const walletLink = data.links.native ?? data.links.token;
  const qrKind = data.links.native ? 'native' : 'token';
  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto w-full max-w-[232px] rounded-2xl bg-white p-3 shadow-xs ring-1 ring-foreground/10">
        <img src={`/pay/${encodeURIComponent(status.id)}/qr.svg?kind=${qrKind}`} alt={`QR code to pay ${status.dueAmount} ${status.currency} on Arc`} className="aspect-square w-full" width={208} height={208} />
      </div>
      <Button size="lg" asChild className="h-11 w-full text-base">
        <a href={walletLink}>
          <WalletIcon />
          Open in wallet
        </a>
      </Button>
      <div className="flex flex-col gap-2">
        <CopyField label="Send to" value={status.address} />
        <CopyField label="Amount" value={status.dueAmount} display={`${groupDecimal(status.dueAmount)} ${status.currency}`} />
      </div>
      <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        {data.invoice.mode === 'amount'
          ? 'Send exactly this amount, on Arc. Its last digits tell the shop the payment is yours.'
          : 'This address is for this payment only. Send on Arc.'}
      </p>
    </div>
  );
}

function Paid({ data, status }: { data: PayData; status: PublicStatus }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center duration-500 animate-in fade-in zoom-in-95">
      <div className="grid size-16 place-items-center rounded-full bg-success/12 text-success ring-8 ring-success/5">
        <CircleCheckIcon className="size-9" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Payment received</h2>
        <p className="text-sm text-muted-foreground">
          {groupDecimal(status.received)} {status.currency} paid to {data.shopName}.{status.late ? ' It arrived after the invoice expired; the shop will see it.' : ' Thank you.'}
        </p>
      </div>
      {status.lastTx && (
        <Button variant="outline" asChild>
          <a href={`${data.explorer}/tx/${status.lastTx}`} target="_blank" rel="noreferrer">
            View on Arc explorer
            <ArrowUpRightIcon data-icon="inline-end" />
          </a>
        </Button>
      )}
    </div>
  );
}

function Expired({ data, status }: { data: PayData; status: PublicStatus }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
        <TimerOffIcon className="size-8" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">This invoice expired</h2>
        <p className="text-sm text-muted-foreground">
          Ask {data.shopName} for a new one before paying.
          {toUnits(status.received) > 0 && ` ${groupDecimal(status.received)} ${status.currency} was received toward it; the shop can see it.`}
        </p>
      </div>
    </div>
  );
}

export function PayPage({ data }: { data: PayData }) {
  const status = useInvoiceStatus(data.invoice);
  const testnet = data.network === 'testnet';
  const subtitle = [data.invoice.description, data.invoice.orderId].filter(Boolean).join(' · ') || 'Payment';
  const crossChain = data.crossChain && data.crossChain.length > 0 ? data.crossChain : null;

  return (
    <div className="relative min-h-svh bg-muted/50 dark:bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-linear-to-b from-foreground/[0.035] to-transparent" />
      <main className="relative mx-auto flex min-h-svh w-full max-w-md flex-col justify-start gap-4 px-4 py-4 sm:justify-center sm:py-10">
        <Card className="shadow-sm [--card-spacing:--spacing(5)]">
          <CardHeader>
            <div className="flex min-w-0 items-center gap-3">
              <ShopMark name={data.shopName} />
              <div className="min-w-0">
                <CardTitle className="truncate text-base font-semibold">{data.shopName}</CardTitle>
                <CardDescription className="line-clamp-2">{subtitle}</CardDescription>
              </div>
            </div>
            {testnet && (
              <CardAction>
                <Badge variant="outline" className="border-warning/40 text-warning">
                  Testnet
                </Badge>
              </CardAction>
            )}
          </CardHeader>

          <CardContent className="flex flex-col gap-5">
            {status.status === 'paid' ? (
              <Paid data={data} status={status} />
            ) : status.status === 'expired' ? (
              <Expired data={data} status={status} />
            ) : (
              <>
                <Amount status={status} />
                <Waiting status={status} />
                {crossChain ? (
                  <Tabs defaultValue="arc">
                    <TabsList className="w-full">
                      <TabsTrigger value="arc">
                        <ZapIcon />
                        On Arc
                      </TabsTrigger>
                      <TabsTrigger value="other">
                        <ArrowLeftRightIcon />
                        From another chain
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="arc" className="pt-2">
                      <PayOnArc data={data} status={status} />
                    </TabsContent>
                    <TabsContent value="other" className="pt-2">
                      <CrossChain invoiceId={status.id} sources={crossChain} open={status.status === 'open'} />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <PayOnArc data={data} status={status} />
                )}
              </>
            )}
          </CardContent>

          <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ShieldCheckIcon className="size-3.5" />
              Paid straight to the shop
            </span>
            <span>
              {status.currency} on Arc {testnet ? 'testnet' : ''}
            </span>
          </CardFooter>
        </Card>
        <p className="text-center text-xs text-muted-foreground">Open-source checkout · arctoolkit</p>
      </main>
    </div>
  );
}
