/**
 * Arc's payment facts, each read from Arc's documentation and checked on the
 * chain itself.
 *
 * Arc uses USDC as its gas coin. One balance has two faces: the native coin
 * (18 decimals, used for gas and plain sends) and an ERC-20 interface at
 * `0x3600…0000` (6 decimals). Every USDC movement, a plain send or an ERC-20
 * transfer, a mint or a burn, is logged as a `Transfer` with 18 decimals by a
 * system emitter at `0xffff…fffe`. The ERC-20 interface also logs its own
 * 6-decimal `Transfer`, but only for ERC-20 calls. Watching the system
 * emitter therefore sees every USDC payment exactly once, however it was sent.
 */

export type Network = 'mainnet' | 'testnet';
export type Currency = 'USDC' | 'EURC';

export interface NetworkInfo {
  readonly chainId: number;
  readonly rpc: string;
  readonly explorer: string;
  /** USDC's ERC-20 interface (6 decimals). */
  readonly usdc: string;
  readonly eurc: string;
}

export const NETWORKS: Readonly<Record<Network, NetworkInfo>> = Object.freeze({
  mainnet: Object.freeze({
    chainId: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    eurc: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
  }),
  testnet: Object.freeze({
    chainId: 5_042_002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    eurc: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
  }),
});

/** Logs every USDC movement, with 18 decimals. */
export const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';

/** `Transfer(address indexed from, address indexed to, uint256 value)` */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Invoices are kept in the currencies' ERC-20 units: 6 decimals for both. */
export const UNIT_DECIMALS = 6;
/** The native USDC coin's decimals. */
export const NATIVE_DECIMALS = 18;
/** Native units per 6-decimal unit. */
export const NATIVE_PER_UNIT = 10n ** 12n;
