/**
 * Payment links a wallet opens with the amount and the recipient filled in
 * (ERC-681). USDC can be asked for as Arc's native coin, which every Arc
 * wallet sends, or through its ERC-20 interface; EURC only as an ERC-20.
 */

import { toNative } from './amount';
import { NETWORKS, type Currency, type Network } from './constants';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface PaymentRequest {
  readonly network: Network;
  readonly currency: Currency;
  /** Where the money goes. */
  readonly to: string;
  /** 6-decimal units. */
  readonly units: bigint;
}

export interface PaymentLinks {
  /** USDC as Arc's native coin, the amount in 18-decimal units. Null for EURC, which has no native form. */
  readonly native: string | null;
  /** The currency's ERC-20 `transfer`, the amount in 6-decimal units. */
  readonly token: string;
}

export function paymentLinks(request: PaymentRequest): PaymentLinks {
  if (!ADDRESS.test(request.to)) throw new Error('the recipient is not an address');
  if (typeof request.units !== 'bigint' || request.units <= 0n) throw new Error('the amount must be positive');
  const net = NETWORKS[request.network];
  const token = request.currency === 'USDC' ? net.usdc : net.eurc;
  return {
    native: request.currency === 'USDC' ? `ethereum:${request.to}@${net.chainId}?value=${toNative(request.units)}` : null,
    token: `ethereum:${token}@${net.chainId}/transfer?address=${request.to}&uint256=${request.units}`,
  };
}
