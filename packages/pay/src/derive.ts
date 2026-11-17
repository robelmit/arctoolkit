/**
 * Per-invoice receiving addresses from a merchant's extended public key.
 *
 * The merchant gives an xpub; each invoice gets the next child address. Only
 * public keys are involved: the gateway can derive the addresses and watch
 * them, and cannot move a cent. The merchant's own wallet holds the keys.
 *
 * For an xpub of `m/44'/60'/0'/0` (the account path most wallets use), child
 * `i` is the wallet's account `i`. On Arc the gas coin is USDC, so money
 * received at a child address can be moved on from it without first sending
 * it gas from somewhere else.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { HDKey } from '@scure/bip32';

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** EIP-55 mixed-case form of an address. */
export function checksumAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not an address');
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  return out;
}

/** The address of a secp256k1 public key (compressed or not), in lower case. */
export function addressOfPublicKey(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return `0x${toHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

export class AddressDeriver {
  private readonly node: HDKey;

  /** Throws on anything that is not an extended public key; a private key is refused outright. */
  constructor(xpub: string) {
    if (typeof xpub !== 'string' || !/^[a-zA-Z]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(xpub.trim())) {
      throw new Error(/^[a-zA-Z]prv/.test(String(xpub)) ? 'that is an extended PRIVATE key; give the public one (xpub). The gateway never needs a private key' : 'not an extended public key (xpub…)');
    }
    const node = HDKey.fromExtendedKey(xpub.trim());
    if (node.privateKey) throw new Error('that key holds a private part; give the public one (xpub)');
    if (!node.publicKey) throw new Error('the extended key has no public key');
    this.node = node;
  }

  /** The address of child `index` (0 to 2^31-1), in lower case. */
  address(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('a child index is a whole number from 0 to 2^31 - 1');
    const child = this.node.deriveChild(index);
    if (!child.publicKey) throw new Error('the derivation gave no public key');
    return addressOfPublicKey(child.publicKey);
  }
}
