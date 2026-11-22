// Color animation and picker interaction, in local design coordinates.
(() => {
  const picker = document.querySelector(".picker");
  const wheel = picker.querySelector(".wheel");
  const ring = document.getElementById("ring");
  const triangle = document.getElementById("triangle");
  const selector = document.getElementById("triangle-selector");
  const swatch = document.getElementById("swatch");
  const brightness = document.getElementById("brightness");

  let hue = 111;
  let saturation = 60;
  let value = Number(brightness.value);
  const speed = 24; // degrees per second
  let frame = 0;
  let previousTime = null;
  let resumeTimer = 0;
  let activePointer = null;
  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));

  function paintHue() {
    picker.style.setProperty("--hue-color", `hsl(${hue} 100% 50%)`);
    ring.style.transform = `rotate(${90 - hue}deg)`;
    paintSwatch();
  }
  function paintSwatch() {
    // Convert HSV to CSS HSL for the selected-color preview.
    const light = value * (1 - saturation / 200);
    const chroma = Math.min(light, 100 - light);
    const sat = chroma > 0 ? (value - light) / chroma * 100 : 0;
    swatch.style.backgroundColor = `hsl(${hue} ${sat}% ${light}%)`;
  }
  function paintSelection() {
    selector.style.left = saturation + "%";
    selector.style.top = clamp(100 - value, saturation / 2, 100 - saturation / 2) + "%";
    brightness.value = value;
    paintSwatch();
  }
  function rotate(time) {
    if (previousTime !== null) {
      hue = ((hue - speed * (time - previousTime) / 1000) % 360 + 360) % 360;
      paintHue();
    }
    previousTime = time;
    frame = requestAnimationFrame(rotate);
  }
  const button = document.getElementById("settings-button");
  const panel = document.getElementById("settings-panel");
  const sync = document.getElementById("sync-rotation");
  const preference = "color-player.sync-rotation";
  try { sync.checked = localStorage.getItem(preference) === "true"; } catch {}
  let playing = false;

  function showSettings(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) sync.focus();
  }
  button.addEventListener("click", () => showSettings(panel.hidden));
  document.addEventListener("pointerdown", event => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) showSettings(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) {
      showSettings(false);
      button.focus();
    }
  });
  function updateRotation() {
    if (sync.checked && !playing) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else start();
  }
  sync.addEventListener("change", () => {
    try { localStorage.setItem(preference, String(sync.checked)); } catch {}
    updateRotation();
  });
  window.addEventListener("color-player-playback", event => {
    playing = event.detail;
    updateRotation();
  });
  function start() {
    if (sync.checked && !playing) return;
    if (!document.hidden && activePointer === null && !resumeTimer && !frame) {
      previousTime = null;
      frame = requestAnimationFrame(rotate);
    }
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(resumeTimer);
    resumeTimer = 0;
  }
  function resumeLater() {
    stop();
    resumeTimer = setTimeout(() => {
      resumeTimer = 0;
      start();
    }, 2000);
  }

  function drag(element, update) {
    element.addEventListener("pointerdown", event => {
      if (activePointer !== null || event.button !== 0) return;
      activePointer = event.pointerId;
      stop();
      element.setPointerCapture(event.pointerId);
      update(event);
    });
    element.addEventListener("pointermove", event => {
      if (element.hasPointerCapture(event.pointerId)) update(event);
    });
    element.addEventListener("lostpointercapture", event => {
      if (event.pointerId !== activePointer) return;
      activePointer = null;
      resumeLater();
    });
  }
  drag(ring, event => {
    const rect = wheel.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    paintHue();
  });
  drag(triangle, event => {
    const rect = triangle.getBoundingClientRect();
    saturation = clamp(Math.round((event.clientX - rect.left) / rect.width * 100), 0, 100);
    const y = clamp((event.clientY - rect.top) / rect.height * 100, saturation / 2, 100 - saturation / 2);
    value = Math.round(100 - y);
    paintSelection();
  });
  brightness.addEventListener("input", () => {
    value = Number(brightness.value);
    paintSelection();
    if (activePointer === null) resumeLater();
  });
  drag(brightness, () => { /* The native range handles mouse, touch and keyboard input. */ });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", start);
  paintSelection();
  paintHue();
  start();
})();
