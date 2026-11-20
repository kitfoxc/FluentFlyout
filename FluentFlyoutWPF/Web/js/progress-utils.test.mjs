import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./progress-utils.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  clampPosition,
  filterStartupJitter,
  getProjectionBudget,
  getReportedPosition,
  projectBoundedPosition,
  reconcilePosition
} = await import(moduleUrl);

test("zero position is never replaced by a previous anchor", () => {
  assert.equal(getReportedPosition({ position: 0 }, 42), 0);
  assert.equal(getReportedPosition({ position: "0" }, 42), 0);
  assert.equal(getReportedPosition({ position: null }, 42), 42);
  assert.equal(getReportedPosition({ position: Number.NaN }, 42), 42);
});

test("bounded playhead freezes when the server sample budget expires", () => {
  const anchor = { position: 10, at: 1000, budgetMs: 1500, duration: 60 };
  assert.equal(projectBoundedPosition(anchor, 1500), 10.5);
  assert.equal(projectBoundedPosition(anchor, 3000), 11.5);
  assert.equal(projectBoundedPosition(anchor, 10000), 11.5);
});

test("zero projection budget handles buffering without inventing progress", () => {
  const anchor = { position: 10, at: 1000, budgetMs: 0, duration: 60 };
  assert.equal(projectBoundedPosition(anchor, 9000), 10);
  assert.equal(getProjectionBudget({ playbackStatus: "Playing", positionProjectionMs: 0 }), 0);
});

test("pause never extrapolates even with stale budget", () => {
  assert.equal(getProjectionBudget({ playbackStatus: "Paused", positionProjectionMs: 5000 }), 0);
  assert.equal(getProjectionBudget({ playbackStatus: "Playing", positionProjectionMs: -50 }), 0);
  assert.equal(getProjectionBudget({ playbackStatus: "Playing", positionProjectionMs: 20000 }), 5000);
});

test("legacy protocol snapshots retain a bounded fallback", () => {
  assert.equal(getProjectionBudget({ playbackStatus: "Playing" }), 5000);
});

test("tiny network jitter is ignored while meaningful seeks are preserved", () => {
  assert.equal(reconcilePosition(10, 10.08, 60), 10);
  assert.equal(reconcilePosition(10, 14, 60), 14);
  assert.equal(reconcilePosition(10, 0, 60), 0);
});

test("startup filter applies only to small backward motion in first two percent", () => {
  assert.equal(filterStartupJitter(1.2, 1, 100), 1.2);
  assert.equal(filterStartupJitter(10, 0, 100), 0);
  assert.equal(filterStartupJitter(4, 3.8, 100), 3.8);
});

test("invalid and overshooting positions are clamped", () => {
  assert.equal(clampPosition(-2, 10), 0);
  assert.equal(clampPosition(12, 10), 10);
  assert.equal(clampPosition(Number.NaN, 0), 0);
});
