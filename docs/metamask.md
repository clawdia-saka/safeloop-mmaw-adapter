# MetaMask Integration

This repository includes two MetaMask connection points:

- `createMetaMaskAgenticSdkSigner` for direct `@metamask/agentic-sdk` style integrations.
- `createMmCliSigner` for the MetaMask Agentic CLI `mm`.

Both adapters plug into the same Safeloop gate:

```ts
await failClosedSign({
  intent,
  ledger,
  simulator,
  mmaw: createMetaMaskAgenticSdkSigner(agenticSdk),
});
```

The generic `createMmCliSigner` adapter is deliberately **not** a second
`failClosedSign` example. Current `mm` transfer and swap commands can sign and
submit in one step, so the adapter advertises neither non-broadcasting nor
intent-bound signing and the gate rejects it before ledger mutation.

## SDK Path

The SDK path is for applications that already use MetaMask Agent Wallet inside a TypeScript agent runtime.

Safeloop expects the MetaMask SDK object to expose two operations:

```ts
type MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation> = {
  capabilities?: {
    intentBoundSignatures?: boolean;
    nonBroadcastingSignatures?: boolean;
  };
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
  assertSignedOperationMatchesIntent?(params: {
    intent: CanonicalIntent;
    unsignedOperation: TUnsignedOperation;
    signedOperation: TSignedOperation;
  }): Promise<boolean> | boolean;
};
```

Safeloop calls `buildUnsignedOperation`, runs ledger/simulation/invariant checks, and only then calls `sign`.
The adapter propagates signer capabilities only when the concrete SDK
explicitly declares them. The default is untrusted and fails closed. Production
integrations must declare both intent-bound and non-broadcasting signing and
provide the post-sign assertion; the adapter does not infer either property
from an operation shape.

## CLI Path

The CLI path is for agents that call `mm`.

Supported commands in the current prototype:

- `mm transfer`
- `mm swap execute`
- `mm perps open`
- `mm perps close`
- `mm perps modify`
- `mm perps cancel`
- `mm wallet requests list`
- `mm wallet requests watch`
- `mm tx history`

The CLI adapter builds the `mm` command after intent canonicalization. Because
transfer and swap commands may sign and submit in one step, the generic CLI
wrapper is explicitly incompatible with `failClosedSign`; policy overrides
cannot bypass that boundary. Use it only behind a separate, transaction-bound
execution authorization such as ChainPilot's MMAW executor.

The default runner invokes `mm` directly without a shell, caps combined
stdout/stderr at 1,000,000 bytes, and terminates the child after 620 seconds.
Timeout, output overflow, spawn failure, and non-zero exit are surfaced to the
signer only through sanitized evidence and the stable
`MM_CLI_FAILED_REDACTED` caller error. Tests can inject an executable, prefix
arguments, and tighter limits through `createMmCliRunner`; production callers
normally use the defaults.

Current mapping:

```text
transfer -> mm transfer --token <assetOut> --amount <amountIn> --to <targetContract> --chain-id <chainId> --json
swap     -> mm swap execute --from <assetIn> --to <assetOut> --amount <amountIn> --from-chain <chainId> [--slippage <percent>] --json
perps    -> mm perps <open|close|modify|cancel> ... --dry-run --json
watch    -> mm wallet requests watch --polling-id <id> --json
history  -> mm tx history --json ...
```

The swap mapping matches `@metamask/agentic-cli` 4.0.1. Safeloop preserves
`maxSlippageBps` during intent canonicalization, then converts it to an exact
decimal percentage without floating-point arithmetic (for example, `1` bps
becomes `0.01`, `50` becomes `0.5`, and `10,000` becomes `100`). Values outside
the accepted `0..10,000` bps range, serialized inputs longer than 24
characters, and values with more than 18 decimal places fail before runner
execution. The legacy `--from-token` and `--to-token` flags are never emitted.

For Hyperliquid HIP-3 builder DEX markets, see `docs/hip3.md`.

## Reconciliation Path

Server-wallet and Guard flows can return request states before the transaction is final.

Safeloop treats these as non-success:

- `AWAITING_MFA`
- `BROADCASTING`
- `BROADCAST_TRACKING_EXPIRED`
- timeout states

Agents should use `mm wallet requests watch` and `mm tx history` to reconcile the request before updating memory or telling the user the action is complete.

## Why This Matters

MetaMask wallet policy can limit what an agent is allowed to do.

Safeloop decides whether the next action still makes sense based on recent wallet history and dry-run results.

That difference is the point of the integration.
