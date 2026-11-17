/** 6-decimal units as a decimal with at least two places: `25000000` → `25.00`, `25000123` → `25.000123`. */
export function formatUnits(units: string | bigint): string {
  const value = typeof units === 'bigint' ? units : /^\d+$/.test(units) ? BigInt(units) : 0n;
  const whole = value / 1_000_000n;
  let fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${whole.toLocaleString('en-US')}.${fraction}`;
}

/** A decimal string with thousands separators, keeping every digit it has. */
export function groupDecimal(text: string): string {
  const [whole = '0', fraction] = text.split('.');
  const grouped = /^\d+$/.test(whole) ? BigInt(whole).toLocaleString('en-US') : whole;
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** `0x1234…abcd` */
export function shortAddress(address: string, keep = 4): string {
  return address.length <= keep * 2 + 4 ? address : `${address.slice(0, keep + 2)}…${address.slice(-keep)}`;
}

/** Time left as `29:41`, or `2 h 05 min` past an hour; `0:00` once passed. */
export function timeLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** `just now`, `5 min ago`, `3 h ago`, or a date. */
export function timeAgo(at: number, now: number = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** `in 5 min`, `in 2 h`, or `now`. */
export function timeUntil(at: number, now: number = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 30) return 'now';
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  return `in ${Math.round(seconds / 3600)} h`;
}
