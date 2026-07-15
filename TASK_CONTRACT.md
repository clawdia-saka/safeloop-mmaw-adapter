# MMAW production readiness adapters

## Goal

Provide concrete, fail-closed production primitives for the existing MMAW
signing boundary: a restart-durable SQLite ledger, non-broadcasting Anvil and
Tenderly simulation adapters, and an explicit live State C readiness check.

## Definition of done

- `createSqliteLedger` persists action rows and lock ownership across process
  restarts and acquires intent/account/global scopes atomically.
- Lock acquisition, lease expiry, fencing, ownership verification, status
  changes, wallet history, and post-sign cleanup have deterministic tests,
  including two connections contending for the same scope.
- Production-policy signing rejects ledgers without an atomic owner-bound final
  status write or callable lease renewal, rejects non-abortable signers, bounds
  signing by the authoritative renewed lease/signature expiry, retains the
  durable `SIGNING` shadow when abort is not acknowledged, snapshots supported plain-data/byte values
  across trust boundaries, and SQLite never preempts live `SIGNING` or `SIGNED`
  owners.
- Durable production ledgers expose owner-bound release, and post-sign cleanup
  atomically persists `SIGN_FAILED` with owned lock/payload retirement; cleanup
  failure leaves the live `SIGNING` shadow intact.
- `createAnvilSimulator` uses only read-only JSON-RPC methods (`eth_chainId`,
  `eth_call`, `eth_estimateGas`) and never broadcasts.
- `createTenderlySimulator` uses `tenderly_simulateTransaction` and never calls
  a send/broadcast RPC method.
- Both simulators enforce chain identity, bounded timeout/response handling,
  exact RPC envelopes, and require caller-supplied financial/time risk evidence
  before returning `passed`; provider deadlines abort caller work via a signal,
  provider mutation is isolated, and EVM adapters reject non-EVM perps.
- `assessLiveStateCReadiness` fails closed unless the ledger, signer, simulator,
  supported-chain policy, RPC probe, durable time calibration, expiring
  abortable signatures, and post-sign intent assertion are all present,
  strictly typed, and compatible. Malformed runtime inputs, exotic dates, and
  throwing proxies return a blocked result, not throw.
- Existing tests, new regressions, typecheck, build, audit, secret scan, and
  diff checks pass.
- Red/Blue review has zero open critical, high, or medium findings.

## Constraints

- No new runtime dependency; use Node's built-in `node:sqlite`.
- No real wallet, signing, broadcast, deploy, Anvil mutation, or Tenderly
  mutation call.
- No raw RPC URL, credential, response body, or signed payload in thrown
  diagnostics.
- Preserve the existing `Ledger`, `Simulator`, `MmawSigner`, and
  `failClosedSign` contracts for current consumers; owner-bound writes are
  mandatory, the optional signer `AbortSignal` is backward-compatible, and
  isolated plain-data/byte snapshots are returned only while production
  durable-ledger policy is enabled. Shared memory and custom class instances
  are rejected at that production boundary.

## Non-goals

- Running a live State C transaction.
- Provisioning Tenderly credentials or a production database.
- Implementing a full concrete `@metamask/agentic-sdk` binding.
- Replacing the existing Hyperliquid margin model.

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm audit --audit-level=low`
- `gitleaks git --no-banner --redact --log-opts='origin/main..HEAD'`
- `git diff --check origin/main...HEAD`
- `npm pack --dry-run`
