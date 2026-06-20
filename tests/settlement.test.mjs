import assert from "node:assert";
import { 
  reconcileWalletRequest, 
  reconcileVenueState, 
  reconcileSettlementReceipt,
  reconcilePartialFillRelease,
  reconcileWatcherHeartbeat
} from "../src/reconciliation.ts";

function test(name, fn) {
  try {
    fn();
    console.log("✓ " + name);
  } catch (err) {
    console.error("✗ " + name);
    console.error(err);
    process.exit(1);
  }
}

test("DM-S1: Re-org Ghost State - CONFIRMED requires depth", () => {
  const landedNoDepth = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 0
  });
  assert.equal(landedNoDepth.status, "LANDED");
  assert.equal(landedNoDepth.terminal, false);
  assert.ok(landedNoDepth.reasonCodes.includes("REORG_GHOST_STATE"));

  const landedInsufficient = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 1
  });
  assert.equal(landedInsufficient.status, "LANDED");
  assert.ok(landedInsufficient.reasonCodes.includes("SETTLEMENT_CONFIRMATION_DEPTH_REQUIRED"));

  const landedWithDepth = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 3
  });
  assert.equal(landedWithDepth.status, "CONFIRMED");
  assert.equal(landedWithDepth.terminal, true);
});

test("RPC quorum can satisfy confirmation when explicitly marked trusted", () => {
  const landedTrusted = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 1,
    rpcQuorumTrusted: true
  });
  assert.equal(landedTrusted.status, "CONFIRMED");
  assert.equal(landedTrusted.terminal, true);
});

test("DM-S2: Partial Fill Lock Leak - stays in REQUEST_WATCH_REQUIRED", () => {
  const partialVenue = reconcileVenueState("perps_open", {
    fillStatus: "partial",
    expectedFillSize: "100",
    filledSize: "50"
  });
  assert.equal(partialVenue.status, "REQUEST_WATCH_REQUIRED");
  assert.equal(partialVenue.terminal, false);
  assert.ok(partialVenue.reasonCodes.includes("PARTIAL_FILL_PENDING"));
  assert.ok(partialVenue.reasonCodes.includes("PARTIAL_LOCK_RELEASE_REQUIRED"));

  const partialTransfer = reconcileVenueState("transfer", {
    balanceUpdated: true,
    observedPositionSize: "50"
  }, { expectedAmount: "100" });
  assert.equal(partialTransfer.status, "REQUEST_WATCH_REQUIRED");
  assert.equal(partialTransfer.terminal, false);
  assert.ok(partialTransfer.reasonCodes.includes("PARTIAL_FILL_PENDING"));
});

test("DM-S3: Gas Drain Blind Spot - REVERTED gas accounting", () => {
  const revertedNoGas = reconcileWalletRequest({
    state: "REVERTED"
  });
  assert.equal(revertedNoGas.status, "REVERTED");
  assert.deepEqual(revertedNoGas.reasonCodes, ["REVERT_GAS_BURN_UNACCOUNTED"]);

  const revertedWithGas = reconcileWalletRequest({
    state: "REVERTED",
    gasBurnedUsd: "1.50"
  });
  assert.equal(revertedWithGas.status, "REVERTED");
  assert.deepEqual(revertedWithGas.reasonCodes, []);
});

test("DM-S4: Silent Watcher Crash - stale watcher detection", () => {
  const staleAt = new Date(Date.now() - 60000).toISOString();
  const staleWatcher = reconcileWalletRequest({
    state: "SUBMITTED",
    watcherHeartbeatAt: staleAt
  });
  assert.equal(staleWatcher.status, "REQUEST_WATCH_REQUIRED");
  assert.equal(staleWatcher.terminal, false);
  assert.ok(staleWatcher.reasonCodes.includes("STALE_RECONCILIATION"));
  assert.ok(staleWatcher.reasonCodes.includes("STALE_WATCHER_DETECTED"));
});

test("max extension cap emits EXPLICIT_STUCK_ALARM", () => {
  const stuck = reconcileWalletRequest({
    state: "SUBMITTED",
    lockExtensionCount: 5
  });
  assert.equal(stuck.status, "ABORTED");
  assert.equal(stuck.terminal, true);
  assert.ok(stuck.reasonCodes.includes("EXPLICIT_STUCK_ALARM"));
});

test("reconcileSettlementReceipt helper", () => {
  const res = reconcileSettlementReceipt({ state: "CONFIRMED" });
  assert.equal(res.status, "CONFIRMED");
});

test("reconcilePartialFillRelease helper", () => {
  const res = reconcilePartialFillRelease("transfer", { balanceUpdated: true, observedPositionSize: "100" }, { expectedAmount: "100" });
  assert.equal(res.status, "CONFIRMED");
});

test("reconcileWatcherHeartbeat helper", () => {
  const staleAt = new Date(Date.now() - 60000).toISOString();
  const res = reconcileWatcherHeartbeat({ watcherHeartbeatAt: staleAt });
  assert.equal(res.status, "REQUEST_WATCH_REQUIRED");
  assert.ok(res.reasonCodes.includes("STALE_WATCHER_DETECTED"));
});

console.log("All tests passed.");
