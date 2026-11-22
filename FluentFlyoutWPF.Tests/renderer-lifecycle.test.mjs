import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");

for (const [theme, directory, sleepClass] of [
  ["fluent", "../FluentFlyoutWPF/Web/js/", "is-sleeping"],
  ["dev", "../web-themes/dev/js/", "is-efficiency"]
]) {
  test(theme + " freezes until a fresh snapshot and sleeps five minutes after the first pause", async t => {
    const nodes = new Map();
    const noop = () => {};
    function getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, {
          classes, style: {}, attributes: {}, removeAttribute: noop,
          setAttribute(key, value) { this.attributes[key] = value; },
          classList: { add: key => classes.add(key), remove: key => classes.delete(key), toggle: noop }
        });
      }
      return nodes.get(id);
    }
    let now = Date.UTC(2026, 0, 1);
    t.mock.method(Date, "now", () => now);
    let media, connection, frame, timer;
    const events = {};
    const window = {
      FluentFlyout: {
        onConnectionChanged(fn) { connection = fn; fn(false); },
        onMediaChanged(fn) { media = fn; }
      },
      addEventListener(name, fn) { events[name] = fn; },
      setTimeout(fn, delay) { timer = { fn, due: now + delay }; return 1; },
      clearTimeout() { timer = null; }
    };
    Object.assign(globalThis, {
      window, document: { getElementById, addEventListener: noop },
      requestAnimationFrame(fn) { frame = fn; return 1; },
      cancelAnimationFrame() { frame = null; }
    });
    t.mock.method(globalThis, "clearTimeout", window.clearTimeout);
    const read = file => readFile(new URL(directory + file, import.meta.url), "utf8");
    const source = (await read("app.js")).replace('"./progress-utils.js"', JSON.stringify(moduleUrl(await read("progress-utils.js"))));
    await import(moduleUrl(source));
    const send = (playbackStatus, position, title = "A") => media({
      playbackStatus, position, title, duration: 100, isAvailable: true,
      timelineLastUpdatedTime: new Date(now).toISOString()
    });
    const asleep = () => getElementById("dashboard").classes.has(sleepClass);
    connection(true);
    send("Playing", 50);
    assert.equal(typeof frame, "function");
    connection(false);
    now += 60_000;
    connection(true);
    events.pageshow();
    assert.equal(frame, null);
    send("Playing", 10);
    assert.equal(getElementById("progress-track").attributes["aria-valuenow"], "10.0");
    send("Paused", 10);
    const due = now + 300_000;
    for (let i = 1; i <= 4; i++) {
      now += 60_000;
      send("Paused", 10 + i);
      assert.equal(timer.due, due);
    }
    now = due;
    timer.fn();
    assert.ok(asleep());
    send("Paused", 20);
    assert.ok(asleep());
    send("Paused", 0, "B");
    assert.ok(!asleep());
    assert.equal(timer.due, now + 300_000);
  });
}
