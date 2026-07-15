# MMAW production readiness security review — 2026-07-16

## Verdict

APPROVED — open findings: **CRITICAL 0 / HIGH 0 / MEDIUM 0**.

Review scope: the local `feat/production-readiness` change set relative to
`origin/main`, including the SQLite ledger, Anvil/Tenderly simulators, live
State C readiness assessment, production `failClosedSign` path, MetaMask signer
adapter, documentation, and regression tests.

## Review method

- Qwen 3.6 Red Team reviewed the final signing deadline, production preflight,
  SQLite cleanup transaction, and readiness capability checks. Final verdict:
  PASS, C0/H0/M0.
- An independent Red reviewer exercised mutation, signing lifecycle, ownership,
  cleanup, schema, and readiness boundaries. Final verdict: APPROVED,
  C0/H0/M0.
- An independent Blue reviewer exercised recovery, fail-closed evidence,
  history overflow, lease, and release behavior. Final verdict: APPROVED,
  C0/H0/M0.

## Findings closed

| Area | Initial risk | Final disposition |
|---|---|---|
| Preemption | Live or expired `SIGNING`/`SIGNED` owner could be replaced | SQLite never preempts those states; capability is not advertised |
| Status fencing | Legacy status write or final `SIGNED` write could bypass owner epoch | Owner-bound rows reject unfenced writes; final write is atomic and fenced |
| Mutable boundaries | Canonical intent, unsigned/signed operation, provider object, Buffer, or shared memory could create TOCTOU | Production uses isolated plain-data/byte snapshots, preserves Buffer, and rejects shared memory/custom accessors |
| Signing deadline | Signer could hang past policy or actual renewed lease | Production requires abort capability and callable renewal; deadline uses the authoritative renewed lease and signature expiry |
| Abort uncertainty | Locks could be released before cancellation acknowledgement | Unacknowledged abort retains durable `SIGNING` and all locks for reconciliation |
| Post-sign cleanup | Failed cleanup could expose a retry while a payload remained live | SQLite atomically persists `SIGN_FAILED` and releases owned locks; unproven cleanup leaves `SIGNING` intact |
| Pre-sign recovery | History/status exceptions could orphan scopes | Durable preflight requires owner-bound release and every unexpected pre-sign failure attempts fenced terminal cleanup |
| History flood | A 1,000-row cap could silently hide older in-window risk | Query reads cap + 1 and fails closed on overflow |
| Perps evidence | Missing gas/margin/account evidence could default to safe zero | Required evidence is explicit and invalid/missing values emit fail-closed reasons; EVM adapters reject `perps_*` |
| Runtime schema | JavaScript callers could bypass action-specific checks with malformed intent types | Intent fields, action enum, addresses, booleans, arrays, and bounds are validated before locking |
| Readiness confusion | Truthy strings, exotic dates, proxies, or unbounded policy values could pass/throw | Strict booleans/types/bounds, intrinsic Date normalization, and guarded malformed-input handling block State C |
| Provider timeout | Risk evidence work continued after timeout | Provider receives a cooperative `AbortSignal`; operation/intent inputs are isolated |

The readiness assessment is intentionally structural validation of trusted
deployment-supplied adapters and evidence. It is not cryptographic attestation
of arbitrary third-party objects; this trust boundary is documented and was not
counted as an open defect.

## Final verification evidence

- `npm test`: 126/126 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `git diff --check`: passed.
- `npm pack --dry-run`: passed.
- Gitleaks scan of the complete staged change set: no leaks.
- No wallet, broadcast, deployment, live RPC mutation, push, or merge was
  performed as part of this review.
