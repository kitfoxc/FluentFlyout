import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./progress-utils.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  getReportedPosition,
  hasForwardProgress,
  isTimelineFresh,
  pruneRecentSamples
} = await import(moduleUrl);

test("a reported zero position is not replaced by the previous anchor", () => {
  assert.equal(getReportedPosition({ position: 0 }, 42), 0);
  assert.equal(getReportedPosition({ position: "0" }, 42), 0);
  assert.equal(getReportedPosition({ position: null }, 42), 42);
  assert.equal(getReportedPosition({ position: Number.NaN }, 42), 42);
});

test("missing and sentinel SMTC timestamps use event-arrival freshness", () => {
  const now = Date.parse("2026-11-20T00:00:00.000Z");
  assert.equal(isTimelineFresh({}, now), true);
  assert.equal(isTimelineFresh({ timelineLastUpdatedTime: null }, now), true);
  assert.equal(
    isTimelineFresh({ timelineLastUpdatedTime: "1601-01-01T00:00:00.000Z" }, now),
    true
  );
});

test("a real timeline timestamp is fresh only inside the allowed age window", () => {
  const now = Date.parse("2026-11-20T00:00:00.000Z");
  assert.equal(
    isTimelineFresh({ timelineLastUpdatedTime: new Date(now - 4000).toISOString() }, now, 4500),
    true
  );
  assert.equal(
    isTimelineFresh({ timelineLastUpdatedTime: new Date(now - 5000).toISOString() }, now, 4500),
    false
  );
  assert.equal(
    isTimelineFresh({ timelineLastUpdatedTime: new Date(now + 1500).toISOString() }, now, 4500),
    false
  );
});

test("the calibration window retains advancing samples from a 1.5-second source", () => {
  const samples = pruneRecentSamples([
    { position: 10, at: 0 },
    { position: 11.5, at: 1500 },
    { position: 13, at: 3000 }
  ], 3000, 5000);

  assert.equal(samples.length, 3);
  assert.equal(hasForwardProgress(samples, 3, 500, 0.12), true);
});

test("the recovery window permits slow but fresh advancing samples", () => {
  const samples = pruneRecentSamples([
    { position: 40, at: 0 },
    { position: 44, at: 4000 }
  ], 4000, 9000);

  assert.equal(samples.length, 2);
  assert.equal(hasForwardProgress(samples, 2, 200, 0.12), true);
});

test("expired samples and non-advancing samples cannot calibrate playback", () => {
  const samples = pruneRecentSamples([
    { position: 5, at: 0 },
    { position: 5, at: 1500 },
    { position: 5, at: 3000 },
    { position: 6, at: -1 }
  ], 3000, 2500);

  assert.equal(samples.length, 2);
  assert.equal(hasForwardProgress(samples, 3, 500, 0.12), false);
});
