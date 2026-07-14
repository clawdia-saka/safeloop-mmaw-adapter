# MMAW signer and CLI process boundary

## Goal

Make the documented `sign()`-without-broadcasting requirement an enforced,
fail-closed runtime contract, including bounded execution of the legacy `mm`
sign-and-submit adapter when it is used behind a separate transaction-bound
authorization.

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
- The default `mm` process runner has a finite timeout and bounded stdout/stderr
  capture. Timeout or output overflow kills the child and returns only a
  redacted failure to callers.
- Documentation must not show the sign-and-submit CLI adapter as a valid
  `failClosedSign` signer.

## Regression

- Existing SafeLoop, reconciliation, MetaMask, Hyperliquid, evidence, and
  tracer tests pass.
- Typecheck and build pass.
- The default policy remains fail-closed and no CLI command is executed by the
  new rejection tests.
- Bounded-process regressions cover success, timeout, output overflow, and
  secret-bearing stderr without invoking a real wallet command.

## Non-goals

- Publishing the package or changing its public version.
- Submitting a live transaction.
- Replacing ChainPilot's separately authorized MMAW execution client.
