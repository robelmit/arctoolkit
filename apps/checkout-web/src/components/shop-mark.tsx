import { cn } from 'cn';

/** The shop's initial in a rounded square: a mark without asking the shop for a logo. */
export function ShopMark({ name, className }: { name: string; className?: string }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <div aria-hidden className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-sm', className)}>
      {initial}
    </div>
  );
}
