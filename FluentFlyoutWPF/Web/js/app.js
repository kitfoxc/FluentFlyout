import {
  getEstimatedPosition,
  getReportedPosition,
  shouldStartProgress
} from "./progress-utils.js";

const el = {
  widget: document.querySelector("#widget"),
  cover: document.querySelector("#cover"),
  placeholder: document.querySelector("#cover-placeholder"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  album: document.querySelector("#album"),
  player: document.querySelector("#player"),
  status: document.querySelector("#status-label"),
  progressArea: document.querySelector("#progress-area"),
  progressFill: document.querySelector("#progress-fill"),
  position: document.querySelector("#position"),
  duration: document.querySelector("#duration")
};

const STARTUP_MIN_RATIO = 0.02;
const STALL_TIMEOUT_MS = 4500;
const PAUSED_SLEEP_MS = 5 * 60 * 1000;
const CORRECTION_DEAD_BAND = 0.15;
const SEEK_THRESHOLD = 3;

let media = null;
let trackKey = "";
let playbackStatus = "Stopped";
let lastRawPosition = null;
let lastAdvancePosition = null;
let lastAdvanceAt = 0;
let anchorPosition = 0;
let anchorAt = performance.now();
let correction = 0;
let correctionAt = 0;
let correctionDuration = 700;
let awaitingStart = false;
let running = false;
let stalled = false;
let frame = 0;
let pauseTimer = 0;
let coverUrl = null;
let pendingCover = null;

function clampPosition(position) {
  const duration = Math.max(0, Number(media?.duration) || 0);
  return duration > 0
    ? Math.min(duration, Math.max(0, position))
    : Math.max(0, position);
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function getPosition(now = performance.now()) {
  if (!running || stalled || playbackStatus !== "Playing")
    return clampPosition(anchorPosition);

  const elapsed = Math.max(0, now - anchorAt) / 1000;
  let position = anchorPosition + elapsed;

  if (correction !== 0) {
    const progress = Math.min(1, Math.max(0, (now - correctionAt) / correctionDuration));
    const eased = progress * progress * (3 - 2 * progress);
    position += correction * eased;

    if (progress >= 1) {
      anchorPosition = position;
      anchorAt = now;
      correction = 0;
    }
  }

  return clampPosition(position);
}

function resetAnchor(position, now = performance.now()) {
  anchorPosition = Math.max(0, Number(position) || 0);
  anchorAt = now;
  correction = 0;
  correctionAt = now;
}

function renderPosition(position) {
  const duration = Math.max(0, Number(media?.duration) || 0);
  const safePosition = clampPosition(position);
  el.progressFill.style.width = duration > 0
    ? `${safePosition / duration * 100}%`
    : "0%";
  el.position.textContent = formatTime(safePosition);
  el.duration.textContent = formatTime(duration);
}

function renderMetadata(next) {
  el.title.textContent = next.title || "Unknown track";
  el.artist.textContent = next.artist || "";
  el.album.textContent = next.album || "";
  el.player.textContent = next.playerName || "";
  el.status.textContent = next.playbackStatus === "Playing" ? "NOW PLAYING" : "PAUSED";
  el.widget.classList.toggle("is-paused", next.playbackStatus !== "Playing");
  el.progressArea.classList.toggle("is-unavailable", !(Number(next.duration) > 0));
}

function setCover(url) {
  if (url === coverUrl) return;
  coverUrl = url || null;

  if (pendingCover) {
    pendingCover.onload = null;
    pendingCover.onerror = null;
    pendingCover.src = "";
    pendingCover = null;
  }

  if (!coverUrl) {
    el.cover.removeAttribute("src");
    el.cover.hidden = true;
    el.placeholder.hidden = false;
    return;
  }

  const image = new Image();
  pendingCover = image;
  image.onload = () => {
    if (pendingCover !== image || coverUrl !== url) return;
    pendingCover = null;
    el.cover.src = url;
    el.cover.hidden = false;
    el.placeholder.hidden = true;
  };
  image.onerror = () => {
    if (pendingCover !== image || coverUrl !== url) return;
    pendingCover = null;
    el.cover.removeAttribute("src");
    el.cover.hidden = true;
    el.placeholder.hidden = false;
  };
  image.src = url;
}

function stopAnimation() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

function animate() {
  frame = 0;
  if (!running || stalled || document.hidden || playbackStatus !== "Playing")
    return;

  const now = performance.now();
  if (now - lastAdvanceAt >= STALL_TIMEOUT_MS) {
    enterStalled(now);
    return;
  }

  renderPosition(getPosition(now));
  frame = requestAnimationFrame(animate);
}

function startAnimation() {
  if (!frame && running && !stalled && !document.hidden)
    frame = requestAnimationFrame(animate);
}

function enterStalled(now = performance.now()) {
  if (!stalled)
    resetAnchor(getPosition(now), now);
  stalled = true;
  running = false;
  stopAnimation();
  renderPosition(anchorPosition);
}

function clearPauseTimer() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = 0;
}

function sleep(clearState = false) {
  stopAnimation();
  clearPauseTimer();
  running = false;
  awaitingStart = false;
  stalled = false;
  correction = 0;
  el.widget.classList.add("is-hidden", "is-sleeping");

  setCover(null);
  if (clearState) {
    media = null;
    trackKey = "";
    playbackStatus = "Stopped";
    lastRawPosition = null;
    lastAdvancePosition = null;
  }
}

function wake() {
  el.widget.classList.remove("is-hidden", "is-sleeping");
}

function schedulePausedSleep() {
  if (pauseTimer) return;
  pauseTimer = window.setTimeout(() => {
    pauseTimer = 0;
    if (playbackStatus === "Paused")
      sleep();
  }, PAUSED_SLEEP_MS);
}

function applyState(next) {
  if (!next?.isAvailable ||
      next.playbackStatus === "Stopped" ||
      next.playbackStatus === "Closed") {
    media = next || null;
    sleep(true);
    return;
  }

  const now = performance.now();
  const rawPosition = getReportedPosition(next, anchorPosition);
  const nextTrackKey = `${next.sessionId || ""}\u001f${next.title || ""}`;
  const trackChanged = nextTrackKey !== trackKey;
  const resumed = playbackStatus !== "Playing";

  media = next;
  renderMetadata(next);
  setCover(next.coverUrl || null);

  if (next.playbackStatus === "Paused") {
    trackKey = nextTrackKey;
    playbackStatus = "Paused";
    lastRawPosition = rawPosition;
    lastAdvancePosition = rawPosition;
    resetAnchor(rawPosition, now);
    running = false;
    awaitingStart = false;
    stalled = false;
    stopAnimation();
    wake();
    renderPosition(rawPosition);
    schedulePausedSleep();
    return;
  }

  if (next.playbackStatus !== "Playing") {
    sleep();
    return;
  }

  clearPauseTimer();
  wake();
  playbackStatus = "Playing";

  if (trackChanged || resumed || lastRawPosition === null) {
    trackKey = nextTrackKey;
    lastRawPosition = rawPosition;
    lastAdvancePosition = rawPosition;
    lastAdvanceAt = now;
    resetAnchor(rawPosition, now);
    running = false;
    awaitingStart = true;
    stalled = false;
    stopAnimation();
    renderPosition(rawPosition);
    return;
  }

  const advanced = lastAdvancePosition === null || rawPosition > lastAdvancePosition + 0.12;
  const movedBack = lastAdvancePosition !== null && rawPosition < lastAdvancePosition - 0.8;
  const current = getPosition(now);
  const reported = getEstimatedPosition(next, Date.now());
  const difference = reported - current;

  if (movedBack || Math.abs(difference) >= SEEK_THRESHOLD) {
    resetAnchor(reported, now);
    running = true;
    awaitingStart = false;
    stalled = false;
    lastAdvanceAt = now;
    lastAdvancePosition = rawPosition;
  } else if (advanced) {
    lastAdvanceAt = now;
    lastAdvancePosition = rawPosition;
    stalled = false;

    if (awaitingStart) {
      if (shouldStartProgress(reported, Number(next.duration), STARTUP_MIN_RATIO)) {
        resetAnchor(reported, now);
        awaitingStart = false;
        running = true;
      }
    } else {
      if (Math.abs(difference) > CORRECTION_DEAD_BAND) {
        anchorPosition = current;
        anchorAt = now;
        correction = difference;
        correctionAt = now;
        correctionDuration = Math.max(500, Math.min(1200, Math.abs(difference) * 350));
      }
      running = true;
    }
  }

  lastRawPosition = rawPosition;

  if (running && now - lastAdvanceAt >= STALL_TIMEOUT_MS) {
    enterStalled(now);
    return;
  }

  if (running) startAnimation();
  else stopAnimation();

  renderPosition(getPosition(now));
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopAnimation();
    return;
  }

  if (!media || playbackStatus !== "Playing") return;
  const now = performance.now();
  if (running && now - lastAdvanceAt >= STALL_TIMEOUT_MS) {
    enterStalled(now);
    return;
  }
  resetAnchor(getPosition(now), now);
  startAnimation();
}

document.addEventListener("visibilitychange", handleVisibilityChange);
window.addEventListener("pagehide", () => {
  stopAnimation();
  clearPauseTimer();
  if (pendingCover) {
    pendingCover.onload = null;
    pendingCover.onerror = null;
    pendingCover.src = "";
    pendingCover = null;
  }
});
window.addEventListener("pageshow", () => {
  if (media?.playbackStatus === "Playing" && running) {
    resetAnchor(getPosition(), performance.now());
    startAnimation();
  } else if (media?.playbackStatus === "Paused") {
    renderPosition(getReportedPosition(media));
  }
});

if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(applyState);
} else {
  console.error("FluentFlyout browser API was not loaded.");
}
