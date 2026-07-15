# MMAW signer boundary and CLI v4 compatibility

## Goal

Make the documented `sign()`-without-broadcasting requirement an enforced,
fail-closed runtime contract, including bounded execution of the legacy `mm`
sign-and-submit adapter when it is used behind a separate transaction-bound
authorization. Keep generated commands compatible with the documented
`@metamask/agentic-cli` 4.0.1 surface.

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
- Swap execution must use the CLI v4 flags `--from`, `--to`, `--amount`, and
  `--from-chain`; legacy `--from-token` / `--to-token` flags must never be
  emitted.
- Optional swap `maxSlippageBps` must be preserved during canonicalization and
  converted exactly to the CLI's percentage-valued `--slippage` flag. Values
  above 10,000 bps must fail before process execution.

## Regression

- Existing SafeLoop, reconciliation, MetaMask, Hyperliquid, evidence, and
  tracer tests pass.
- Typecheck and build pass.
- The default policy remains fail-closed and no CLI command is executed by the
  new rejection tests.
- Bounded-process regressions cover success, timeout, output overflow, and
  secret-bearing stderr without invoking a real wallet command.
- Command regressions assert the exact CLI v4 swap argv, including the absence
  of legacy flags and exact basis-point conversion.

## Non-goals

- Publishing the package or changing its public version.
- Submitting a live transaction.
- Replacing ChainPilot's separately authorized MMAW execution client.
