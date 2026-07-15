import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessLiveStateCReadiness,
  canonicalizeIntent,
  createAnvilSimulator,
  createTenderlySimulator,
  checkTrajectoryInvariants,
  defaultPolicy,
  failClosedSign,
  SafeloopAbort,
} from "../dist/index.js";
import { createSqliteLedger } from "../dist/sqlite-ledger.js";

const WALLET = "0x0000000000000000000000000000000000000001";
const TARGET = "0x0000000000000000000000000000000000000002";

function databasePath(name) {
  return join(mkdtempSync(join(tmpdir(), `mmaw-${name}-`)), "ledger.sqlite");
}

function trustedProductionLedger(overrides = {}) {
  return {
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
      lockFencing: true,
      ownerBoundStatusWrites: true,
    },
    tryLock: async () => true,
    verifyLock: async () => true,
    syncAction: async () => true,
    renewLock: async () => true,
    markStatus: async () => {},
    markStatusOwned: async () => true,
    releaseOwnedLocks: async () => true,
    cleanupPostSignFailure: async () => ({ ok: true, statusPersisted: true }),
    recentForWallet: async () => [],
    ...overrides,
  };
}

function trustedProductionSigner(overrides = {}) {
  return {
    capabilities: {
      intentBoundSignatures: true,
      nonBroadcastingSignatures: true,
      expiringSignatures: true,
      abortableSignatures: true,
    },
    buildUnsignedOperation: async () => ({ to: TARGET }),
    sign: async (operation) => ({ ...operation, signature: "test" }),
    assertSignedOperationMatchesIntent: async () => true,
    ...overrides,
  };
}

function ledgerRow(overrides = {}) {
  const timestamp = overrides.createdAt ?? "2026-07-15T00:00:00.000Z";
  return {
    userGoalId: "goal-1",
    wallet: WALLET,
    chainId: 1,
    actionType: "perps_open",
    accountId: "account-1",
    collateralPoolId: "pool-1",
    timeBucket: "2026-07-15T00:00:00.000Z",
    intentId: "intent-1",
    idempotencyKey: "idem-1",
    status: "LOCKED",
    reasonCodes: [],
    lockScope: "intent:eth-usdc",
    accountLockScope: "account:account-1",
    globalCollateralLockScope: "global:pool-1",
    lockOwnerId: "owner-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test("SQLite ledger persists actions, statuses, locks, and fencing across restart", async () => {
  const path = databasePath("restart");
  let clock = new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 1_000, now: () => clock });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const row = ledgerRow();

  assert.equal(await first.tryLock(row), true);
  assert.equal(row.lockEpoch, 1);
  assert.equal(await first.markStatusOwned(row, "SIMULATED"), true);
  first.close();

  clock = new Date("2026-07-15T00:00:00.100Z");
  const reopened = createSqliteLedger({ path, leaseMs: 1_000, now: () => clock });
  const history = await reopened.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "SIMULATED");
  assert.equal(history[0].lockEpoch, 1);
  assert.equal(await reopened.verifyLock(row), true);
  assert.equal(row.lockedUntil, "2026-07-15T00:00:01.000Z");
  assert.equal(await reopened.renewLock(row), true);
  assert.equal(row.lockedUntil, "2026-07-15T00:00:01.100Z");
  reopened.close();
});

test("two SQLite connections contend atomically across every requested scope", async () => {
  const path = databasePath("contention");
  const now = () => new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 1_000, now });
  const second = createSqliteLedger({ path, leaseMs: 1_000, now });
  const owner = ledgerRow();
  const contender = ledgerRow({
    intentId: "intent-2",
    idempotencyKey: "idem-2",
    lockOwnerId: "owner-2",
    lockScope: "intent:different-market",
  });

  assert.equal(await first.tryLock(owner), true);
  assert.equal(await second.tryLock(contender), false);
  const history = await second.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.deepEqual(history.map((entry) => entry.intentId), ["intent-1"]);
  first.close();
  second.close();
});

test("SQLite ledger disables priority preemption without a trusted verifier", async () => {
  const path = databasePath("priority");
  const now = () => new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 1_000, now });
  const second = createSqliteLedger({ path, leaseMs: 1_000, now });
  const live = ledgerRow({
    status: "SIGNED",
    priority: "low",
    txHash: `0x${"a".repeat(64)}`,
  });
  assert.equal(await first.tryLock(live), true);
  assert.equal(await first.markStatusOwned(live, "SIGNED"), true);
  const emergency = ledgerRow({
    intentId: "intent-emergency",
    idempotencyKey: "idem-e",
    lockOwnerId: "owner-emergency",
    priority: "emergency",
  });
  assert.equal(await second.tryLock(emergency), false);
  first.close();
  second.close();

  const proofPath = databasePath("priority-proof");
  const authorizePreemption = ({ prior }) =>
    prior.preemptionCancelStatus === "ordered" &&
    prior.preemptionCancelOrderSource === "chain" &&
    prior.preemptionCancelRpcQuorum >= 2 &&
    prior.preemptionCancelNonce === 7 &&
    prior.preemptionCancelReplacesTxHash === prior.txHash;
  const proofOwner = createSqliteLedger({
    path: proofPath,
    leaseMs: 1_000,
    now,
    authorizePreemption,
  });
  const proofContender = createSqliteLedger({
    path: proofPath,
    leaseMs: 1_000,
    now,
    authorizePreemption,
  });
  const proven = ledgerRow({
    status: "APPROVED_FOR_SIGNING",
    priority: "low",
    txHash: `0x${"b".repeat(64)}`,
    preemptionCancelStatus: "ordered",
    preemptionCancelOrderSource: "chain",
    preemptionCancelNonce: 7,
    preemptionCancelRpcQuorum: 2,
    preemptionCancelReplacesTxHash: `0x${"b".repeat(64)}`,
    gasReservationStatus: "reserved",
  });
  assert.equal(await proofOwner.tryLock(proven), true);
  assert.equal(
    await proofOwner.markStatusOwned(proven, "APPROVED_FOR_SIGNING"),
    true,
  );
  assert.equal(await proofContender.tryLock(emergency), true);
  const history = await proofContender.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  const preempted = history.find(({ intentId }) => intentId === proven.intentId);
  assert.equal(preempted.status, "ABORTED");
  assert.equal(preempted.gasReservationStatus, "released");
  await assert.rejects(
    () => proofOwner.markStatus(proven.intentId, "SIGNED"),
    { message: "SQLITE_LEDGER_PREEMPTED_ACTION_IMMUTABLE" },
  );
  proofOwner.close();
  proofContender.close();
});

test("trusted preemption callbacks cannot replace live SIGNING or SIGNED owners", async () => {
  for (const status of ["SIGNING", "SIGNED"]) {
    const path = databasePath(`live-${status.toLowerCase()}`);
    let clock = new Date("2026-07-15T00:00:00.000Z");
    const now = () => clock;
    const authorizePreemption = () => true;
    const owner = createSqliteLedger({
      path,
      leaseMs: 1_000,
      now,
      authorizePreemption,
    });
    const contender = createSqliteLedger({
      path,
      leaseMs: 1_000,
      now,
      authorizePreemption,
    });
    const live = ledgerRow({
      status,
      priority: "low",
      txHash: `0x${"c".repeat(64)}`,
      preemptionCancelStatus: "confirmed",
    });
    assert.equal(await owner.tryLock(live), true);
    assert.equal(await owner.markStatusOwned(live, status), true);
    clock = new Date("2026-07-15T00:00:01.001Z");
    assert.equal(await contender.tryLock(ledgerRow({
      intentId: `intent-${status.toLowerCase()}`,
      idempotencyKey: `idem-${status.toLowerCase()}`,
      lockOwnerId: `owner-${status.toLowerCase()}`,
      priority: "emergency",
    })), false);
    assert.equal(await owner.verifyLock(live), false);
    owner.close();
    contender.close();
  }
});

test("SQLite does not advertise deployment-level preemption guarantees", () => {
  const ledger = createSqliteLedger({
    path: databasePath("capabilities"),
    authorizePreemption: () => true,
  });
  assert.equal(ledger.capabilities.priorityLocks, false);
  assert.equal(ledger.capabilities.preemptionCancellation, false);
  ledger.close();
});

test("SQLite rejects unfenced status mutation for owner-bound rows", async () => {
  const ledger = createSqliteLedger({ path: databasePath("owned-status") });
  const row = ledgerRow({ createdAt: new Date().toISOString() });
  assert.equal(await ledger.tryLock(row), true);
  await assert.rejects(
    () => ledger.markStatus(row.intentId, "CONFIRMED"),
    { message: "SQLITE_LEDGER_OWNER_REQUIRED" },
  );
  assert.equal(await ledger.verifyLock(row), true);
  ledger.close();
});

test("expired SIGNING leases remain shadowed without cancellation proof", async () => {
  const path = databasePath("signing-shadow");
  let clock = new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 100, now: () => clock });
  const second = createSqliteLedger({ path, leaseMs: 100, now: () => clock });
  const signing = ledgerRow();
  assert.equal(await first.tryLock(signing), true);
  assert.equal(await first.markStatusOwned(signing, "SIGNING"), true);
  clock = new Date("2026-07-15T00:00:00.101Z");
  assert.equal(await second.tryLock(ledgerRow({
    intentId: "intent-2",
    idempotencyKey: "idem-2",
    lockOwnerId: "owner-2",
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
  })), false);
  first.close();
  second.close();
});

test("renewal preserves authoritative SIGNING state and cannot enable split-brain preemption", async () => {
  const path = databasePath("renew-authoritative");
  const now = () => new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 1_000, now });
  const second = createSqliteLedger({ path, leaseMs: 1_000, now });
  const signing = ledgerRow({ priority: "low" });
  assert.equal(await first.tryLock(signing), true);
  assert.equal(await first.markStatusOwned(signing, "SIGNING"), true);
  assert.equal(await first.renewLock(signing), true);

  const emergency = ledgerRow({
    intentId: "intent-emergency",
    idempotencyKey: "idem-emergency",
    lockOwnerId: "owner-emergency",
    priority: "emergency",
  });
  assert.equal(await second.tryLock(emergency), false);
  const [persisted] = await first.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.equal(persisted.status, "SIGNING");
  first.close();
  second.close();
});

test("expired leases are fenced and stale owners cannot release the successor", async () => {
  const path = databasePath("fencing");
  let clock = new Date("2026-07-15T00:00:00.000Z");
  const first = createSqliteLedger({ path, leaseMs: 100, now: () => clock });
  const second = createSqliteLedger({ path, leaseMs: 100, now: () => clock });
  const stale = ledgerRow();
  assert.equal(await first.tryLock(stale), true);

  clock = new Date("2026-07-15T00:00:00.101Z");
  const successor = ledgerRow({
    intentId: "intent-2",
    idempotencyKey: "idem-2",
    lockOwnerId: "owner-2",
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
  });
  assert.equal(await second.tryLock(successor), true);
  assert.ok(successor.lockEpoch > stale.lockEpoch);
  assert.equal(await first.verifyLock(stale), false);
  assert.deepEqual(
    await first.cleanupPostSignFailure({
      row: stale,
      reasonCodes: ["SIGNED_OPERATION_INTENT_MISMATCH"],
      signedOperation: { mustNotPersist: "signed-payload" },
    }),
    { ok: false, reasonCodes: ["LOCK_OWNERSHIP_LOST"] },
  );
  assert.equal(await second.verifyLock(successor), true);
  assert.deepEqual(
    await second.cleanupPostSignFailure({
      row: successor,
      reasonCodes: ["SIGNED_OPERATION_INTENT_MISMATCH"],
      signedOperation: { mustNotPersist: "signed-payload" },
    }),
    { ok: true, statusPersisted: true },
  );
  first.close();
  second.close();
});

function riskEvidence(now) {
  return {
    preNavUsd: "1000",
    postNavUsd: "999.5",
    gasUsd: "0.25",
    slippageUsd: "0.25",
    maxLossUsd: "25",
    signatureExpiresAt: new Date(now.getTime() + 10_000).toISOString(),
    oracleMonotonicAgeMs: 10,
    clockSkewMs: 5,
    timeCalibrationSource: "durable",
    timeCalibrationSyncedAt: now.toISOString(),
    timeCalibrationRoundTripMs: 20,
  };
}

function rpcFetch(results, requests) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const result = results[request.method];
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function canonicalIntent() {
  return {
    userGoalId: "simulate-1",
    wallet: WALLET,
    chainId: 1,
    actionType: "transfer",
    assetOut: "eth",
    amountIn: "1",
    targetContract: TARGET,
    timeBucket: "2026-07-15T00:00:00.000Z",
  };
}

test("Anvil adapter sends exact read-only RPC envelopes and returns supplied risk evidence", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const requests = [];
  const simulator = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid/private-token",
    chainId: 1,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: rpcFetch(
      { eth_chainId: "0x1", eth_call: "0x", eth_estimateGas: "0x5208" },
      requests,
    ),
  });
  const operation = { from: WALLET, to: TARGET, data: "0x", value: "0x0" };
  const result = await simulator.simulate(operation, canonicalIntent());

  assert.equal(result.status, "passed");
  assert.deepEqual(requests, [
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [operation, "latest"],
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "eth_estimateGas",
      params: [operation],
    },
  ]);
  assert.ok(requests.every(({ method }) => !method.startsWith("eth_send")));
});

test("Tenderly adapter uses tenderly_simulateTransaction and never broadcasts", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const requests = [];
  const simulator = createTenderlySimulator({
    rpcUrl: "https://tenderly.invalid/account/project/access-key",
    chainId: 1,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: rpcFetch(
      {
        eth_chainId: "0x1",
        tenderly_simulateTransaction: { status: true, gasUsed: 21_000 },
      },
      requests,
    ),
  });
  const operation = { from: WALLET, to: TARGET, data: "0x" };
  assert.equal(
    (await simulator.simulate(operation, canonicalIntent())).status,
    "passed",
  );
  assert.deepEqual(requests.map(({ method }) => method), [
    "eth_chainId",
    "tenderly_simulateTransaction",
  ]);
  assert.deepEqual(requests[1].params, [operation, "latest"]);
  assert.ok(requests.every(({ method }) => !method.startsWith("eth_send")));
});

test("Tenderly adapter rejects ambiguous success without an explicit status", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const simulator = createTenderlySimulator({
    rpcUrl: "https://tenderly.invalid/private",
    chainId: 1,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: rpcFetch(
      { eth_chainId: "0x1", tenderly_simulateTransaction: { gasUsed: 21_000 } },
      [],
    ),
  });
  await assert.rejects(
    () => simulator.simulate({ from: WALLET, to: TARGET }, canonicalIntent()),
    { message: "SIMULATOR_RPC_INVALID_RESULT" },
  );
});

test("EVM simulators reject non-EVM perps intents before risk evidence", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  let evidenceCalls = 0;
  const simulator = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid",
    chainId: 1,
    now: () => now,
    riskEvidence: () => {
      evidenceCalls += 1;
      return riskEvidence(now);
    },
    fetch: rpcFetch({}, []),
  });
  await assert.rejects(
    () => simulator.simulate(
      { from: WALLET, to: TARGET, data: "0x" },
      { ...canonicalIntent(), actionType: "perps_open" },
    ),
    { message: "SIMULATOR_NON_EVM_ACTION_UNSUPPORTED" },
  );
  assert.equal(evidenceCalls, 0);
});

test("risk evidence cannot mutate the operation that was simulated", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const requests = [];
  const operation = { from: WALLET, to: TARGET, data: "0x" };
  const simulator = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid",
    chainId: 1,
    now: () => now,
    riskEvidence: ({ operation: evidenceOperation }) => {
      evidenceOperation.to = WALLET;
      return riskEvidence(now);
    },
    fetch: rpcFetch({
      eth_chainId: "0x1",
      eth_call: "0x",
      eth_estimateGas: "0x5208",
    }, requests),
  });
  assert.equal(
    (await simulator.simulate(operation, canonicalIntent())).status,
    "passed",
  );
  assert.equal(operation.to, TARGET);
  assert.equal(requests[1].params[0].to, TARGET);
  assert.equal(requests[2].params[0].to, TARGET);
});

test("perps trajectories require complete solvency and gas evidence", () => {
  const now = new Date();
  const reasons = checkTrajectoryInvariants({
    current: ledgerRow({
      actionType: "perps_open",
      venue: "hyperliquid",
      status: "SIMULATED",
      lockedUntil: new Date(now.getTime() + 60_000).toISOString(),
    }),
    history: [],
    simulation: {
      ...riskEvidence(now),
      status: "passed",
      venueSimulation: "hyperliquid-api",
      oracleObservedAt: now.toISOString(),
      marginRatioBps: 20_000,
      liquidationBufferBps: 1_000,
      accountMarginRatioBps: 20_000,
      accountLiquidationBufferBps: 1_000,
      accountExposureUsd: "100",
      gasRunwayTransactions: 10,
    },
    policy: { ...defaultPolicy, supportedChainIds: [1] },
  });
  assert.ok(!reasons.includes("MARGIN_RATIO_LIMIT"));
  assert.ok(!reasons.includes("LIQUIDATION_PRICE_TOO_CLOSE"));
  assert.ok(!reasons.includes("ACCOUNT_HEALTH_LIMIT"));
  assert.ok(reasons.includes("GAS_RUNWAY_LOW"));
  assert.ok(reasons.includes("GAS_BURN_RATE_LIMIT"));
});

test("intent ingress and SQLite history have deterministic resource bounds", () => {
  assert.throws(
    () => canonicalizeIntent({
      userGoalId: "oversized-intent",
      wallet: WALLET,
      chainId: 1,
      actionType: "swap",
      route: Array.from({ length: 65 }, () => TARGET),
    }),
    { message: "INVALID_INTENT_BOUNDS" },
  );
});

test("simulators fail closed on chain mismatch, missing evidence, and oversized responses", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const operation = { from: WALLET, to: TARGET, data: "0x" };
  const mismatch = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid/secret",
    chainId: 1,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: rpcFetch({ eth_chainId: "0x2" }, []),
  });
  await assert.rejects(
    () => mismatch.simulate(operation, canonicalIntent()),
    { message: "SIMULATOR_CHAIN_MISMATCH" },
  );

  const missing = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid/secret",
    chainId: 1,
    now: () => now,
    riskEvidence: () => null,
    fetch: rpcFetch(
      { eth_chainId: "0x1", eth_call: "0x", eth_estimateGas: "0x5208" },
      [],
    ),
  });
  await assert.rejects(
    () => missing.simulate(operation, canonicalIntent()),
    { message: "SIMULATOR_RISK_EVIDENCE_REQUIRED" },
  );

  const oversized = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid/raw-credential",
    chainId: 1,
    maxResponseBytes: 64,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: async () =>
      new Response("x".repeat(65), {
        status: 200,
        headers: { "content-length": "65" },
      }),
  });
  await assert.rejects(
    () => oversized.simulate(operation, canonicalIntent()),
    (error) =>
      error.message === "SIMULATOR_RPC_RESPONSE_TOO_LARGE" &&
      !error.message.includes("raw-credential"),
  );

  const timedOut = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid/timeout-secret",
    chainId: 1,
    timeoutMs: 10,
    now: () => now,
    riskEvidence: () => riskEvidence(now),
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      }),
  });
  await assert.rejects(
    () => timedOut.simulate(operation, canonicalIntent()),
    (error) =>
      error.message === "SIMULATOR_RPC_TIMEOUT" &&
      !error.message.includes("timeout-secret"),
  );
});

test("simulators bound risk evidence latency and reject non-finite optional evidence", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const rpcResults = {
    eth_chainId: "0x1",
    eth_call: "0x",
    eth_estimateGas: "0x5208",
  };
  const operation = { from: WALLET, to: TARGET, data: "0x" };
  const hanging = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid",
    chainId: 1,
    timeoutMs: 10,
    now: () => now,
    riskEvidence: () => new Promise(() => {}),
    fetch: rpcFetch(rpcResults, []),
  });
  await assert.rejects(
    () => hanging.simulate(operation, canonicalIntent()),
    { message: "SIMULATOR_RISK_EVIDENCE_UNAVAILABLE" },
  );

  const nanEvidence = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid",
    chainId: 1,
    now: () => now,
    riskEvidence: () => ({ ...riskEvidence(now), marginRatioBps: NaN }),
    fetch: rpcFetch(rpcResults, []),
  });
  await assert.rejects(
    () => nanEvidence.simulate(operation, canonicalIntent()),
    { message: "SIMULATOR_FINANCIAL_EVIDENCE_REQUIRED" },
  );
});

test("risk evidence timeout aborts the provider work", async () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  let providerAborted = false;
  const simulator = createAnvilSimulator({
    rpcUrl: "http://anvil.invalid",
    chainId: 1,
    timeoutMs: 10,
    now: () => now,
    riskEvidence: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        providerAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
    fetch: rpcFetch({
      eth_chainId: "0x1",
      eth_call: "0x",
      eth_estimateGas: "0x5208",
    }, []),
  });
  await assert.rejects(
    () => simulator.simulate(
      { from: WALLET, to: TARGET, data: "0x" },
      canonicalIntent(),
    ),
    { message: "SIMULATOR_RISK_EVIDENCE_UNAVAILABLE" },
  );
  assert.equal(providerAborted, true);
});

function stateCInput(now) {
  return {
    now,
    ledger: {
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
        lockFencing: true,
        ownerBoundStatusWrites: true,
      },
      tryLock: async () => true,
      verifyLock: async () => true,
      syncAction: async () => true,
      renewLock: async () => true,
      markStatus: async () => {},
      markStatusOwned: async () => true,
      releaseOwnedLocks: async () => true,
      cleanupPostSignFailure: async () => ({ ok: true, statusPersisted: true }),
      recentForWallet: async () => [],
    },
    signer: {
      capabilities: {
        intentBoundSignatures: true,
        nonBroadcastingSignatures: true,
        expiringSignatures: true,
        abortableSignatures: true,
      },
      buildUnsignedOperation: async () => ({}),
      sign: async () => ({}),
      assertSignedOperationMatchesIntent: async () => true,
    },
    simulator: {
      capabilities: {
        nonBroadcasting: true,
        chainIdentityEnforced: true,
        boundedRpc: true,
        durableRiskEvidenceRequired: true,
        supportedChainIds: [1],
      },
      simulate: async () => ({ status: "unavailable" }),
    },
    policy: { ...defaultPolicy, supportedChainIds: [1] },
    rpcProbe: { ok: true, chainId: 1, checkedAt: now.toISOString() },
    timeCalibration: {
      source: "durable",
      syncedAt: now.toISOString(),
      roundTripMs: 20,
      clockSkewMs: 5,
    },
  };
}

test("live State C readiness is explicit, pure, and fail-closed", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const readyInput = stateCInput(now);
  assert.deepEqual(assessLiveStateCReadiness(readyInput), {
    ready: true,
    state: "STATE_C_READY",
    checkedAt: now.toISOString(),
    reasonCodes: [],
  });

  const blockedInput = stateCInput(now);
  blockedInput.signer.capabilities.expiringSignatures = false;
  blockedInput.rpcProbe.chainId = 10;
  blockedInput.timeCalibration.source = "local";
  const blocked = assessLiveStateCReadiness(blockedInput);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.state, "STATE_C_BLOCKED");
  assert.ok(blocked.reasonCodes.includes("EXPIRING_SIGNATURES_REQUIRED"));
  assert.ok(blocked.reasonCodes.includes("RPC_CHAIN_MISMATCH"));
  assert.ok(blocked.reasonCodes.includes("DURABLE_TIME_CALIBRATION_REQUIRED"));

  const nonAbortable = stateCInput(now);
  nonAbortable.signer.capabilities.abortableSignatures = false;
  assert.ok(
    assessLiveStateCReadiness(nonAbortable).reasonCodes.includes(
      "ABORTABLE_SIGNER_REQUIRED",
    ),
  );

  const invalidWindow = stateCInput(now);
  invalidWindow.maxRpcProbeAgeMs = Number.POSITIVE_INFINITY;
  assert.ok(
    assessLiveStateCReadiness(invalidWindow).reasonCodes.includes(
      "RPC_PROBE_STALE",
    ),
  );

  const multiChain = stateCInput(now);
  multiChain.policy.supportedChainIds = [1, 10];
  multiChain.simulator.capabilities.supportedChainIds = [1, 10];
  assert.ok(
    assessLiveStateCReadiness(multiChain).reasonCodes.includes(
      "MULTI_CHAIN_PROBES_REQUIRED",
    ),
  );

  const invalidClock = stateCInput(now);
  invalidClock.now = new Date(Number.NaN);
  const invalidClockResult = assessLiveStateCReadiness(invalidClock);
  assert.equal(invalidClockResult.state, "STATE_C_BLOCKED");
  assert.ok(invalidClockResult.reasonCodes.includes("INVALID_CLOCK"));
});

test("live State C readiness rejects runtime type confusion without throwing", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const malformed = assessLiveStateCReadiness(null);
  assert.equal(malformed.ready, false);
  assert.ok(malformed.reasonCodes.includes("INVALID_INPUT"));

  const stringClock = stateCInput(now);
  stringClock.now = now.toISOString();
  const clockResult = assessLiveStateCReadiness(stringClock);
  assert.equal(clockResult.ready, false);
  assert.ok(clockResult.reasonCodes.includes("INVALID_CLOCK"));

  for (const malformedClock of [
    Object.create(Date.prototype),
    new Proxy(new Date(now), {}),
  ]) {
    const malformedClockInput = stateCInput(now);
    malformedClockInput.now = malformedClock;
    assert.doesNotThrow(() => assessLiveStateCReadiness(malformedClockInput));
    assert.ok(
      assessLiveStateCReadiness(malformedClockInput).reasonCodes.includes(
        "INVALID_CLOCK",
      ),
    );
  }

  const falseStringProbe = stateCInput(now);
  falseStringProbe.rpcProbe.ok = "false";
  const probeResult = assessLiveStateCReadiness(falseStringProbe);
  assert.equal(probeResult.ready, false);
  assert.ok(probeResult.reasonCodes.includes("RPC_PROBE_REQUIRED"));

  const stringChain = stateCInput(now);
  stringChain.rpcProbe.chainId = "1";
  const chainResult = assessLiveStateCReadiness(stringChain);
  assert.equal(chainResult.ready, false);
  assert.ok(chainResult.reasonCodes.includes("RPC_CHAIN_MISMATCH"));

  const stringCalibration = stateCInput(now);
  stringCalibration.timeCalibration.roundTripMs = "20";
  const calibrationResult = assessLiveStateCReadiness(stringCalibration);
  assert.equal(calibrationResult.ready, false);
  assert.ok(
    calibrationResult.reasonCodes.includes("TIME_CALIBRATION_UNSAFE"),
  );

  for (const policyOverride of [
    { lockLeaseMs: 0.5 },
    { maxSignatureTtlMs: Number.MAX_VALUE },
    { maxSignatureTtlMs: 300_001 },
    { maxSignatureTtlMs: 10_000, maxClockSkewMs: 10_000 },
  ]) {
    const invalidPolicy = stateCInput(now);
    Object.assign(invalidPolicy.policy, policyOverride);
    const result = assessLiveStateCReadiness(invalidPolicy);
    assert.equal(result.ready, false);
    assert.ok(result.reasonCodes.includes("STATE_C_POLICY_INCOMPLETE"));
  }
});

test("built-in SQLite ledger blocks State C until trusted gas and preemption adapters exist", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const input = stateCInput(now);
  const ledger = createSqliteLedger({
    path: databasePath("readiness"),
    now: () => now,
  });
  input.ledger = ledger;
  const result = assessLiveStateCReadiness(input);
  assert.equal(result.ready, false);
  assert.ok(result.reasonCodes.includes("LEDGER_CAPABILITIES_INCOMPLETE"));
  ledger.close();
});

test("SQLite persistence blocks duplicate signing across restart", async () => {
  const path = databasePath("sign-integration");
  const ledger = createSqliteLedger({ path });
  const intent = {
    userGoalId: "sqlite-signing-integration",
    wallet: WALLET,
    chainId: 1,
    actionType: "transfer",
    assetOut: "ETH",
    amountIn: "1",
    targetContract: TARGET,
  };
  const signer = {
    capabilities: {
      intentBoundSignatures: true,
      nonBroadcastingSignatures: true,
      expiringSignatures: true,
      abortableSignatures: true,
    },
    buildUnsignedOperation: async (canonical) => ({ canonical }),
    sign: async (unsigned) => ({ unsigned, signature: "test-only" }),
    assertSignedOperationMatchesIntent: async ({ intent: approved, signedOperation }) =>
      signedOperation.unsigned.canonical.userGoalId === approved.userGoalId,
  };
  const simulator = {
    simulate: async () => {
      const now = new Date();
      return {
        status: "passed",
        preNavUsd: "1000",
        postNavUsd: "1000",
        gasUsd: "0.1",
        slippageUsd: "0",
        maxLossUsd: "25",
        signatureExpiresAt: new Date(now.getTime() + 10_000).toISOString(),
        oracleMonotonicAgeMs: 10,
        clockSkewMs: 0,
        timeCalibrationSource: "durable",
        timeCalibrationSyncedAt: now.toISOString(),
        timeCalibrationRoundTripMs: 10,
      };
    },
  };

  const signed = await failClosedSign({
    intent,
    ledger,
    mmaw: signer,
    simulator,
    policy: { supportedChainIds: [1], requireDurableLedger: false },
  });
  assert.equal(signed.signature, "test-only");
  ledger.close();

  const reopened = createSqliteLedger({ path });
  const historyBeforeRetry = await reopened.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.equal(historyBeforeRetry.length, 1);
  assert.equal(historyBeforeRetry[0].status, "SIGNED");
  assert.ok(Date.parse(historyBeforeRetry[0].signatureExpiresAt) > 0);

  await assert.rejects(
    () => failClosedSign({
      intent,
      ledger: reopened,
      mmaw: signer,
      simulator,
      policy: { supportedChainIds: [1], requireDurableLedger: false },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("LEDGER_LOCK_CONFLICT"),
  );
  const historyAfterRetry = await reopened.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.equal(historyAfterRetry.length, 1);
  assert.equal(historyAfterRetry[0].status, "SIGNED");
  reopened.close();
});

test("production failClosedSign requires signer expiry capability before locking", async () => {
  let lockCalls = 0;
  let signCalls = 0;
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
      lockFencing: true,
      ownerBoundStatusWrites: true,
    },
    tryLock: async () => { lockCalls += 1; return true; },
    verifyLock: async () => true,
    renewLock: async () => true,
    markStatus: async () => {},
    markStatusOwned: async () => true,
    releaseOwnedLocks: async () => true,
    recentForWallet: async () => [],
  };
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "expiry-preflight",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
      },
      ledger,
      mmaw: {
        capabilities: {
          intentBoundSignatures: true,
          nonBroadcastingSignatures: true,
          expiringSignatures: false,
          abortableSignatures: true,
        },
        buildUnsignedOperation: async () => ({}),
        sign: async () => { signCalls += 1; return {}; },
        assertSignedOperationMatchesIntent: async () => true,
      },
      simulator: { simulate: async () => ({ status: "passed" }) },
      policy: { supportedChainIds: [1] },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNATURE_EXPIRY_REQUIRED"),
  );
  assert.equal(lockCalls, 0);
  assert.equal(signCalls, 0);
});

test("legacy non-durable signing remains compatible without expiry capability", async () => {
  const statuses = [];
  const ledger = {
    tryLock: async () => true,
    verifyLock: async () => true,
    renewLock: async () => true,
    markStatus: async (_intentId, status) => statuses.push(status),
    recentForWallet: async () => [],
  };
  const signed = await failClosedSign({
    intent: {
      userGoalId: "legacy-no-expiry-capability",
      wallet: WALLET,
      chainId: 1,
      actionType: "transfer",
      assetOut: "ETH",
    },
    ledger,
    mmaw: {
      capabilities: {
        intentBoundSignatures: true,
        nonBroadcastingSignatures: true,
      },
      buildUnsignedOperation: async () => ({}),
      sign: async () => ({ signature: "legacy-test" }),
      assertSignedOperationMatchesIntent: async () => true,
    },
    simulator: {
      simulate: async () => ({
        status: "passed",
        signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    },
    policy: {
      supportedChainIds: [1],
      requireDurableLedger: false,
    },
  });
  assert.equal(signed.signature, "legacy-test");
  assert.equal(statuses.at(-1), "SIGNED");
});

test("production signing requires owner-bound status writes before locking", async () => {
  let lockCalls = 0;
  let signCalls = 0;
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
      lockFencing: true,
    },
    tryLock: async () => { lockCalls += 1; return true; },
    verifyLock: async () => true,
    markStatus: async () => {},
    recentForWallet: async () => [],
  };
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "owner-bound-status",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
      },
      ledger,
      mmaw: {
        capabilities: {
          intentBoundSignatures: true,
          nonBroadcastingSignatures: true,
          expiringSignatures: true,
          abortableSignatures: true,
        },
        buildUnsignedOperation: async () => ({}),
        sign: async () => { signCalls += 1; return {}; },
        assertSignedOperationMatchesIntent: async () => true,
      },
      simulator: { simulate: async () => ({ status: "passed" }) },
      policy: { supportedChainIds: [1] },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("OWNER_BOUND_STATUS_WRITE_REQUIRED"),
  );
  assert.equal(lockCalls, 0);
  assert.equal(signCalls, 0);
});

test("production signing returns the validated snapshot, not a mutable assertion object", async () => {
  const statuses = [];
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
      lockFencing: true,
      ownerBoundStatusWrites: true,
    },
    tryLock: async () => true,
    verifyLock: async () => true,
    renewLock: async () => true,
    syncAction: async () => true,
    markStatus: async () => {},
    markStatusOwned: async (_row, status) => {
      statuses.push(status);
      return true;
    },
    releaseOwnedLocks: async () => true,
    cleanupPostSignFailure: async () => ({ ok: true, statusPersisted: true }),
    recentForWallet: async () => [],
  };
  const signed = await failClosedSign({
    intent: {
      userGoalId: "signed-snapshot",
      wallet: WALLET,
      chainId: 1,
      actionType: "transfer",
      assetOut: "ETH",
      targetContract: TARGET,
    },
    ledger,
    mmaw: {
      capabilities: {
        intentBoundSignatures: true,
        nonBroadcastingSignatures: true,
        expiringSignatures: true,
        abortableSignatures: true,
      },
      buildUnsignedOperation: async () => ({ to: TARGET }),
      sign: async (unsigned) => ({ ...unsigned, signature: "test" }),
      assertSignedOperationMatchesIntent: ({ signedOperation }) => {
        assert.equal(signedOperation.to, TARGET);
        queueMicrotask(() => { signedOperation.to = WALLET; });
        return true;
      },
    },
    simulator: {
      simulate: async () => ({
        status: "passed",
        signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    },
    policy: { supportedChainIds: [1] },
  });
  assert.equal(signed.to, TARGET);
  assert.equal(statuses.at(-1), "SIGNED");
});

test("production signing never exposes the authoritative canonical intent", async () => {
  let cleanupCalls = 0;
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
      lockFencing: true,
      ownerBoundStatusWrites: true,
    },
    tryLock: async () => true,
    verifyLock: async () => true,
    renewLock: async () => true,
    syncAction: async () => true,
    markStatus: async () => {},
    markStatusOwned: async () => true,
    releaseOwnedLocks: async () => true,
    cleanupPostSignFailure: async () => {
      cleanupCalls += 1;
      return { ok: true, statusPersisted: true };
    },
    recentForWallet: async () => [],
  };
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "canonical-intent-snapshot",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
        targetContract: TARGET,
      },
      ledger,
      mmaw: {
        capabilities: {
          intentBoundSignatures: true,
          nonBroadcastingSignatures: true,
          expiringSignatures: true,
          abortableSignatures: true,
        },
        buildUnsignedOperation: async (intent) => {
          intent.targetContract = WALLET;
          return { to: intent.targetContract };
        },
        sign: async (unsigned) => ({ ...unsigned, signature: "test" }),
        assertSignedOperationMatchesIntent: ({ intent, signedOperation }) =>
          signedOperation.to === intent.targetContract,
      },
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        }),
      },
      policy: { supportedChainIds: [1] },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNED_OPERATION_INTENT_MISMATCH"),
  );
  assert.equal(cleanupCalls, 1);
});

test("post-sign lease loss is fenced before a signed payload can return", async () => {
  const path = databasePath("post-sign-fence");
  const wallClock = new Date();
  let clock = wallClock;
  const ledger = createSqliteLedger({ path, leaseMs: 100, now: () => clock });
  const cleanupPostSignFailure = ledger.cleanupPostSignFailure;
  let cleanupCalls = 0;
  ledger.cleanupPostSignFailure = async (params) => {
    cleanupCalls += 1;
    return cleanupPostSignFailure(params);
  };
  let signCalls = 0;
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "post-sign-fence",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: {
        capabilities: {
          intentBoundSignatures: true,
          nonBroadcastingSignatures: true,
          expiringSignatures: true,
          abortableSignatures: true,
        },
        buildUnsignedOperation: async () => ({}),
        sign: async () => {
          signCalls += 1;
          clock = new Date(wallClock.getTime() + 101);
          return { signature: "must-not-return" };
        },
        assertSignedOperationMatchesIntent: async () => true,
      },
      simulator: {
        simulate: async () => ({
          status: "passed",
          preNavUsd: "100",
          postNavUsd: "100",
          gasUsd: "0.1",
          slippageUsd: "0",
          maxLossUsd: "25",
          signatureExpiresAt: new Date(wallClock.getTime() + 10_000).toISOString(),
          oracleMonotonicAgeMs: 1,
          clockSkewMs: 0,
          timeCalibrationSource: "durable",
          timeCalibrationSyncedAt: wallClock.toISOString(),
          timeCalibrationRoundTripMs: 1,
        }),
      },
      policy: { supportedChainIds: [1], requireDurableLedger: false },
    }),
    (error) => {
      assert.ok(error instanceof SafeloopAbort);
      assert.ok(error.reasonCodes.includes("LOCK_OWNERSHIP_LOST"));
      assert.ok(error.reasonCodes.includes("POST_SIGN_CLEANUP_REQUIRED"));
      return true;
    },
  );
  assert.equal(signCalls, 1);
  assert.equal(cleanupCalls, 1);
  const [persisted] = await ledger.recentForWallet({
    wallet: WALLET,
    chainId: 1,
    lookbackMinutes: 10,
  });
  assert.equal(persisted.status, "SIGNING");
  ledger.close();
});

test("pre-sign terminal failure releases every owned SQLite scope", async () => {
  const ledger = createSqliteLedger({ path: databasePath("terminal-release") });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "terminal-release",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: {
        capabilities: {
          intentBoundSignatures: true,
          nonBroadcastingSignatures: true,
        },
        buildUnsignedOperation: async () => ({ to: TARGET }),
        sign: async () => ({ signature: "must-not-run" }),
        assertSignedOperationMatchesIntent: async () => true,
      },
      simulator: { simulate: async () => { throw new Error("test"); } },
      policy: {
        supportedChainIds: [1],
        requireDurableLedger: false,
        requireExpiringSignatures: false,
      },
    }),
    { message: "test" },
  );
  const contender = ledgerRow({
    actionType: "transfer",
    intentId: "terminal-contender",
    idempotencyKey: "terminal-contender-idem",
    lockOwnerId: "terminal-contender-owner",
    lockScope: `${WALLET}:1:evm:main:eth`,
    accountLockScope: undefined,
    globalCollateralLockScope: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(await ledger.tryLock(contender), true);
  ledger.close();
});

test("SQLite history fails closed instead of silently truncating risk rows", async () => {
  const now = new Date("2026-07-16T00:00:00.000Z");
  const ledger = createSqliteLedger({
    path: databasePath("history-overflow"),
    now: () => now,
  });
  for (let index = 0; index < 1_001; index += 1) {
    const row = ledgerRow({
      actionType: "transfer",
      userGoalId: `history-${index}`,
      intentId: `history-${index}`,
      idempotencyKey: `history-${index}`,
      lockOwnerId: `owner-${index}`,
      lockScope: `scope-${index}`,
      accountLockScope: undefined,
      globalCollateralLockScope: undefined,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    assert.equal(await ledger.tryLock(row), true);
  }
  await assert.rejects(
    () => ledger.recentForWallet({
      wallet: WALLET,
      chainId: 1,
      lookbackMinutes: 10,
    }),
    { message: "SQLITE_LEDGER_HISTORY_LIMIT_EXCEEDED" },
  );
  ledger.close();
});

test("unexpected history failures release owner-bound pre-sign locks", async () => {
  let releaseCalls = 0;
  const ledger = trustedProductionLedger({
    recentForWallet: async () => { throw new Error("HISTORY_DOWN"); },
    releaseOwnedLocks: async () => { releaseCalls += 1; return true; },
  });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "history-failure-cleanup",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: trustedProductionSigner(),
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        }),
      },
      policy: { supportedChainIds: [1] },
    }),
    { message: "HISTORY_DOWN" },
  );
  assert.equal(releaseCalls, 1);
});

test("production signing aborts at a bounded deadline and releases locks", async () => {
  let signalAborted = false;
  let releaseCalls = 0;
  const ledger = trustedProductionLedger({
    releaseOwnedLocks: async () => { releaseCalls += 1; return true; },
  });
  const signer = trustedProductionSigner({
    sign: async (_operation, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "bounded-signing",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: signer,
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 50).toISOString(),
        }),
      },
      policy: {
        supportedChainIds: [1],
        maxSignatureTtlMs: 50,
        maxClockSkewMs: 1,
        lockLeaseMs: 1_000,
      },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNING_TIMEOUT"),
  );
  assert.equal(signalAborted, true);
  assert.equal(releaseCalls, 1);
});

test("unacknowledged signer abort keeps the durable SIGNING shadow", async () => {
  let releaseCalls = 0;
  const ledger = trustedProductionLedger({
    releaseOwnedLocks: async () => { releaseCalls += 1; return true; },
  });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "unacknowledged-abort",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: trustedProductionSigner({
        sign: async () => new Promise(() => {}),
      }),
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 30).toISOString(),
        }),
      },
      policy: {
        supportedChainIds: [1],
        maxSignatureTtlMs: 30,
        maxClockSkewMs: 1,
        lockLeaseMs: 1_000,
      },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNER_ABORT_UNACKNOWLEDGED"),
  );
  assert.equal(releaseCalls, 0);
});

test("signing deadline uses the authoritative renewed lease expiry", async () => {
  let signalAborted = false;
  const ledger = trustedProductionLedger({
    renewLock: async (row) => {
      row.lockedUntil = new Date(Date.now() + 25).toISOString();
      return true;
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "renewed-lease-deadline",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: trustedProductionSigner({
        sign: async (_operation, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }),
      }),
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 1_000).toISOString(),
        }),
      },
      policy: {
        supportedChainIds: [1],
        maxSignatureTtlMs: 1_000,
        maxClockSkewMs: 1,
        lockLeaseMs: 1_000,
      },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNING_TIMEOUT"),
  );
  assert.equal(signalAborted, true);
  assert.ok(Date.now() - startedAt < 250);
});

test("timed-out signed payload keeps SIGNING shadow when cleanup is unproven", async () => {
  const statuses = [];
  const ledger = trustedProductionLedger({
    markStatusOwned: async (_row, status) => {
      statuses.push(status);
      return true;
    },
    cleanupPostSignFailure: async () => ({ ok: false }),
  });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "timeout-cleanup-shadow",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: trustedProductionSigner({
        sign: async (_operation, { signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ signature: "late-but-live" });
          }, { once: true });
        }),
      }),
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 35).toISOString(),
        }),
      },
      policy: {
        supportedChainIds: [1],
        maxSignatureTtlMs: 35,
        maxClockSkewMs: 2,
        lockLeaseMs: 1_000,
      },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNING_TIMEOUT") &&
      error.reasonCodes.includes("POST_SIGN_CLEANUP_REQUIRED"),
  );
  assert.equal(statuses.at(-1), "SIGNING");
});

test("production snapshots reject shared memory and preserve Buffer bytes", async () => {
  let cleanupCalls = 0;
  const sharedLedger = trustedProductionLedger({
    cleanupPostSignFailure: async () => {
      cleanupCalls += 1;
      return { ok: true, statusPersisted: true };
    },
  });
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "shared-signed-memory",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger: sharedLedger,
      mmaw: trustedProductionSigner({
        sign: async () => new Uint8Array(new SharedArrayBuffer(8)),
      }),
      simulator: {
        simulate: async () => ({
          status: "passed",
          signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        }),
      },
      policy: { supportedChainIds: [1] },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNED_OPERATION_SNAPSHOT_REQUIRED"),
  );
  assert.equal(cleanupCalls, 1);

  const returned = await failClosedSign({
    intent: {
      userGoalId: "buffer-signed-memory",
      wallet: WALLET,
      chainId: 1,
      actionType: "transfer",
      assetOut: "ETH",
    },
    ledger: trustedProductionLedger(),
    mmaw: trustedProductionSigner({
      sign: async () => Buffer.from("signed"),
      assertSignedOperationMatchesIntent: ({ signedOperation }) =>
        Buffer.isBuffer(signedOperation),
    }),
    simulator: {
      simulate: async () => ({
        status: "passed",
        signatureExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    },
    policy: { supportedChainIds: [1] },
  });
  assert.equal(Buffer.isBuffer(returned), true);
  assert.equal(returned.toString(), "signed");
});

test("runtime intent schema rejects unsupported actions before locking", async () => {
  let lockCalls = 0;
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "unsupported-action",
        wallet: WALLET,
        chainId: 1,
        actionType: "arbitrary_sign",
      },
      ledger: trustedProductionLedger({
        tryLock: async () => { lockCalls += 1; return true; },
      }),
      mmaw: trustedProductionSigner(),
      simulator: { simulate: async () => ({ status: "passed" }) },
      policy: { supportedChainIds: [1] },
    }),
    { message: "INVALID_INTENT_SCHEMA" },
  );
  assert.equal(lockCalls, 0);
});

test("readiness blocks exotic dates and throwing proxies without throwing", () => {
  class ExoticDate extends Date {
    toISOString() { throw new Error("EXOTIC_DATE_THROW"); }
  }
  const exoticInput = stateCInput(new Date("2026-07-15T00:00:00.000Z"));
  exoticInput.now = new ExoticDate("2026-07-15T00:00:00.000Z");
  const exotic = assessLiveStateCReadiness(exoticInput);
  assert.equal(exotic.ready, true);
  assert.equal(exotic.checkedAt, "2026-07-15T00:00:00.000Z");

  const throwing = new Proxy({}, {
    get() { throw new Error("PROXY_THROW"); },
  });
  assert.doesNotThrow(() => assessLiveStateCReadiness(throwing));
  assert.deepEqual(assessLiveStateCReadiness(throwing).reasonCodes, [
    "INVALID_INPUT",
  ]);
});

test("production and State C require an owner-bound lock release operation", async () => {
  let lockCalls = 0;
  const ledger = trustedProductionLedger({
    tryLock: async () => { lockCalls += 1; return true; },
  });
  delete ledger.releaseOwnedLocks;
  await assert.rejects(
    () => failClosedSign({
      intent: {
        userGoalId: "release-required",
        wallet: WALLET,
        chainId: 1,
        actionType: "transfer",
        assetOut: "ETH",
      },
      ledger,
      mmaw: trustedProductionSigner(),
      simulator: { simulate: async () => ({ status: "passed" }) },
      policy: { supportedChainIds: [1] },
    }),
    (error) =>
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("PARTIAL_LOCK_RELEASE_REQUIRED"),
  );
  assert.equal(lockCalls, 0);

  const readiness = stateCInput(new Date("2026-07-15T00:00:00.000Z"));
  delete readiness.ledger.releaseOwnedLocks;
  assert.ok(
    assessLiveStateCReadiness(readiness).reasonCodes.includes(
      "LEDGER_CAPABILITIES_INCOMPLETE",
    ),
  );
});
