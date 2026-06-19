import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeIntent,
  checkTrajectoryInvariants,
  defaultPolicy,
  qualifyHip3Symbol,
  reconcileVenueState,
  reconcileWalletRequest,
} from "../dist/index.js";
import {
  buildTxHistoryArgs,
  buildWalletRequestsWatchArgs,
} from "../dist/metamask.js";

const baseSimulation = {
  status: "passed",
  preNavUsd: "1000",
  postNavUsd: "1000",
  gasUsd: "0",
  slippageUsd: "0",
  maxLossUsd: "25",
};

test("qualifies HIP-3 symbols with builder DEX identity", () => {
  assert.equal(qualifyHip3Symbol({ dex: "XYZ", symbol: "SPCX" }), "xyz:spcx");
});

test("rejects ambiguous HIP-3 symbol when dex is required", () => {
  const current = row({
    actionType: "perps_open",
    symbol: "spcx",
    requiresDex: true,
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: baseSimulation,
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("HIP3_SYMBOL_AMBIGUOUS"));
});

test("rejects ERC-20 transfer when only token symbol is present", () => {
  const current = row({
    actionType: "transfer",
    assetOut: "USDC",
    amountIn: "10",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: baseSimulation,
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("TOKEN_CONTRACT_REQUIRED"));
});

test("rejects fee-heavy actions where fees exceed trade value budget", () => {
  const current = row({
    actionType: "swap",
    estimatedTradeValueUsd: "2",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      gasUsd: "1",
      slippageUsd: "0.25",
      tradeValueUsd: "2",
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("GAS_EXCEEDS_TRADE_VALUE"));
});

test("does not treat broadcasting wallet requests as terminal success", () => {
  const decision = reconcileWalletRequest({ state: "BROADCASTING" });
  assert.equal(decision.status, "BROADCASTING");
  assert.equal(decision.terminal, false);
  assert.ok(decision.reasonCodes.includes("BROADCASTING_TIMEOUT"));
});

test("requires venue reconciliation for perps open", () => {
  const decision = reconcileVenueState("perps_open", { positionFound: false });
  assert.equal(decision.status, "REQUEST_WATCH_REQUIRED");
  assert.ok(decision.reasonCodes.includes("POSITION_NOT_RECONCILED"));
});

test("builds MetaMask request watch and tx history args", () => {
  assert.deepEqual(buildWalletRequestsWatchArgs("abc-123"), [
    "wallet",
    "requests",
    "watch",
    "--polling-id",
    "abc-123",
    "--json",
  ]);

  assert.deepEqual(buildTxHistoryArgs({ chains: [42161], limit: 10 }), [
    "tx",
    "history",
    "--json",
    "--chain",
    "42161",
    "--limit",
    "10",
  ]);
});

function row(overrides) {
  const canonical = canonicalizeIntent({
    userGoalId: "test-goal",
    wallet: "0x0000000000000000000000000000000000000001",
    chainId: 42161,
    ...overrides,
  });

  return {
    ...canonical,
    intentId: "intent",
    idempotencyKey: "key",
    status: "LOCKED",
    reasonCodes: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

