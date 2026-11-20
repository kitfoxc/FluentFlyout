import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./progress-utils.js", import.meta.url), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const {
  clampPosition,
  getReportedPosition,
  getTimelinePosition,
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
  }, now), 15);
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
