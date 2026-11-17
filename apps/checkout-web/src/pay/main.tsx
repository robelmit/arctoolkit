import '@/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { pageData } from '@/lib/data';
import type { PayData } from '@/lib/types';
import { PayPage } from './pay-page';

const data = pageData<PayData>();
if (data) document.title = `Pay ${data.shopName}`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      {data ? (
        <PayPage data={data} />
      ) : (
        <main className="grid min-h-svh place-items-center p-6 text-center text-sm text-muted-foreground">This page is served by the checkout server, with an invoice.</main>
      )}
    </TooltipProvider>
  </StrictMode>,
);
