import { ArrowUpRightIcon, CheckIcon, CopyIcon, SpinnerGapIcon, PlusIcon } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { copyText } from '@/lib/data';
import { groupDecimal } from '@/lib/format';
import type { Invoice, MatchMode } from '@/lib/types';
import { ApiError, type Api } from './api';

const EXPIRY = [
  { value: '900', label: '15 minutes' },
  { value: '1800', label: '30 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '24 hours' },
];

const MODE_LABEL: Record<MatchMode, string> = {
  address: 'Own address: any wallet, other chains too',
  amount: 'Tagged amount: one shop address',
};

/** "New invoice": a short form, then the invoice's QR code and link to hand to the customer. */
export function NewInvoiceDialog({ api, modes, onCreated }: { api: Api; modes: readonly MatchMode[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USDC' | 'EURC'>('USDC');
  const [mode, setMode] = useState<MatchMode | ''>('');
  const [description, setDescription] = useState('');
  const [orderId, setOrderId] = useState('');
  const [expiry, setExpiry] = useState('1800');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Invoice | null>(null);
  const [copied, setCopied] = useState(false);
  const chosenMode = mode || (modes.includes('address') ? 'address' : 'amount');

  const reset = (): void => {
    setAmount('');
    setDescription('');
    setOrderId('');
    setError(null);
    setCreated(null);
    setCopied(false);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(amount.trim())) {
      setError('Enter an amount such as 25 or 25.50, with at most six decimals.');
      return;
    }
    setBusy(true);
    try {
      const invoice = await api.create({
        amount: amount.trim(),
        currency,
        ...(modes.length > 1 ? { mode: chosenMode } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(orderId.trim() ? { orderId: orderId.trim() } : {}),
        expiresInSeconds: Number(expiry),
      });
      setCreated(invoice);
      toast.success('Invoice created', { description: `${groupDecimal(invoice.dueAmount)} ${invoice.currency}` });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The checkout did not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button aria-label="New invoice">
          <PlusIcon />
          <span className="hidden sm:inline">New invoice</span>
          <span className="sm:hidden">New</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invoice ready</DialogTitle>
              <DialogDescription>Show the code to the customer, or send them the link.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3">
              <div className="w-full max-w-[220px] rounded-2xl bg-white p-3 ring-1 ring-foreground/10">
                <img src={`/pay/${encodeURIComponent(created.id)}/qr.svg?kind=${created.currency === 'USDC' ? 'native' : 'token'}`} alt="QR code for the customer's wallet" className="aspect-square w-full" />
              </div>
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                {groupDecimal(created.dueAmount)} <span className="text-base text-muted-foreground">{created.currency}</span>
              </p>
              {created.dueAmount !== created.amount && <p className="-mt-2 text-xs text-muted-foreground">The last digits are this invoice's tag.</p>}
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="outline"
                onClick={async () => {
                  setCopied(await copyText(created.checkoutUrl));
                  toast('Link copied');
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                Copy link
              </Button>
              <Button asChild>
                <a href={created.checkoutUrl} target="_blank" rel="noreferrer">
                  Open payment page
                  <ArrowUpRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>New invoice</DialogTitle>
              <DialogDescription>The customer pays straight to your wallet. You get a webhook when it arrives.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="amount">Amount</Label>
                <Input id="amount" inputMode="decimal" autoComplete="off" placeholder="25.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="tabular-nums" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="currency">Currency</Label>
                <Select name="currency" value={currency} onValueChange={(v) => setCurrency(v as 'USDC' | 'EURC')}>
                  <SelectTrigger id="currency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USDC">USDC</SelectItem>
                    <SelectItem value="EURC">EURC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {modes.length > 1 && (
              <div className="grid gap-2">
                <Label htmlFor="mode">How payments are told apart</Label>
                <Select name="mode" value={chosenMode} onValueChange={(v) => setMode(v as MatchMode)}>
                  <SelectTrigger id="mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modes.map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" placeholder="Two flat whites" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="order">Order ID</Label>
                <Input id="order" placeholder="A-1042" maxLength={500} value={orderId} onChange={(e) => setOrderId(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="expiry">Expires after</Label>
                <Select name="expiry" value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger id="expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e.value} value={e.value}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={busy} className="w-full sm:w-auto">
                {busy && <SpinnerGapIcon className="animate-spin" />}
                Create invoice
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
