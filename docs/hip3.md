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

## Operational Notes

- Require `mm doctor` and CLI version checks before debugging HIP-3 behavior.
- Prefer `mm perps markets --dex <name>` before opening builder DEX markets.
- Prefer `mm perps positions`, `orders`, and `balance` after every signed perps action.
- Treat `BROADCASTING`, `BROADCAST_TRACKING_EXPIRED`, and timeout states as unresolved, not failed success.
- On testnet, verify the exact USDC source expected by the Hyperliquid environment before deposit.
