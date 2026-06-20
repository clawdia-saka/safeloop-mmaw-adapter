# HIP-3 Perps Use Case

MetaMask Agent Wallet v2.0.0 added better support for Hyperliquid HIP-3 builder-deployed DEX flows.

This matters because the common agent-wallet path is no longer just a single swap. It often looks like this:

```text
User goal
  -> bridge or swap funds to Arbitrum
  -> deposit USDC to Hyperliquid
  -> open a perps position
  -> monitor positions, orders, and balance
  -> close or modify the position
```

Safeloop should protect the full path, not only the final order.

## What Can Go Wrong

Agents can make mistakes that still fit inside static wallet policy:

- using the wrong market symbol
- confusing a builder DEX market with the main Hyperliquid market
- opening a position and then failing to find it later
- retrying close/cancel flows repeatedly
- using the wrong USDC source on testnet
- bridging small balances where fees exceed the value of the trade
- treating a quoted bridge as executed when it never landed

## HIP-3 Market Identity

For HIP-3 markets, Safeloop tracks both:

- `dex`: builder DEX name, for example `xyz`
- `symbol`: market symbol, for example `spcx`

The adapter normalizes that into a qualified symbol:

```text
xyz:spcx
```

That avoids the common agent error of searching for `spcx` on the wrong venue.

## Supported Prototype Actions

The current MetaMask CLI adapter supports:

- `perps_open`
- `perps_close`
- `perps_modify`
- `perps_cancel`

Each command is built with `--dry-run` by default. Safeloop should only remove dry-run behavior in a production signer after ledger, simulation, and invariant checks pass.

## Example Intent

```ts
const intent = {
  userGoalId: "open-hip3-spcx-long",
  wallet: "0x...",
  chainId: 42161,
  actionType: "perps_open",
  venue: "hyperliquid",
  network: "mainnet",
  dex: "xyz",
  symbol: "spcx",
  side: "long",
  size: "10",
  leverage: "3",
  maxSlippageBps: "50",
};
```

This becomes:

```text
mm perps open --venue hyperliquid --symbol xyz:spcx --side long --size 10 --leverage 3 --type market --network mainnet --dry-run --json --max-slippage-bps 50
```

## Safeloop Checks For HIP-3

Recommended invariants:

- reject duplicate open intents for the same `dex:symbol`
- reject repeated close/cancel attempts for the same `orderId`
- reject opening an opposite position shortly after opening the current one
- reject position size increases that exceed the user goal budget
- reject bridge/deposit paths where gas and slippage exceed the target trade value
- require ledger reconciliation before assuming a position exists
- require `mm perps positions`, `orders`, or `balance` reconciliation before success
- reject `spcx` when the intended target is `xyz:spcx`
- reject testnet deposits when the USDC source is not the Hyperliquid-compatible token
- reject perps actions without a Hyperliquid-aware risk simulation
- reject margin ratios and liquidation buffers below policy
- reject perps simulations that use stale mark/index price observations
- shrink oracle freshness windows during high-volatility moves
- reject account-level margin health below policy even if the target market looks safe
- reject cross-DEX parallel perps intents for the same account scope
- reject cross-venue parallel intents that share the same collateral pool
- require short-lived signed payloads so delayed mempool or sequencer replay cannot execute later
- preserve native gas runway for emergency close/cancel flows
- reserve gas for MFA/broadcasting requests before confirmation
- keep partial fills pending until size reconciliation completes
- require signer-bound intent protection against storage rollback replay
- require post-sign assertion that the signed payload still matches the approved intent
- require explicit supported chain allowlists before perps signing
- require monotonic oracle age and clock-skew checks
- allow emergency close/cancel flows to preempt lower-priority collateral locks
- require explicit collateral pool identity for shared collateral paths
- require durable time calibration for cold-start worker oracle checks
- block emergency preemption livelock during signing windows
- require cancellation proof before preempting a live signed or broadcasting action
- treat multi-RPC broadcast acceptance as telemetry, not ordered proof
- allow reduce-only close-all emergency paths during RPC quorum partition
- require nonce-bound cancellation proof to avoid false-positive mempool state
- detect shared nonce-domain collisions across workers
- detect low-priority floods that starve emergency close paths
- detect lock-fencing split brain after worker restart
- detect stale gas reservations from aborted preemption
- detect overfit time calibration when volatility regimes change
- stop oscillating partial-fill reconciliation loops
- surface guard-composition failures instead of hiding them in generic aborts
- sanitize evidence packets before operator logging or public sharing
- require position size delta checks for partial close and modify reconciliation

## Operational Notes

- Require `mm doctor` and CLI version checks before debugging HIP-3 behavior.
- Prefer `mm perps markets --dex <name>` before opening builder DEX markets.
- Prefer `mm perps positions`, `orders`, and `balance` after every signed perps action.
- Treat `BROADCASTING`, `BROADCAST_TRACKING_EXPIRED`, and timeout states as unresolved, not failed success.
- Keep the lock scope leased until wallet request and venue reconciliation finish.
- Keep the account-wide lock leased across builder DEXs that share the same Hyperliquid subaccount.
- Keep the global collateral lock leased across venues that share the same funding pool.
- Require fresh Hyperliquid mark/index price inputs for every margin simulation.
- Require volatility metadata so oracle freshness can tighten during fast markets.
- Require signature expiry metadata such as a short timestamp or venue-native time-in-force.
- Require signer integrations to return a signed payload without broadcasting so post-sign assertion can run.
- Treat missing or empty chain allowlists as block-all.
- Sanitize evidence packets before sharing logs, issues, or demos.
- Track native gas balance and recent gas burn before allowing new open actions.
- Include in-flight gas reservations and reverted gas burn in runway accounting.
- Renew or explicitly reconcile MFA-wait locks before their lease expires.
- Do not rely on local wall-clock time alone for oracle freshness.
- Do not rely on process-local monotonic timers alone after serverless cold start.
- Tag emergency close/cancel intents with emergency priority.
- Treat preempted signed or broadcasting requests as live until cancellation or nonce/fill reconciliation proves otherwise.
- Do not put one RPC indexer's confirmation lag on the critical path for emergency exits.
- Do not treat mempool quorum as final cancellation.
- Use reduce-only or close-all emergency intents for partition escape paths.
- Keep nonce domains explicit when multiple workers can sign or cancel.
- Use lock fencing tokens so restarted workers cannot both believe they own the same scope.
- Release unused gas reservations when preemption aborts.
- Avoid implicit default collateral pools in production policies.
- Reconcile partial closes by expected vs observed size, not by `positionFound`.
- On testnet, verify the exact USDC source expected by the Hyperliquid environment before deposit.
