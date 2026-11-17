import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyText } from '@/lib/data';

/** A labelled value with a copy button that confirms with a check. */
export function CopyField({ label, value, display, mono = true }: { label: string; value: string; display?: ReactNode; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-2 pr-1.5 pl-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={mono ? 'font-mono text-[0.8125rem] leading-snug break-all' : 'text-sm font-medium'}>{display ?? value}</div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Copy ${label.toLowerCase()}`} onClick={async () => setCopied(await copyText(value))}>
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
      </Tooltip>
    </div>
  );
}
