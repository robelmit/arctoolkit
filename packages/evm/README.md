# @arctoolkit/evm

The small EVM client the arctoolkit packages share. It reads a JSON-RPC endpoint and nothing else: no signing, no sending, no dependencies.

```ts
import { ARC_PUBLIC_RPC, blockNumber, createEvmRpc, readErc20 } from '@arctoolkit/evm';

const rpc = createEvmRpc({ url: ARC_PUBLIC_RPC });
const head = await blockNumber(rpc);
const eurc = await readErc20(rpc, '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1');
// { symbol: 'EURC', decimals: 6, ... }
```

## Install

```
npm i @arctoolkit/evm
```

Node 20 or later.

## What is in it

| Part | What it does |
|---|---|
| `createEvmRpc` | A paced client (8 calls a second by default) that retries what was throttled or failed in transit, with a time limit per attempt. A node error such as a revert is reported at once as `EvmRpcError`; an endpoint that stays down is `EvmRpcUnavailable` |
| `getLogs` | Reads event logs over a block range in spans. A span the endpoint refuses is halved and read again, never skipped |
| `readErc20`, `balanceOf`, `allowance` | What a token says about itself. What it does not answer is `null`; decimals are never assumed |
| `encodeCall`, `decodeCall`, `uintAt`, `addressAt`, `decodeString` | 32-byte words in and out of hex, checked |

## Arc and logs

Arc makes a block about every half second. Endpoints limit `eth_getLogs` by the size of the answer, so pick the span per query (`FILTERED_LOG_SPAN` is one Arc's public endpoint serves for a query that names its contracts). For anything that must keep up with the chain, use an endpoint of your own.

## Rules it keeps

- **Unknown is never zero.** A token that does not report its decimals has `decimals: null`.
- **A gap is an error.** A refused log range is split until it is served, or the error reaches you.
- **An endpoint that is down is not "unknown".** `readErc20` returns `null` for a view that reverts, and throws when the endpoint itself fails.
- **Text from a contract is cleaned.** `decodeString` drops control characters.

## Tests

```
pnpm --filter @arctoolkit/evm test
```

15 tests, with no network.

## Licence

MIT
