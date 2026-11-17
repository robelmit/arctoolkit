/**
 * Money as integers. An invoice amount is a whole number of 6-decimal units
 * (`25.000123` USDC is `25000123n`); a decimal string is parsed exactly, never
 * through a float.
 */

import { NATIVE_PER_UNIT, UNIT_DECIMALS } from './constants';

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/** `'25'`, `'25.5'` or `'25.000123'` as 6-decimal units. More than six decimals, a sign or junk is refused. */
export function parseAmount(text: string): bigint {
  if (typeof text !== 'string') throw new AmountError('an amount is a decimal string');
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) throw new AmountError(`"${text}" is not an amount with at most six decimals`);
  return BigInt(match[1]!) * 10n ** BigInt(UNIT_DECIMALS) + BigInt((match[2] ?? '').padEnd(UNIT_DECIMALS, '0'));
}

/** 6-decimal units as a decimal string with at least two decimals: `25000123n` → `'25.000123'`, `25000000n` → `'25.00'`. */
export function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10n ** BigInt(UNIT_DECIMALS);
  let fraction = (abs % 10n ** BigInt(UNIT_DECIMALS)).toString().padStart(UNIT_DECIMALS, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** A native (18-decimal) value split into 6-decimal units and the sub-unit remainder the ERC-20 view does not show. */
export function fromNative(value: bigint): { units: bigint; dust: bigint } {
  return { units: value / NATIVE_PER_UNIT, dust: value % NATIVE_PER_UNIT };
}

export const toNative = (units: bigint): bigint => units * NATIVE_PER_UNIT;
