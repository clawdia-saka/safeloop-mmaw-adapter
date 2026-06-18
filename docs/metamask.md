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

or:

```ts
await failClosedSign({
  intent,
  ledger,
  simulator,
  mmaw: createMmCliSigner(),
});
```

## SDK Path

The SDK path is for applications that already use MetaMask Agent Wallet inside a TypeScript agent runtime.

Safeloop expects the MetaMask SDK object to expose two operations:

```ts
type MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation> = {
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
};
```

Safeloop calls `buildUnsignedOperation`, runs ledger/simulation/invariant checks, and only then calls `sign`.

## CLI Path

The CLI path is for agents that call `mm`.

Supported commands in the current prototype:

- `mm transfer`
- `mm swap execute`

The CLI adapter builds the `mm` command after intent canonicalization, but execution still passes through `failClosedSign`.

Current mapping:

```text
transfer -> mm transfer --token <assetOut> --amount <amountIn> --to <targetContract> --chain-id <chainId> --json
swap     -> mm swap execute --from-token <assetIn> --to-token <assetOut> --amount <amountIn> --from-chain <chainId> --json
```

## Why This Matters

MetaMask wallet policy can limit what an agent is allowed to do.

Safeloop decides whether the next action still makes sense based on recent wallet history and dry-run results.

That difference is the point of the integration.

