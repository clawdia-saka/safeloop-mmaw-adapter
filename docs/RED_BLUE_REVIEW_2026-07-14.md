# MMAW signer-boundary Red/Blue review — 2026-07-14

Verdict: **APPROVED**

## Scope

- explicit non-broadcasting signer capability
- generic `mm` sign-and-submit rejection
- timestamp-expiry recheck before signing
- SDK/CLI external diagnostic redaction

## Red review

Qwen 3.6 (`qwen36-35b-a3b-q4ks`, resolved
`Qwen3.6-35B-A3B-UD-Q4_K_S.gguf`) found no critical or high regression. It
validated the new fail-closed boundary and raised three follow-ups:

1. Reserve clock-skew time at the signature-expiry boundary.
2. Confirm evidence sanitization is recursive.
3. Confirm the new abort reason has an operator-facing explanation.

## Blue response

1. Fixed: both trajectory validation and the immediate pre-sign recheck now
   treat signatures inside `maxClockSkewMs` as expired. Added deterministic
   tests for the safety window and the delayed pre-sign path.
2. Already covered: `sanitizeEvidencePacket` recursively sanitizes nested
   values; the existing nested/circular/panic tests pass. New CLI and SDK tests
   verify credential-bearing diagnostics are not rethrown.
3. Fixed in the original patch: `src/tracer.ts` maps
   `NON_BROADCASTING_SIGNER_REQUIRED` to an operator-facing explanation.

## Verification

- `npm run typecheck`: pass
- `npm test`: 75/75 pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `gitleaks dir . --redact`: no leaks
- `git diff --check`: pass

No live wallet call, transaction, push, or deployment was performed.
