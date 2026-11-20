import test from "node:test";
import assert from "node:assert/strict";
import {
  getEstimatedPosition,
  getReportedPosition,
  shouldStartProgress
} from "./progress-utils.js";

const now = Date.parse("2026-11-20T00:00:00.000Z");

test("zero is a valid reported position", () => {
  assert.equal(getReportedPosition({ position: 0 }, 42), 0);
  assert.equal(getReportedPosition({ position: "0" }, 42), 0);
  assert.equal(getReportedPosition({ position: null }, 42), 42);
  assert.equal(getReportedPosition({ position: Number.NaN }, 42), 42);
});

test("timestamp age is added only when valid and is capped", () => {
  assert.equal(
    getEstimatedPosition({ position: 10, timelineLastUpdatedTime: new Date(now - 1000).toISOString() }, now),
    11
  );
  assert.equal(
    getEstimatedPosition({ position: 10, timelineLastUpdatedTime: new Date(now - 9000).toISOString() }, now),
    12
  );
  assert.equal(getEstimatedPosition({ position: 10 }, now), 10);
  assert.equal(
    getEstimatedPosition({ position: 10, timelineLastUpdatedTime: "1601-01-01T00:00:00.000Z" }, now),
    10
  );
});

test("startup jitter is held until the playhead reaches two percent", () => {
  assert.equal(shouldStartProgress(1, 100), false);
  assert.equal(shouldStartProgress(2, 100), true);
  assert.equal(shouldStartProgress(0.5, 0), true);
  assert.equal(shouldStartProgress(0, 100), false);
});
