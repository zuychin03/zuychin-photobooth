import assert from "node:assert/strict";
import test from "node:test";
import { createRollbackDatabase } from "./local-rollback-database.mjs";

test("actual PostgreSQL and EventHandler retain receipts across pause/restart and finish accepted work safely", { skip: process.env.PB_RUN_LOCAL_ROLLBACK_SQL !== "1", timeout: 300000 }, async () => {
  const fixture = await createRollbackDatabase();
  try {
    const before = await fixture.check("http://127.0.0.1:3017"); assert.equal(before.receipt.state, "ready"); assert.equal(before.wrongTokenDenied, true);
    const after = await fixture.pauseAndRestart("http://127.0.0.1:3017"); assert.equal(after.pause.paused, true); assert.equal(after.receipt.submissionId, before.receipt.submissionId); assert.equal(after.newReservationRefused, true); assert.equal(after.generation, 1);
    const drained = await fixture.drainAndCleanup("http://127.0.0.1:3017"); assert.equal(drained.acceptedStagedFinalisedDuringPause, true); assert.equal(drained.derivativeDeletionConfirmed, true); assert.equal(drained.stagingStillCharged, 2000000); assert.equal(drained.existingReceipt.state, "ready");
  } finally { await fixture.close(); }
});
