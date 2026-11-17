import { useEffect, useState } from 'react';
import type { PublicStatus } from '@/lib/types';

/** The current time, ticking every `ms`. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The invoice's public status, asked for every two seconds while it is open. */
export function useInvoiceStatus(initial: PublicStatus): PublicStatus {
  const [status, setStatus] = useState(initial);
  useEffect(() => {
    if (status.status !== 'open') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`/pay/${encodeURIComponent(initial.id)}/status`, { cache: 'no-store' });
        if (response.ok && !stopped) {
          const next = (await response.json()) as PublicStatus;
          setStatus(next);
          if (next.status !== 'open') return;
        }
      } catch {
        // Offline for a moment: ask again.
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2_000);
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [initial.id, status.status]);
  return status;
}
