import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWalletRequest, reconcileVenueState } from "../src/reconciliation.js";

test("DM-S1: Re-org Ghost State - CONFIRMED requires depth", () => {
  const landedNoDepth = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 1
  });
  assert.equal(landedNoDepth.status, "LANDED");
  assert.equal(landedNoDepth.terminal, false);

  const landedWithDepth = reconcileWalletRequest({
    state: "LANDED",
    confirmationDepth: 3
  });
  assert.equal(landedWithDepth.status, "CONFIRMED");
  assert.equal(landedWithDepth.terminal, true);
});

test("DM-S2: Partial Fill Lock Leak - stays in REQUEST_WATCH_REQUIRED", () => {
  const partialVenue = reconcileVenueState("perps_open", {
    fillStatus: "partial",
    expectedFillSize: "100",
    filledSize: "50"
  });
  assert.equal(partialVenue.status, "REQUEST_WATCH_REQUIRED");
  assert.equal(partialVenue.terminal, false);
  assert.deepEqual(partialVenue.reasonCodes, ["PARTIAL_FILL_PENDING"]);

  const partialTransfer = reconcileVenueState("transfer", {
    balanceUpdated: true,
    observedPositionSize: "50"
  }, { expectedAmount: "100" });
  assert.equal(partialTransfer.status, "REQUEST_WATCH_REQUIRED");
  assert.equal(partialTransfer.terminal, false);
  assert.deepEqual(partialTransfer.reasonCodes, ["PARTIAL_FILL_PENDING"]);
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
});

test("terminal states - TIMED_OUT", () => {
  const timeout = reconcileWalletRequest({
    state: "TIMED_OUT"
  });
  assert.equal(timeout.status, "TIMED_OUT");
  assert.equal(timeout.terminal, true);
});
