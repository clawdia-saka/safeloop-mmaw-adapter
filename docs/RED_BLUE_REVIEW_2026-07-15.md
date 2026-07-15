# MMAW CLI v4 compatibility Red/Blue review — 2026-07-15

Verdict: **APPROVED AFTER FIX**

## Scope

- `@metamask/agentic-cli` 4.0.1 swap argv compatibility
- swap/perps `maxSlippageBps` canonicalization
- exact basis-point to percentage conversion
- fail-closed slippage bounds before process execution

## Red review

Red used Qwen 3.6 route `qwen36-35b-a3b-q4ks`, resolved as
`Qwen3.6-35B-A3B-UD-Q4_K_S.gguf` with fingerprint
`b8892-0d0764dfd`, against the complete delta. Qwen initially returned no
actionable findings. Independent adversarial probing found one HIGH issue that
Qwen missed: an unbounded fractional `maxSlippageBps` value caused
algorithmic backtracking during trailing-zero normalization and could also
produce an oversized CLI argument. A one-million-digit input did not complete
within 20 seconds.

After receiving the benchmark evidence, Qwen confirmed the algorithmic
complexity and input-amplification risk. The original zero-finding verdict was
rejected.

## Blue response

- Fixed: canonicalization rejects serialized slippage values longer than 24
  characters or with more than 18 decimal places before decimal regex work.
- Fixed: the raw CLI builder applies the same bounds before conversion, so a
  caller-supplied `CanonicalIntent` cannot bypass canonicalization.
- Fixed: trailing-zero normalization now uses a linear scan instead of an
  ambiguous regular expression.
- Added: oversized canonicalization and raw-builder regressions, including a
  50,000-digit numerically valid fraction; the injected runner remains
  uncalled.

No critical, high, or medium finding remains open.

## Verification

- targeted CLI v4/slippage tests: pass
- `npm test`: 86/86 pass
- `npm run typecheck`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `git diff | gitleaks stdin --redact`: no leaks
- `git diff --check`: pass

No real `mm` command, wallet/network transaction, push, or deployment was
performed.
