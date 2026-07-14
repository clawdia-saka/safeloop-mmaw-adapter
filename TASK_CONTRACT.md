# MMAW non-broadcasting signer boundary

## Goal

Make the documented `sign()`-without-broadcasting requirement an enforced,
fail-closed runtime contract.

## Capability

- A signer must explicitly declare `nonBroadcastingSignatures: true` before
  `failClosedSign` can call it.
- The generic `mm` CLI adapter is treated as sign-and-submit and cannot cross
  the `failClosedSign` signer boundary, even when optional policy checks are
  weakened.
- A timestamp-based signature expiry is checked again immediately before
  signing so a slow simulation, history read, or lock verification cannot use
  an expired authorization.
- CLI and SDK failures never rethrow raw external diagnostics.

## Regression

- Existing SafeLoop, reconciliation, MetaMask, Hyperliquid, evidence, and
  tracer tests pass.
- Typecheck and build pass.
- The default policy remains fail-closed and no CLI command is executed by the
  new rejection tests.

## Non-goals

- Publishing the package or changing its public version.
- Submitting a live transaction.
- Replacing ChainPilot's separately authorized MMAW execution client.
