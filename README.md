# Safeloop MetaMask Agent Wallet Adapter

Pre-sign safety layer for MetaMask Agent Wallet.

This repo now includes explicit MetaMask connection points:

- `src/metamask.ts` wraps a MetaMask Agentic SDK-style client.
- `src/metamask.ts` includes an `mm` CLI adapter for MetaMask Agentic CLI.
- The MetaMask integration guide shows how those adapters plug into Safeloop.
- `docs/hip3.md` covers the current Hyperliquid HIP-3 perps workflow.
- `docs/death-metrics.md` covers red-team failure scenarios and required guards.

This project adds a runtime gate before an autonomous agent can sign a wallet action. It is designed to stop mistakes that normal wallet permissions do not catch, such as an agent repeatedly swapping `ETH -> USDC -> ETH` until the wallet loses funds to gas, slippage, or bad retries.

## The Problem

Wallet policies can answer questions like:

- Is this agent allowed to swap?
- Is this amount under the daily limit?
- Is this contract blocked?

Those checks are useful, but they do not answer:

- Is the agent repeating the same action?
- Is the agent reversing its previous action for no useful reason?
- Is the agent losing money through a loop?
- Did the agent think a failed transaction succeeded?
- Is a submitted wallet request still waiting for MFA, stuck broadcasting, or never reconciled with the venue?

Safeloop handles that missing layer.

## What It Does

Safeloop sits between the agent and MetaMask Agent Wallet.

```text
Agent intent
  -> Safeloop safety checks
  -> MetaMask Agent Wallet signing
  -> Transaction submission
  -> Safeloop reconciliation
```

It signs only when all checks pass:

1. The action is written to an Action Ledger.
2. A deterministic idempotency key is created.
3. A dry-run simulation passes.
4. Recent wallet activity does not violate trajectory rules.
5. The ledger state is consistent.
6. Any wallet or market lock has an expiry lease.
7. Any perps oracle price used for simulation is fresh enough.
8. The signer still owns the lock immediately before signing.
9. Perps risk is checked at the account level, not only per market.
10. Signed payloads expire quickly enough to prevent ghost replay.
11. Shared collateral is locked across venues.
12. Native gas runway is preserved for emergency exits.
13. In-flight signatures and reverted gas are counted before new opens.
14. Partial fills stay pending until fully reconciled.
15. Oracle age uses monotonic timing and rejects unsafe clock drift.
16. Emergency exits can preempt lower-priority collateral locks.
17. Shared collateral pools must be explicit.
18. Serverless cold starts must prove durable time calibration before oracle checks.
19. Signing locks get a short non-preemptable window to avoid emergency livelock.
20. A preempted live transaction must have cancellation proof before another transaction signs.
21. Cancellation proof can use fresh multi-RPC broadcast acceptance to avoid RPC indexing deadlock.
22. Nonce domains, lock fencing, gas reservations, partial fills, and guard composition are checked for cross-guard failure.

If any check fails, Safeloop aborts before signing.

## Plain-English Example

Without Safeloop:

```text
Agent swaps ETH to USDC.
Agent panics.
Agent swaps USDC back to ETH.
Agent repeats.
Wallet slowly drains from gas and slippage.
```

With Safeloop:

```text
Agent requests ETH -> USDC.
Safeloop records it.
Agent requests USDC -> ETH shortly after.
Safeloop detects a reverse route loop.
Safeloop refuses to sign.
```

## Architecture

### Phase 1: Intent Ledger + Pre-Sign Gate

Every proposed action is converted into a canonical intent and locked in a ledger before signing.

This prevents:

- duplicated actions
- double execution
- unsafe retries
- agent memory drifting away from transaction state

### Phase 2: Trajectory Invariant Engine

Safeloop checks the recent action history, not just the current transaction.

It can reject:

- reverse swap loops
- repeated failed retries
- cumulative gas loss
- net asset value loss beyond policy
- unbounded approvals without a matching downstream action
- HIP-3 perps mistakes, such as opening on the wrong builder DEX market or retrying close/cancel loops
- unresolved wallet request states, such as MFA wait, broadcast timeout, or quote-only execution
- token identity mistakes, such as using `USDC` when the CLI requires a contract address
- account-wide perps risk that crosses builder DEX or market boundaries
- stale signing transitions that require wallet request or tx history reconciliation before retry
- long-lived signed transactions that could later replay from a mempool or sequencer queue
- low native gas runway that would block emergency close/cancel actions
- partial fills that would otherwise be mistaken for success
- MFA or broadcast windows that shadow an expired lease
- local clock drift that would brick or bypass oracle freshness checks
- priority inversion where a low-priority task blocks an emergency exit
- collateral pool leakage from ambiguous default pool labels
- cold-start workers that cannot prove durable time calibration
- emergency preemption loops that keep aborting each other before broadcast
- preempted transactions that may still be alive in a mempool or venue queue
- cancellation proof waits that would put RPC indexing lag on the emergency path
- stale or false-positive cancellation proofs
- shared nonce collisions across workers
- low-priority floods that starve emergency exits
- split-brain lock release after worker restart
- stale gas reservations from aborted preemption
- overfit time calibration in a new volatility regime
- partial-fill reconciliation loops
- safety guards that cancel each other out

### Phase 3: Fail-Closed Signing Gateway

Agents do not call MetaMask signing directly.

They call:

```ts
failClosedSign(...)
```

If ledger, simulation, or invariant checks are unknown or failed, the function throws before signing.

## Core API

```ts
import { failClosedSign } from "@safeloop/mmaw-adapter";
import { createMetaMaskAgenticSdkSigner } from "@safeloop/mmaw-adapter/metamask";

const signedOperation = await failClosedSign({
  intent,
  ledger,
  mmaw: createMetaMaskAgenticSdkSigner(agenticSdk),
  simulator,
  policy,
});
```

The adapter is intentionally dependency-light. Storage, simulation, and MetaMask integration are injected as interfaces so teams can connect their own Notion, Supabase, Anvil, Tenderly, or MMAW setup.

## Current Status

Prototype.

Included:

- canonical intent generation
- idempotency key generation
- ledger interface
- simulator interface
- fail-closed signing gateway
- default trajectory invariant checks
- reconciliation helpers for wallet requests and perps venue state
- durable-ledger and lock-scope checks to prevent reboot amnesia
- atomic distributed lock requirements with TTL-based lock leases
- lock-owner verification immediately before signing
- Hyperliquid perps margin-model helpers for non-EVM simulation paths
- account-wide Hyperliquid health checks for cross-margin exposure
- dynamic oracle freshness checks for Hyperliquid mark/index price inputs
- short signature expiry requirements for ghost transaction control
- global collateral locks across venues that share the same funding pool
- gas runway and burn-rate gates to preserve emergency close capacity
- in-flight gas reservation and reverted-gas reconciliation
- partial fill pending-state guards
- signer-bound intent capability checks
- monotonic oracle age and clock-drift limits
- priority-aware global collateral locking
- explicit collateral pool requirements
- durable time calibration requirements for serverless workers
- non-preemptable signing windows and preemption rate limits
- preemption cancellation proof for live broadcast risk
- multi-RPC cancellation acceptance as a bounded fallback for indexing lag
- nonce-domain and lock-fencing guards for concurrent workers
- gas reservation drift and partial reconciliation loop checks
- guard-composition conflict detection for emergency flows
- MetaMask Agentic SDK-style signer adapter
- MetaMask Agentic CLI `mm` adapter for transfers and swaps
- MetaMask Agentic CLI `mm perps` adapter for Hyperliquid and HIP-3-style flows
- MetaMask Agentic CLI helpers for `wallet requests watch` and `tx history`

Not included yet:

- production ledger adapter
- Anvil or Tenderly simulator adapter
- full concrete `@metamask/agentic-sdk` API binding
- full `mm` command coverage beyond transfer, swap, and perps prototype commands
- notification adapter

## Repository Layout

```text
src/index.ts              Core adapter types and fail-closed signing flow
src/metamask.ts           MetaMask Agentic SDK and mm CLI adapters
src/reconciliation.ts     Wallet request and venue reconciliation helpers
src/hyperliquid.ts        Hyperliquid perps margin-model helpers
docs/architecture.md      Detailed architecture and policy model
docs/metamask.md             MetaMask integration guide
docs/hip3.md                 Hyperliquid HIP-3 perps use case
docs/death-metrics.md        Red-team failure scenarios
sql/supabase.sql             Durable Action Ledger schema
```

## Safety Model

Safeloop defaults to fail-closed.

That means:

- non-durable ledger: do not sign
- failed check: do not sign
- unknown check: do not sign
- unavailable simulation: do not sign
- ledger conflict: do not sign
- missing lock lease: do not sign
- lost lock ownership: do not sign
- unresolved prior signing transition: do not sign
- missing or long-lived signature expiry: do not sign
- unsafe account-wide perps health: do not sign
- stale oracle price: do not sign
- unsafe gas runway: do not sign new opens
- partial fill unresolved: do not mark success
- reverted gas missing: do not mark fully reconciled
- unsafe local clock drift: do not sign
- missing or stale durable time calibration: do not sign
- missing shared collateral pool: do not sign
- live preempted transaction without cancellation proof: do not sign
- emergency preemption livelock risk: do not sign
- stale or under-quorum cancellation acceptance: do not sign
- nonce collision or missing nonce domain on emergency preemption: do not sign
- split-brain lock fencing gap: do not sign
- stale gas reservation drift: do not sign
- partial reconciliation loop: do not keep retrying blindly
- conflicting emergency guard composition: do not sign
- unresolved broadcast or MFA state: do not mark success
- unreconciled perps venue state: do not mark success

## Supabase Note

`sql/supabase.sql` is only a schema template. This repository does not include
any Supabase project URL, API key, wallet secret, or shared database.

If someone uses Supabase, they create their own private Supabase project and run
the SQL there. Production deployments should keep service-role credentials on
the server side only and enable appropriate row-level security for any user
facing access.

## Roadmap

1. Add SQLite and Supabase Action Ledger adapters around `sql/supabase.sql`.
2. Add `safeloop-mm` CLI wrapper so agents do not call `mm` directly.
3. Add Anvil or Tenderly dry-run simulator adapter.
4. Expand MetaMask Agentic SDK wrapper against the concrete SDK API.
5. Expand `mm` CLI wrapper beyond transfer, swap, and perps prototype commands.
6. Add Slack and Notion notification hooks.
7. Add policy file support with YAML.
