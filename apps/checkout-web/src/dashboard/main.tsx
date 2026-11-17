import '@/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { pageData } from '@/lib/data';
import type { DashboardData } from '@/lib/types';
import { Dashboard } from './dashboard';

const data = pageData<DashboardData>() ?? { shopName: 'Checkout', network: 'mainnet', explorer: 'https://explorer.arc.io' };
document.title = `${data.shopName} · Dashboard`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <Dashboard data={data} />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  </StrictMode>,
);
