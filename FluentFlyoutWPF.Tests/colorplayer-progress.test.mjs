import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web-themes/colorplayer/scripts/player.js", import.meta.url), "utf8");

function renderer() {
  const noop = () => {};
  const nodes = new Map();
  const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop },
    setAttribute: noop, removeAttribute: noop, replaceChildren: noop
  });
  let now = Date.UTC(2026, 0, 1), frame, receive;
  runInNewContext(source, {
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now }, Image: class {}, CustomEvent: class {},
    requestAnimationFrame(fn) { frame = fn; return 1; },
    cancelAnimationFrame() { frame = null; },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
      createElement: element, addEventListener: noop, fonts: { ready: Promise.resolve() }
    },
    window: {
      setTimeout: () => 1, clearTimeout: noop, dispatchEvent: noop, addEventListener: noop,
      FluentFlyout: { onMediaChanged(fn) { receive = fn; }, onConnectionChanged(fn) { fn(true); } }
    }
  });
  return {
    send(status, title, artist, position, age = 0) {
      receive({ isAvailable: true, playbackStatus: status, sessionId: "player", title, artist,
        position, duration: 200, updatedAt: new Date(now).toISOString(),
        timelineLastUpdatedTime: new Date(now - age).toISOString() });
    },
    advance(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        now += 16;
        const callback = frame;
        frame = null;
        callback?.();
      }
      return parseFloat(nodes.get("progress-fill").style.width);
    }
  };
}

test("artist update on resume cannot extrapolate the pause", () => {
  const page = renderer();
  page.send("Paused", "A", "", 36);
  page.advance(300000);
  page.send("Playing", "A", "artist", 36, 300000);
  page.advance(400);
  page.send("Playing", "A", "artist", 36, 300400);
  const percent = page.advance(600);
  assert.ok(percent >= 18 && percent < 19);
});

test("a new title waits for its own position across repeated old samples", () => {
  const page = renderer();
  page.send("Playing", "A", "artist", 36);
  page.advance(500);
  page.send("Playing", "B", "artist", 36);
  page.advance(500);
  page.send("Playing", "B", "artist", 36);
  assert.equal(page.advance(1800), 0);
  page.send("Playing", "B", "artist", 0);
  const percent = page.advance(1800);
  assert.ok(percent > 0 && percent < 1);
});

test("initial snapshot accepts mid-track playback and rejects stale extrapolation to the end", () => {
  for (const age of [2000, 300000]) {
    const page = renderer();
    page.send("Playing", "A", "artist", 36, age);
    const percent = page.advance(500);
    const expected = age === 2000 ? 19 : 18;
    assert.ok(percent >= expected && percent < expected + 1);
  }
});
