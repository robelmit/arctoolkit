import type { Health, Invoice, PendingWebhook, UnmatchedPayment } from '@/lib/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface NewInvoice {
  amount: string;
  currency: 'USDC' | 'EURC';
  mode?: 'amount' | 'address';
  description?: string;
  orderId?: string;
  expiresInSeconds: number;
}

/** The checkout's merchant API, with the key the merchant entered. Same origin: the key goes to this server only. */
export function createApi(key: string) {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(path, { ...init, cache: 'no-store', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
    if (!response.ok) throw new ApiError(response.status, body.error?.code ?? 'FAILED', body.error?.message ?? `The checkout answered ${response.status}.`);
    return body.data as T;
  };
  return {
    invoices: (limit = 500) => call<Invoice[]>(`/v1/invoices?limit=${limit}`),
    unmatched: () => call<UnmatchedPayment[]>('/v1/unmatched'),
    webhooks: () => call<PendingWebhook[]>('/v1/webhooks'),
    create: (input: NewInvoice) => call<Invoice>('/v1/invoices', { method: 'POST', body: JSON.stringify(input) }),
  };
}

export type Api = ReturnType<typeof createApi>;

export async function health(): Promise<Health | null> {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    return response.ok ? ((await response.json()) as Health) : null;
  } catch {
    return null;
  }
}
