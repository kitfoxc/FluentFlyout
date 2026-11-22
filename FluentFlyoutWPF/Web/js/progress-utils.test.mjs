import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./progress-utils.js", import.meta.url), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const {
  clampPosition,
  createStartupProgressGuard,
  getReportedPosition,
  getTimelinePosition,
  hasValidTimelineTimestamp,
  smoothPosition
} = await import(moduleUrl);

test("a reported zero position is not replaced by the previous anchor", () => {
  assert.equal(getReportedPosition({ position: 0 }, 42), 0);
  assert.equal(getReportedPosition({ position: "0" }, 42), 0);
  assert.equal(getReportedPosition({ position: null }, 42), 42);
  assert.equal(getReportedPosition({ position: Number.NaN }, 42), 42);
});

test("timeline position advances from the SMTC LastUpdatedTime without new Position samples", () => {
  const now = Date.parse("2026-11-21T00:00:05.000Z");
  const media = {
    position: 30,
    duration: 200,
    timelineLastUpdatedTime: "2026-11-21T00:00:00.000Z"
  };
  assert.equal(getTimelinePosition(media, now), 35);
});

test("a stale timestamp continues extrapolating and is capped at track duration", () => {
  const now = Date.parse("2026-11-21T00:05:00.000Z");
  const media = {
    position: 30,
    duration: 200,
    timelineLastUpdatedTime: "2026-11-21T00:00:00.000Z"
  };
  assert.equal(getTimelinePosition(media, now), 200);
});

test("UpdatedAt is used when the SMTC timestamp is missing or a sentinel", () => {
  const now = Date.parse("2026-11-21T00:00:04.000Z");
  assert.equal(getTimelinePosition({
    position: 12,
    duration: 100,
    timelineLastUpdatedTime: "1601-01-01T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:01.000Z"
  }, now, { allowUpdatedAtFallback: true }), 15);
});

test("a timestamp too far in the future falls back to the reported position", () => {
  const now = Date.parse("2026-11-21T00:00:00.000Z");
  assert.equal(getTimelinePosition({
    position: 12,
    duration: 100,
    timelineLastUpdatedTime: "2026-11-21T00:00:05.000Z",
    updatedAt: null
  }, now), 12);
});

test("invalid and negative positions are clamped safely", () => {
  assert.equal(clampPosition(Number.NaN, 100), 0);
  assert.equal(clampPosition(-5, 100), 0);
  assert.equal(clampPosition(120, 100), 100);
  assert.equal(getTimelinePosition({ position: Number.POSITIVE_INFINITY, duration: 0 }), 0);
});

test("duration zero remains an unknown duration without an artificial upper bound", () => {
  assert.equal(clampPosition(250, 0), 250);
});

test("exponential smoothing is time-based and approaches the target without overshoot", () => {
  const halfway = smoothPosition(0, 10, Math.log(2) * 100, 100);
  assert.equal(halfway, 5);
  const next = smoothPosition(halfway, 10, 1000, 100);
  assert.ok(next > halfway);
  assert.ok(next < 10);
});

test("zero elapsed time does not change the visual position", () => {
  assert.equal(smoothPosition(10, 20, 0, 150), 10);
});

test("SMTC timestamp validity is independent of the fallback UpdatedAt anchor", () => {
  const now = Date.parse("2026-11-21T00:00:00.000Z");
  assert.equal(hasValidTimelineTimestamp({
    timelineLastUpdatedTime: "1601-01-01T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z"
  }, now), false);
  assert.equal(hasValidTimelineTimestamp({
    timelineLastUpdatedTime: "2026-11-21T00:00:00.000Z"
  }, now), true);
});


test("startup guard holds while Position is unchanged and the incoming timeline trails the visual playhead", () => {
  const guard = createGuard();
  guard.start(0, 0);
  const first = guard.observe({
    reportedPosition: 0,
    incomingPosition: 0.1,
    visualPosition: 1.2,
    now: 1000
  });
  assert.equal(first.active, true);
  assert.equal(first.hold, true);
  assert.equal(first.advancingSamples, 0);

  const second = guard.observe({
    reportedPosition: 0,
    incomingPosition: 0.1,
    visualPosition: 1.2,
    now: 2000
  });
  assert.equal(second.active, true);
  assert.equal(second.hold, true);
});

test("startup guard releases after two advancing Position samples catch up", () => {
  const guard = createGuard();
  guard.start(0, 0);
  const first = guard.observe({
    reportedPosition: 0.1,
    incomingPosition: 1.0,
    visualPosition: 1.1,
    now: 1000
  });
  assert.equal(first.active, true);
  assert.equal(first.advancingSamples, 1);

  const second = guard.observe({
    reportedPosition: 0.2,
    incomingPosition: 1.2,
    visualPosition: 1.1,
    now: 2000
  });
  assert.equal(second.active, false);
  assert.equal(second.released, true);
  assert.equal(second.reason, "stable");
});

test("startup guard times out without forcing the visual playhead backward", () => {
  const guard = createGuard();
  guard.start(0, 0);
  const result = guard.observe({
    reportedPosition: 0,
    incomingPosition: 0.1,
    visualPosition: 2.5,
    now: 4200
  });
  assert.equal(result.active, false);
  assert.equal(result.released, true);
  assert.equal(result.reason, "timeout");
});

test("startup guard accepts an explicit raw-position seek immediately", () => {
  const guard = createGuard();
  guard.start(4, 0);
  const result = guard.observe({
    reportedPosition: 1,
    incomingPosition: 1.1,
    visualPosition: 4.2,
    now: 500,
    explicitSeek: true
  });
  assert.equal(result.active, false);
  assert.equal(result.released, true);
  assert.equal(result.reason, "seek");
});

test("startup guard requires consecutive advancing samples", () => {
  const guard = createGuard();
  guard.start(0, 0);
  guard.observe({
    reportedPosition: 0.1,
    incomingPosition: 0.1,
    visualPosition: 0.1,
    now: 100
  });
  const repeated = guard.observe({
    reportedPosition: 0.1,
    incomingPosition: 0.1,
    visualPosition: 0.1,
    now: 200
  });
  assert.equal(repeated.advancingSamples, 0);
  assert.equal(repeated.active, true);
});

function createGuard() {
  return createStartupProgressGuard({
    maxDurationMs: 4200,
    minAdvancingSamples: 2,
    minPositionStepSeconds: 0.05,
    catchUpToleranceSeconds: 0.15
  });
}
