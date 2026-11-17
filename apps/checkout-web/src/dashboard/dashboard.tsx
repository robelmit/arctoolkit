import { ArrowUpRightIcon, CircleAlertIcon, CopyIcon, InboxIcon, KeyRoundIcon, Loader2Icon, LogOutIcon, ReceiptIcon, SendIcon, WalletCardsIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ShopMark } from '@/components/shop-mark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyText, session } from '@/lib/data';
import { formatUnits, groupDecimal, shortAddress, timeAgo, timeUntil } from '@/lib/format';
import type { DashboardData, Health, Invoice, InvoiceStatus, PendingWebhook, UnmatchedPayment, UnmatchedReason } from '@/lib/types';
import { ApiError, createApi, health, type Api } from './api';
import { NewInvoiceDialog } from './new-invoice';

const KEY = 'arctoolkit.apiKey';

const REASON: Record<UnmatchedReason, string> = {
  no_invoice_with_this_amount: 'No open invoice asks for this amount',
  invoice_already_paid: 'Its invoice was already paid',
  amount_matches_several_invoices: 'Two invoices ask for this amount',
};

function StatusBadge({ status, late }: { status: InvoiceStatus; late?: boolean }) {
  if (status === 'paid')
    return (
      <Badge className="bg-success/12 text-success">
        <span className="size-1.5 rounded-full bg-success" />
        {late ? 'Paid late' : 'Paid'}
      </Badge>
    );
  if (status === 'expired') return <Badge variant="secondary">Expired</Badge>;
  return (
    <Badge variant="outline" className="border-warning/40 text-warning">
      <span className="size-1.5 rounded-full bg-warning" />
      Open
    </Badge>
  );
}

function SignIn({ data, onKey }: { data: DashboardData; onKey: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createApi(key.trim()).invoices(1);
      onKey(key.trim());
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'That key was refused.' : 'The checkout did not answer.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="grid min-h-svh place-items-center bg-muted/50 p-4 dark:bg-background">
      <Card className="w-full max-w-sm shadow-sm [--card-spacing:--spacing(6)]">
        <CardHeader className="justify-items-center text-center">
          <div className="mb-2 grid size-12 place-items-center rounded-full bg-muted">
            <KeyRoundIcon className="size-5" />
          </div>
          <CardTitle className="text-lg font-semibold">{data.shopName}</CardTitle>
          <CardDescription>Enter the checkout's API key. It stays in this tab and goes only to this server.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="key">API key</Label>
              <Input id="key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} autoFocus aria-invalid={error !== null} />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <Button type="submit" disabled={busy || key.trim().length === 0} className="w-full">
              {busy && <Loader2Icon className="animate-spin" />}
              Open dashboard
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value, note, icon, tone }: { label: string; value: ReactNode; note?: ReactNode; icon: ReactNode; tone?: 'warning' }) {
  return (
    <Card size="sm" className="[--card-spacing:--spacing(4)]">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className={`text-2xl font-semibold tracking-tight tabular-nums ${tone === 'warning' ? 'text-warning' : ''}`}>{value}</span>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
        <div className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</div>
      </CardContent>
    </Card>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

function sumPaid(invoices: readonly Invoice[], currency: 'USDC' | 'EURC'): bigint {
  return invoices.filter((i) => i.status === 'paid' && i.currency === currency).reduce((sum, i) => sum + BigInt(i.received), 0n);
}

function Board({ data, api, onSignOut }: { data: DashboardData; api: Api; onSignOut: () => void }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedPayment[]>([]);
  const [webhooks, setWebhooks] = useState<PendingWebhook[]>([]);
  const [chain, setChain] = useState<Health | null>(null);
  const [filter, setFilter] = useState<'all' | InvoiceStatus>('all');
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [list, review, hooks, h] = await Promise.all([api.invoices(), api.unmatched(), api.webhooks(), health()]);
      setInvoices(list);
      setUnmatched(review);
      setWebhooks(hooks);
      setChain(h);
      setNow(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast.error('The API key was refused. Sign in again.');
        onSignOut();
      }
    }
  }, [api, onSignOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const shown = useMemo(() => (invoices ?? []).filter((i) => filter === 'all' || i.status === filter), [invoices, filter]);
  const open = (invoices ?? []).filter((i) => i.status === 'open').length;
  const paid = (invoices ?? []).filter((i) => i.status === 'paid');
  const paidUsdc = sumPaid(invoices ?? [], 'USDC');
  const paidEurc = sumPaid(invoices ?? [], 'EURC');
  const testnet = data.network === 'testnet';

  return (
    <div className="min-h-svh bg-muted/50 dark:bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <ShopMark name={data.shopName} className="size-9 rounded-lg text-sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{data.shopName}</span>
              <Badge variant="outline" className={testnet ? 'border-warning/40 text-warning' : ''}>
                <span className="hidden sm:inline">Arc</span> {data.network}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
              <span className={`size-1.5 shrink-0 rounded-full ${chain?.cursor ? 'bg-success' : 'bg-muted-foreground'}`} />
              {chain?.cursor ? (
                <span>
                  <span className="hidden sm:inline">Following the chain · </span>block {chain.cursor.toLocaleString('en-US')}
                </span>
              ) : (
                'Connecting to the chain…'
              )}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <NewInvoiceDialog api={api} modes={chain?.modes ?? ['amount']} onCreated={() => void refresh()} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Sign out" onClick={onSignOut}>
                  <LogOutIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Open invoices" value={invoices ? open : <Skeleton className="h-8 w-10" />} icon={<ReceiptIcon />} />
          <Stat
            label="Received"
            value={invoices ? `${formatUnits(paidUsdc)}` : <Skeleton className="h-8 w-20" />}
            note={invoices ? `USDC from ${paid.length} paid${paidEurc > 0n ? ` · ${formatUnits(paidEurc)} EURC` : ''}` : undefined}
            icon={<WalletCardsIcon />}
          />
          <Stat label="Needs review" value={unmatched.length} note="Payments no invoice claims" icon={<CircleAlertIcon />} tone={unmatched.length > 0 ? 'warning' : undefined} />
          <Stat label="Webhooks waiting" value={webhooks.length} note={webhooks.length > 0 ? 'Retrying on a schedule' : 'All delivered'} icon={<SendIcon />} />
        </div>

        <Tabs defaultValue="invoices">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="review">
                Needs review
                {unmatched.length > 0 && <Badge className="h-4 min-w-4 bg-warning px-1 text-[0.625rem] text-white">{unmatched.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="invoices">
            <Card className="gap-0 py-0">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <span className="text-sm font-medium">{invoices ? `${shown.length} invoice${shown.length === 1 ? '' : 's'}` : 'Invoices'}</span>
                <Select name="status" value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
                  <SelectTrigger size="sm" className="w-32" aria-label="Show">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {!invoices ? (
                <div className="flex flex-col gap-3 p-4">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : shown.length === 0 ? (
                <Empty icon={<ReceiptIcon />} title={filter === 'all' ? 'No invoices yet' : `No ${filter} invoices`}>
                  {filter === 'all' ? 'Create one with "New invoice", or from your shop through the API.' : undefined}
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Invoice</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Received</TableHead>
                      <TableHead className="hidden sm:table-cell">Status</TableHead>
                      <TableHead className="hidden md:table-cell">Matching</TableHead>
                      <TableHead className="hidden sm:table-cell">Created</TableHead>
                      <TableHead className="pr-4 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell className="max-w-36 pl-4 sm:max-w-56">
                          <div className="truncate font-medium">{invoice.orderId ?? invoice.description ?? 'Payment'}</div>
                          {invoice.orderId && invoice.description ? (
                            <div className="truncate text-xs text-muted-foreground">{invoice.description}</div>
                          ) : (
                            <div className="truncate font-mono text-xs text-muted-foreground">{invoice.id}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {groupDecimal(invoice.dueAmount)} <span className="text-muted-foreground">{invoice.currency}</span>
                          <div className="mt-1 flex justify-end sm:hidden">
                            <StatusBadge status={invoice.status} late={invoice.late} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">{invoice.received === '0' ? '—' : formatUnits(invoice.received)}</TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <StatusBadge status={invoice.status} late={invoice.late} />
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">{invoice.mode === 'address' ? 'Own address' : 'Tagged amount'}</TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">{timeAgo(invoice.createdAt, now)}</TableCell>
                        <TableCell className="pr-4 text-right">
                          <div className="flex justify-end gap-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label="Copy payment link" onClick={async () => (await copyText(invoice.checkoutUrl)) && toast('Link copied')}>
                                  <CopyIcon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Copy payment link</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon-sm" asChild>
                                  <a href={invoice.checkoutUrl} target="_blank" rel="noreferrer" aria-label="Open payment page">
                                    <ArrowUpRightIcon />
                                  </a>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open payment page</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="review">
            <Card className="gap-0 py-0">
              {unmatched.length === 0 ? (
                <Empty icon={<InboxIcon />} title="Nothing to review">
                  A payment the checkout cannot place for certain (a rounded amount, a second payment, an amount two invoices could claim) shows up here instead of being credited by guess.
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">When</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Why</TableHead>
                      <TableHead className="hidden md:table-cell">From</TableHead>
                      <TableHead>Look at</TableHead>
                      <TableHead className="pr-4 text-right">
                        <span className="sr-only">Transaction</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unmatched.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell className="pl-4 text-muted-foreground">{timeAgo(payment.at, now)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatUnits(payment.units)} <span className="text-muted-foreground">{payment.currency}</span>
                        </TableCell>
                        <TableCell className="max-w-64 whitespace-normal">{REASON[payment.reason] ?? payment.reason}</TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{shortAddress(payment.from)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {payment.hints.length === 0
                            ? '—'
                            : payment.hints.map((id) => (
                                <a key={id} href={`/pay/${id}`} target="_blank" rel="noreferrer" className="block underline-offset-4 hover:underline">
                                  {shortAddress(id, 6)}
                                </a>
                              ))}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <a href={`${data.explorer}/tx/${payment.tx}`} target="_blank" rel="noreferrer">
                              Explorer
                              <ArrowUpRightIcon data-icon="inline-end" />
                            </a>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="webhooks">
            <Card className="gap-0 py-0">
              {webhooks.length === 0 ? (
                <Empty icon={<SendIcon />} title="Every webhook delivered">
                  A delivery that fails is retried after 5 s, 30 s, 2 min, 10 min, 1 h and 6 h. Any still waiting are listed here with the last error.
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Event</TableHead>
                      <TableHead className="text-right">Tries</TableHead>
                      <TableHead>Next try</TableHead>
                      <TableHead className="pr-4">Last error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {webhooks.map((hook) => (
                      <TableRow key={hook.eventId}>
                        <TableCell className="pl-4 font-mono text-xs">{hook.eventId}</TableCell>
                        <TableCell className="text-right tabular-nums">{hook.attempts}</TableCell>
                        <TableCell className="text-muted-foreground">{timeUntil(hook.nextAt, now)}</TableCell>
                        <TableCell className="pr-4 text-destructive">{hook.lastError ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

export function Dashboard({ data }: { data: DashboardData }) {
  const [key, setKey] = useState<string | null>(() => session.get(KEY));
  const api = useMemo(() => (key ? createApi(key) : null), [key]);
  const signOut = useCallback(() => {
    session.set(KEY, null);
    setKey(null);
  }, []);
  if (!api)
    return (
      <SignIn
        data={data}
        onKey={(k) => {
          session.set(KEY, k);
          setKey(k);
        }}
      />
    );
  return <Board data={data} api={api} onSignOut={signOut} />;
}
