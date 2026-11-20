import {
  getReportedPosition,
  getTimelinePosition,
  hasValidTimelineTimestamp,
  smoothPosition
} from "./progress-utils.js";

const elements = {
  widget: document.querySelector("#widget"),
  cover: document.querySelector("#cover"),
  coverPlaceholder: document.querySelector("#cover-placeholder"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  album: document.querySelector("#album"),
  player: document.querySelector("#player"),
  status: document.querySelector("#status-label"),
  progressArea: document.querySelector("#progress-area"),
  progressFill: document.querySelector("#progress-fill"),
  position: document.querySelector("#position"),
  duration: document.querySelector("#duration"),
  connection: document.querySelector("#connection")
};

const SYNC = Object.freeze({
  SLEEPING: "sleeping",
  RUNNING: "running",
  PAUSED: "paused"
});

const PAUSED_SLEEP_MS = 5 * 60 * 1000;
const NORMAL_SMOOTHING_MS = 150;
const RECOVERY_SMOOTHING_MS = 500;
const BACKWARD_SEEK_THRESHOLD_SECONDS = 0.8;
const FORWARD_SNAP_THRESHOLD_SECONDS = 8;
const TEXT_UPDATE_INTERVAL_MS = 200;

let state = null;
let syncMode = SYNC.SLEEPING;
let animationFrame = 0;
let pauseSleepTimer = 0;
let currentCoverUrl = null;
let pendingCoverImage = null;
let currentTrackKey = null;
let sleeping = true;
let sleepReason = "no-media";

// Logical position is the authoritative playhead derived from the latest SMTC
// timeline anchor. Visual position is only a presentation value that follows it.
let logicalAnchor = 0;
let logicalAnchorAt = performance.now();
let visualPosition = 0;
let lastFrameAt = 0;
let lastTextRenderAt = 0;
let lastReportedPosition = null;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
    : minutes + ":" + String(remainder).padStart(2, "0");
}

function getTrackKey(media) {
  return [media?.sessionId || "", media?.title || ""].join("\u001f");
}

function clampToDuration(position) {
  const duration = Math.max(0, Number(state?.duration) || 0);
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  return duration > 0 ? Math.min(duration, safePosition) : safePosition;
}

function getLogicalPosition(now = performance.now()) {
  const elapsed = syncMode === SYNC.RUNNING && state?.playbackStatus === "Playing"
    ? Math.max(0, now - logicalAnchorAt) / 1000
    : 0;
  return clampToDuration(logicalAnchor + elapsed);
}

function stopAnimation() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
}

function startAnimation() {
  if (animationFrame || sleeping || document.hidden || syncMode !== SYNC.RUNNING)
    return;
  lastFrameAt = performance.now();
  animationFrame = requestAnimationFrame(updateProgress);
}

function clearPauseSleepTimer() {
  if (pauseSleepTimer) {
    clearTimeout(pauseSleepTimer);
    pauseSleepTimer = 0;
  }
}

function releaseCover() {
  if (pendingCoverImage) {
    pendingCoverImage.onload = null;
    pendingCoverImage.onerror = null;
    pendingCoverImage.src = "";
    pendingCoverImage = null;
  }

  elements.cover.onload = null;
  elements.cover.onerror = null;
  elements.cover.removeAttribute("src");
  elements.cover.hidden = true;
  elements.coverPlaceholder.hidden = false;
  currentCoverUrl = null;
}

function enterSleep(reason, clearMedia = false) {
  sleeping = true;
  sleepReason = reason;
  syncMode = SYNC.SLEEPING;
  stopAnimation();
  clearPauseSleepTimer();
  releaseCover();
  elements.widget.classList.add("is-hidden", "is-sleeping");

  if (clearMedia) {
    state = null;
    currentTrackKey = null;
    logicalAnchor = 0;
    visualPosition = 0;
    lastReportedPosition = null;
  }
}

function wakePage() {
  if (!sleeping) return;
  sleeping = false;
  sleepReason = "";
  elements.widget.classList.remove("is-hidden", "is-sleeping");
}

function schedulePausedSleep() {
  if (pauseSleepTimer || sleeping) return;

  pauseSleepTimer = window.setTimeout(() => {
    pauseSleepTimer = 0;
    if (state?.playbackStatus === "Paused")
      enterSleep("paused");
  }, PAUSED_SLEEP_MS);
}

function setPosition(position, now = performance.now(), syncVisual = false) {
  logicalAnchor = clampToDuration(position);
  logicalAnchorAt = now;
  if (syncVisual)
    visualPosition = logicalAnchor;
}

function renderPosition(position, forceText = false) {
  const duration = Math.max(0, Number(state?.duration) || 0);
  const safePosition = clampToDuration(position);
  const progress = duration > 0 ? safePosition / duration : 0;
  elements.progressFill.style.transform = "scaleX(" + Math.max(0, Math.min(1, progress)) + ")";

  const now = performance.now();
  if (forceText || now - lastTextRenderAt >= TEXT_UPDATE_INTERVAL_MS) {
    elements.position.textContent = formatTime(safePosition);
    elements.duration.textContent = formatTime(duration);
    lastTextRenderAt = now;
  }
}

function renderMetadata(media) {
  elements.title.textContent = media.title || "Unknown track";
  elements.artist.textContent = media.artist || "";
  elements.album.textContent = media.album || "";
  elements.player.textContent = media.playerName || "";
  elements.status.textContent = media.playbackStatus === "Playing"
    ? "NOW PLAYING"
    : media.playbackStatus === "Paused" ? "PAUSED" : "STOPPED";
  elements.widget.classList.toggle("is-paused", media.playbackStatus !== "Playing");
  elements.progressArea.classList.toggle("is-unavailable", !(Number(media.duration) > 0));
  renderPosition(syncMode === SYNC.RUNNING ? getLogicalPosition() : visualPosition, true);
}

function setCover(url) {
  if (url === currentCoverUrl) return;

  if (pendingCoverImage) {
    pendingCoverImage.onload = null;
    pendingCoverImage.onerror = null;
    pendingCoverImage.src = "";
    pendingCoverImage = null;
  }

  currentCoverUrl = url || null;
  if (!currentCoverUrl) {
    elements.cover.removeAttribute("src");
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
    return;
  }

  const image = new Image();
  pendingCoverImage = image;
  image.onload = () => {
    if (pendingCoverImage !== image || currentCoverUrl !== url) return;
    pendingCoverImage = null;
    image.onload = null;
    image.onerror = null;
    elements.cover.src = url;
    elements.cover.hidden = false;
    elements.coverPlaceholder.hidden = true;
  };
  image.onerror = () => {
    if (pendingCoverImage !== image || currentCoverUrl !== url) return;
    pendingCoverImage = null;
    image.onload = null;
    image.onerror = null;
    currentCoverUrl = null;
    elements.cover.removeAttribute("src");
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
  };
  image.src = url;
}

function resetPlayhead(media, now, syncVisual = true) {
  const position = getTimelinePosition(media, Date.now());
  lastReportedPosition = getReportedPosition(media);
  setPosition(position, now, syncVisual);
  if (syncVisual)
    renderPosition(visualPosition, true);
}

function synchronizePosition(media, now) {
  const wallNow = Date.now();
  const reportedPosition = getReportedPosition(media);
  const currentPosition = getLogicalPosition(now);

  // UpdatedAt is only a startup fallback when SMTC does not provide a usable
  // LastUpdatedTime. Reusing each event's UpdatedAt would continually pull the
  // playhead back to a repeated, unchanged Position value.
  if (!hasValidTimelineTimestamp(media, wallNow)) {
    const previousReportedPosition = lastReportedPosition;
    lastReportedPosition = reportedPosition;

    if (previousReportedPosition !== null &&
        reportedPosition < previousReportedPosition - BACKWARD_SEEK_THRESHOLD_SECONDS) {
      setPosition(reportedPosition, now, true);
      renderPosition(visualPosition, true);
      return;
    }

    const rawDifference = reportedPosition - currentPosition;
    if (rawDifference > FORWARD_SNAP_THRESHOLD_SECONDS) {
      setPosition(reportedPosition, now, true);
      renderPosition(visualPosition, true);
      return;
    }

    if (rawDifference > 0.6)
      setPosition(reportedPosition, now, false);

    startAnimation();
    return;
  }

  lastReportedPosition = reportedPosition;
  const incomingPosition = getTimelinePosition(media, wallNow);
  const difference = incomingPosition - currentPosition;

  // A small backwards correction is usually sample jitter. Keep the logical
  // playhead monotonic; a clear backwards seek still resets immediately.
  if (difference < -BACKWARD_SEEK_THRESHOLD_SECONDS ||
      difference > FORWARD_SNAP_THRESHOLD_SECONDS) {
    setPosition(incomingPosition, now, true);
    renderPosition(visualPosition, true);
    return;
  }

  setPosition(difference < 0 ? currentPosition : incomingPosition, now, false);
  startAnimation();
}

function updateProgress() {
  animationFrame = 0;
  if (sleeping || document.hidden || syncMode !== SYNC.RUNNING || !state)
    return;

  const now = performance.now();
  const targetPosition = getLogicalPosition(now);
  const deltaMs = Math.max(0, now - lastFrameAt);
  const gap = targetPosition - visualPosition;
  const smoothingMs = gap > 0.6
    ? RECOVERY_SMOOTHING_MS
    : NORMAL_SMOOTHING_MS;

  visualPosition = clampToDuration(
    smoothPosition(visualPosition, targetPosition, deltaMs, smoothingMs)
  );
  lastFrameAt = now;
  renderPosition(visualPosition);
  startAnimation();
}

function render(media) {
  const available = Boolean(media?.isAvailable);
  if (!available) {
    enterSleep("no-media", true);
    return;
  }

  const now = performance.now();
  const previousState = state;
  const nextTrackKey = getTrackKey(media);
  const trackChanged = nextTrackKey !== currentTrackKey;
  const wasPlaying = previousState?.playbackStatus === "Playing";

  state = media;

  if (media.playbackStatus === "Stopped" || media.playbackStatus === "Closed") {
    enterSleep("stopped");
    return;
  }

  if (media.playbackStatus === "Paused") {
    currentTrackKey = nextTrackKey;
    syncMode = SYNC.PAUSED;
    stopAnimation();
    lastReportedPosition = getReportedPosition(media, getLogicalPosition(now));
    setPosition(lastReportedPosition, now, true);
    wakePage();
    renderMetadata(media);
    setCover(media.coverUrl || null);
    renderPosition(visualPosition, true);
    schedulePausedSleep();
    return;
  }

  if (media.playbackStatus !== "Playing") {
    enterSleep("stopped");
    return;
  }

  clearPauseSleepTimer();
  wakePage();

  if (trackChanged || !wasPlaying || syncMode === SYNC.PAUSED || syncMode === SYNC.SLEEPING) {
    currentTrackKey = nextTrackKey;
    syncMode = SYNC.RUNNING;
    renderMetadata(media);
    setCover(media.coverUrl || null);
    resetPlayhead(media, now, true);
    startAnimation();
    return;
  }

  renderMetadata(media);
  setCover(media.coverUrl || null);
  synchronizePosition(media, now);
}

function handleVisibilityChange() {
  if (document.hidden) {
    if (syncMode === SYNC.RUNNING)
      setPosition(getLogicalPosition(), performance.now(), false);
    stopAnimation();
    return;
  }

  if (!state || sleeping) return;
  if (state.playbackStatus === "Playing") {
    syncMode = SYNC.RUNNING;
    startAnimation();
  } else if (state.playbackStatus === "Paused") {
    renderPosition(visualPosition, true);
  }
}

document.addEventListener("visibilitychange", handleVisibilityChange);
window.addEventListener("pagehide", () => {
  stopAnimation();
  clearPauseSleepTimer();
  releaseCover();
});
window.addEventListener("pageshow", () => {
  if (state && !sleeping) {
    setCover(state.coverUrl || null);
    if (state.playbackStatus === "Playing") {
      syncMode = SYNC.RUNNING;
      startAnimation();
    } else {
      renderPosition(visualPosition, true);
      if (state.playbackStatus === "Paused")
        schedulePausedSleep();
    }
  }
});

if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(render);
} else {
  console.error("FluentFlyout browser API was not loaded. Include /js/fluentflyout-api.js before app.js.");
}
