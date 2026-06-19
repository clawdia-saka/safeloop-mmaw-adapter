import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeIntent,
  checkTrajectoryInvariants,
  defaultPolicy,
  failClosedSign,
  makeAccountLockScope,
  makeGlobalCollateralLockScope,
  makeLockScope,
  qualifyHip3Symbol,
  reconcileVenueState,
  reconcileWalletRequest,
  SafeloopAbort,
  simulateHyperliquidPerpsRisk,
  hyperliquidRiskToSimulation,
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
  signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  timeCalibrationSource: "durable",
  timeCalibrationSyncedAt: new Date().toISOString(),
  timeCalibrationRoundTripMs: 20,
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
  assert.ok(reasons.includes("NON_EVM_SIMULATION_REQUIRED"));
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

test("requires reverted transaction gas burn reconciliation", () => {
  const decision = reconcileWalletRequest({ state: "REVERTED" });
  assert.equal(decision.status, "REVERTED");
  assert.ok(decision.reasonCodes.includes("REVERT_GAS_BURN_UNACCOUNTED"));
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

test("requires a durable atomic ledger before signing", async () => {
  const unsafeLedger = {
    capabilities: { durable: false, atomicLocks: false },
    tryLock: async () => true,
    markStatus: async () => {},
    recentForWallet: async () => [],
  };

  await assert.rejects(
    () =>
      failClosedSign({
        intent: {
          userGoalId: "durable-ledger",
          wallet: "0x0000000000000000000000000000000000000001",
          chainId: 1,
          actionType: "swap",
          assetIn: "eth",
          assetOut: "usdc",
          amountIn: "1",
        },
        ledger: unsafeLedger,
        mmaw: {
          buildUnsignedOperation: async () => ({}),
          sign: async () => ({}),
        },
        simulator: {
          simulate: async () => baseSimulation,
        },
      }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("DURABLE_LEDGER_REQUIRED"),
  );
});

test("requires lock leases for distributed signing", async () => {
  const unsafeLedger = {
    capabilities: { durable: true, atomicLocks: true, lockLeases: false },
    tryLock: async () => true,
    markStatus: async () => {},
    recentForWallet: async () => [],
  };

  await assert.rejects(
    () =>
      failClosedSign({
        intent: {
          userGoalId: "leased-lock",
          wallet: "0x0000000000000000000000000000000000000001",
          chainId: 1,
          actionType: "swap",
          assetIn: "eth",
          assetOut: "usdc",
          amountIn: "1",
        },
        ledger: unsafeLedger,
        mmaw: {
          buildUnsignedOperation: async () => ({}),
          sign: async () => ({}),
        },
        simulator: {
          simulate: async () => baseSimulation,
        },
      }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("LOCK_LEASE_REQUIRED"),
  );
});

test("verifies lock ownership immediately before signing", async () => {
  let signCalled = false;
  const ledger = {
    capabilities: {
      durable: true,
      atomicLocks: true,
      lockLeases: true,
      ownedLocks: true,
      accountScopedLocks: true,
      globalCollateralLocks: true,
      lockLeaseRenewal: true,
      inFlightGasAccounting: true,
      priorityLocks: true,
      preemptionCancellation: true,
    },
    tryLock: async () => true,
    verifyLock: async () => false,
    markStatus: async () => {},
    recentForWallet: async () => [],
  };

  await assert.rejects(
    () =>
      failClosedSign({
        intent: {
          userGoalId: "lost-owner",
          wallet: "0x0000000000000000000000000000000000000001",
          chainId: 1,
          actionType: "swap",
          assetIn: "eth",
          assetOut: "usdc",
          amountIn: "1",
        },
        ledger,
        mmaw: {
          capabilities: { intentBoundSignatures: true },
          buildUnsignedOperation: async () => ({}),
          sign: async () => {
            signCalled = true;
            return {};
          },
        },
        simulator: {
          simulate: async () => baseSimulation,
        },
      }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("LOCK_OWNERSHIP_LOST"),
  );

  assert.equal(signCalled, false);
});

test("requires signer-bound intent protection against rollback replay", async () => {
  const ledger = {
    capabilities: {
      durable: true,
      atomicLocks: true,
      lockLeases: true,
      ownedLocks: true,
      accountScopedLocks: true,
      globalCollateralLocks: true,
      lockLeaseRenewal: true,
      inFlightGasAccounting: true,
      priorityLocks: true,
      preemptionCancellation: true,
    },
    tryLock: async () => true,
    verifyLock: async () => true,
    markStatus: async () => {},
    recentForWallet: async () => [],
  };

  await assert.rejects(
    () =>
      failClosedSign({
        intent: {
          userGoalId: "rollback-replay",
          wallet: "0x0000000000000000000000000000000000000001",
          chainId: 1,
          actionType: "swap",
          assetIn: "eth",
          assetOut: "usdc",
          amountIn: "1",
        },
        ledger,
        mmaw: {
          buildUnsignedOperation: async () => ({}),
          sign: async () => ({}),
        },
        simulator: {
          simulate: async () => baseSimulation,
        },
      }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNER_INTENT_BINDING_REQUIRED"),
  );
});

test("detects active lock-scope overlap before reconciliation completes", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "spcx",
    side: "long",
    size: "10",
    leverage: "3",
  });
  current.lockScope = makeLockScope(current);

  const prior = {
    ...current,
    intentId: "prior",
    idempotencyKey: "prior-key",
    status: "BROADCASTING",
  };

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("OVER_ALLOCATION_RISK"));
});

test("does not block a scope forever after a prior lock lease expires", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "spcx",
    side: "long",
    size: "10",
    leverage: "3",
  });
  current.lockScope = makeLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = {
    ...current,
    intentId: "prior",
    idempotencyKey: "prior-key",
    status: "BROADCASTING",
    lockedUntil: new Date(Date.now() - 60_000).toISOString(),
  };

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(!reasons.includes("OVER_ALLOCATION_RISK"));
});

test("requires signature reconciliation before retrying a signing transition", () => {
  const current = row({
    actionType: "swap",
    assetIn: "eth",
    assetOut: "usdc",
    amountIn: "1",
  });
  current.lockScope = makeLockScope(current);

  const prior = {
    ...current,
    intentId: "prior",
    idempotencyKey: "prior-key",
    status: "SIGNING",
    lockedUntil: new Date(Date.now() - 60_000).toISOString(),
  };

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: baseSimulation,
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("SIGNATURE_RECONCILIATION_REQUIRED"));
});

test("keeps expired MFA wait locks shadowed until lease renewal", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });
  current.lockScope = makeLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = {
    ...current,
    intentId: "prior",
    idempotencyKey: "prior-key",
    status: "AWAITING_HUMAN_APPROVAL",
    lockedUntil: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("LOCK_LEASE_EXTENSION_REQUIRED"));
  assert.ok(reasons.includes("OVER_ALLOCATION_RISK"));
});

test("requires cryptographic signature expiry before signing", () => {
  const current = row({
    actionType: "swap",
    assetIn: "eth",
    assetOut: "usdc",
    amountIn: "1",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      signatureExpiresAt: undefined,
      validUntilBlock: undefined,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("SIGNATURE_EXPIRY_REQUIRED"));
});

test("rejects long-lived ghost transaction signatures", () => {
  const current = row({
    actionType: "swap",
    assetIn: "eth",
    assetOut: "usdc",
    amountIn: "1",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      signatureExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("SIGNATURE_EXPIRY_REQUIRED"));
});

test("locks account-wide perps risk across HIP-3 builder DEX scopes", () => {
  const current = row({
    actionType: "perps_open",
    dex: "dex-a",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });
  current.lockScope = makeLockScope(current);
  current.accountLockScope = makeAccountLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.lockScope = makeLockScope(prior);
  prior.accountLockScope = makeAccountLockScope(prior);
  prior.status = "BROADCASTING";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("ACCOUNT_LOCK_REQUIRED"));
  assert.ok(reasons.includes("OVER_ALLOCATION_RISK"));
});

test("locks shared collateral across different venues", () => {
  const current = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });
  current.globalCollateralLockScope = "0x0000000000000000000000000000000000000001:main-usdc:global-collateral";
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "backpack",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "LOCKED";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date(Date.now() - 10_000).toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("GLOBAL_COLLATERAL_LOCK_REQUIRED"));
  assert.ok(reasons.includes("OVER_ALLOCATION_RISK"));
});

test("lets emergency close preempt lower-priority global collateral lock", () => {
  const current = row({
    actionType: "perps_close",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    size: "1",
    priority: "emergency",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "backpack",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
    priority: "low",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "LOCKED";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date(Date.now() - 10_000).toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(!reasons.includes("GLOBAL_COLLATERAL_LOCK_REQUIRED"));
  assert.ok(!reasons.includes("OVER_ALLOCATION_RISK"));
});

test("requires durable time calibration for perps oracle monotonic age", () => {
  const current = row({
    actionType: "perps_open",
    collateralPoolId: "main-usdc",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
      timeCalibrationSource: "local",
      timeCalibrationSyncedAt: undefined,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("TIME_CALIBRATION_REQUIRED"));
});

test("rejects stale or slow durable time calibration", () => {
  const current = row({
    actionType: "perps_open",
    collateralPoolId: "main-usdc",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
      timeCalibrationSource: "durable",
      timeCalibrationSyncedAt: new Date(
        Date.now() - defaultPolicy.maxTimeCalibrationAgeMs - 1,
      ).toISOString(),
      timeCalibrationRoundTripMs:
        defaultPolicy.maxTimeCalibrationRoundTripMs + 1,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("TIME_CALIBRATION_STALE"));
  assert.ok(reasons.includes("TIME_CALIBRATION_UNSAFE"));
});

test("blocks preemption during non-preemptable signing window", () => {
  const current = row({
    actionType: "perps_close",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    size: "1",
    priority: "emergency",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
    priority: "low",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "SIGNING";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date().toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("NON_PREEMPTABLE_SIGNING_LOCK"));
  assert.ok(reasons.includes("PREEMPTION_LIVELOCK_RISK"));
});

test("rate-limits repeated emergency preemptions in the same window", () => {
  const current = row({
    actionType: "perps_close",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    size: "1",
    priority: "emergency",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
    priority: "low",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "LOCKED";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date(Date.now() - 10_000).toISOString();
  prior.preemptionCount = defaultPolicy.maxPreemptionsPerWindow;
  prior.lastPreemptedAt = new Date().toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("PREEMPTION_LIVELOCK_RISK"));
});

test("requires cancellation proof before preempting a live broadcast risk", () => {
  const current = row({
    actionType: "perps_close",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    size: "1",
    priority: "emergency",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
    priority: "low",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "BROADCASTING";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date(Date.now() - 10_000).toISOString();

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("PREEMPTION_CANCEL_REQUIRED"));
  assert.ok(reasons.includes("PREEMPTED_TX_STILL_LIVE"));
  assert.ok(reasons.includes("GLOBAL_COLLATERAL_LOCK_CONTENTION"));
});

test("allows emergency preemption after live tx cancellation is confirmed", () => {
  const current = row({
    actionType: "perps_close",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    size: "1",
    priority: "emergency",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-b",
    symbol: "eth",
    side: "long",
    size: "10",
    leverage: "3",
    priority: "low",
  });
  prior.intentId = "prior";
  prior.idempotencyKey = "prior-key";
  prior.globalCollateralLockScope = current.globalCollateralLockScope;
  prior.status = "BROADCASTING";
  prior.lockedUntil = new Date(Date.now() + 60_000).toISOString();
  prior.createdAt = new Date(Date.now() - 10_000).toISOString();
  prior.updatedAt = new Date(Date.now() - 10_000).toISOString();
  prior.preemptionCancelStatus = "confirmed";

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(!reasons.includes("PREEMPTION_CANCEL_REQUIRED"));
  assert.ok(!reasons.includes("PREEMPTED_TX_STILL_LIVE"));
  assert.ok(!reasons.includes("GLOBAL_COLLATERAL_LOCK_REQUIRED"));
});

test("requires explicit collateral pool for shared collateral locks", () => {
  const current = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    dex: "dex-a",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("COLLATERAL_POOL_REQUIRED"));
  assert.ok(reasons.includes("POOL_LEAKAGE_RISK"));
});

test("flags stale global collateral contention as cross-venue deadlock", () => {
  const current = row({
    actionType: "perps_open",
    venue: "hyperliquid",
    collateralPoolId: "main-usdc",
    dex: "dex-a",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });
  current.globalCollateralLockScope = makeGlobalCollateralLockScope(current);
  current.lockedUntil = new Date(Date.now() + 60_000).toISOString();

  const prior = {
    ...current,
    intentId: "prior",
    idempotencyKey: "prior-key",
    status: "AWAITING_HUMAN_APPROVAL",
    lockedUntil: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };

  const reasons = checkTrajectoryInvariants({
    current,
    history: [prior],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("CROSS_VENUE_RECONCILIATION_DEADLOCK"));
  assert.ok(reasons.includes("GLOBAL_COLLATERAL_LOCK_CONTENTION"));
});

test("rejects unsafe account-wide Hyperliquid health", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      accountMarginRatioBps: 1_000,
      accountLiquidationBufferBps: 100,
      accountExposureUsd: "20000",
      oracleObservedAt: new Date().toISOString(),
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("ACCOUNT_HEALTH_LIMIT"));
});

test("shrinks oracle freshness window during high volatility", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date(Date.now() - 1_000).toISOString(),
      volatilityBps: defaultPolicy.oracleVolatilityThresholdBps,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("ORACLE_PRICE_STALE"));
});

test("uses monotonic oracle age when wall clock is stale", () => {
  const current = row({
    actionType: "perps_open",
    collateralPoolId: "main-usdc",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date(Date.now() - 60_000).toISOString(),
      oracleMonotonicAgeMs: 100,
      clockSkewMs: 100,
    },
    policy: defaultPolicy,
  });

  assert.ok(!reasons.includes("ORACLE_PRICE_STALE"));
});

test("rejects unsafe local clock drift around oracle checks", () => {
  const current = row({
    actionType: "perps_open",
    collateralPoolId: "main-usdc",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      oracleMonotonicAgeMs: 100,
      clockSkewMs: defaultPolicy.maxClockSkewMs + 1,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("CLOCK_DRIFT_LIMIT"));
});

test("blocks new opens when gas runway is too low", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      nativeBalanceUsd: "9",
      estimatedMaxGasUsd: "1",
      gasRunwayTransactions: 9,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("GAS_RUNWAY_LOW"));
});

test("reserves gas runway for in-flight signatures", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "1",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      nativeBalanceUsd: "15",
      estimatedMaxGasUsd: "1",
      inFlightGasUsd: "10",
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("GAS_RUNWAY_LOW"));
  assert.ok(reasons.includes("IN_FLIGHT_GAS_RESERVED"));
});

test("allows emergency close to use reserved gas runway", () => {
  const current = row({
    actionType: "perps_close",
    dex: "xyz",
    symbol: "btc",
    size: "1",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      nativeBalanceUsd: "1",
      estimatedMaxGasUsd: "1",
      gasRunwayTransactions: 1,
    },
    policy: defaultPolicy,
  });

  assert.ok(!reasons.includes("GAS_RUNWAY_LOW"));
});

test("requires position size delta reconciliation for partial perps close", () => {
  const decision = reconcileVenueState("perps_close", {
    positionFound: true,
    expectedPositionSize: "1",
    observedPositionSize: "2",
  });

  assert.equal(decision.status, "REQUEST_WATCH_REQUIRED");
  assert.ok(decision.reasonCodes.includes("POSITION_DELTA_MISMATCH"));
});

test("does not mark partial fills as terminal success", () => {
  const decision = reconcileVenueState("perps_open", {
    fillStatus: "partial",
    expectedFillSize: "10",
    filledSize: "4",
  });

  assert.equal(decision.status, "REQUEST_WATCH_REQUIRED");
  assert.ok(decision.reasonCodes.includes("PARTIAL_FILL_PENDING"));
});

test("flags partial fill simulation divergence", () => {
  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "btc",
    side: "long",
    size: "10",
    leverage: "3",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      venueSimulation: "hyperliquid-margin-model",
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      oracleObservedAt: new Date().toISOString(),
      fillStatus: "partial",
      expectedFillSize: "10",
      filledSize: "4",
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("PARTIAL_FILL_PENDING"));
});

test("accepts exact position size delta reconciliation", () => {
  const decision = reconcileVenueState("perps_close", {
    positionFound: true,
    expectedPositionSize: "1",
    observedPositionSize: "1.0001",
    positionSizeTolerance: "0.001",
  });

  assert.equal(decision.status, "VENUE_RECONCILED");
});

test("flags unsafe Hyperliquid perps risk model output", () => {
  const risk = simulateHyperliquidPerpsRisk({
    input: {
      accountEquityUsd: "100",
      existingNotionalUsd: "0",
      newOrderNotionalUsd: "1000",
      leverage: "20",
      markPrice: "100",
      markPriceObservedAt: new Date().toISOString(),
      liquidationPrice: "99",
      maxSlippageUsd: "2",
      estimatedFeesUsd: "1",
    },
    minMarginRatioBps: 25_000,
    minLiquidationBufferBps: 200,
    maxOracleAgeMs: defaultPolicy.maxOracleAgeMs,
  });

  const simulationPatch = hyperliquidRiskToSimulation(risk, {
    markPriceObservedAt: new Date().toISOString(),
  });
  assert.ok(simulationPatch.venueReasonCodes.includes("MARGIN_RATIO_LIMIT"));
  assert.ok(
    simulationPatch.venueReasonCodes.includes("LIQUIDATION_PRICE_TOO_CLOSE"),
  );
});

test("flags stale Hyperliquid oracle input before perps signing", () => {
  const staleObservedAt = new Date(Date.now() - 60_000).toISOString();
  const risk = simulateHyperliquidPerpsRisk({
    input: {
      accountEquityUsd: "1000",
      existingNotionalUsd: "0",
      newOrderNotionalUsd: "1000",
      leverage: "2",
      markPrice: "100",
      markPriceObservedAt: staleObservedAt,
      liquidationPrice: "60",
    },
    minMarginRatioBps: defaultPolicy.minMarginRatioBps,
    minLiquidationBufferBps: defaultPolicy.minLiquidationBufferBps,
    maxOracleAgeMs: defaultPolicy.maxOracleAgeMs,
  });

  const simulationPatch = hyperliquidRiskToSimulation(risk, {
    markPriceObservedAt: staleObservedAt,
    oracleSource: "hyperliquid-mark-price",
  });

  const current = row({
    actionType: "perps_open",
    dex: "xyz",
    symbol: "spcx",
    side: "long",
    size: "10",
    leverage: "2",
  });

  const reasons = checkTrajectoryInvariants({
    current,
    history: [],
    simulation: {
      ...baseSimulation,
      ...simulationPatch,
    },
    policy: defaultPolicy,
  });

  assert.ok(reasons.includes("ORACLE_PRICE_STALE"));
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
