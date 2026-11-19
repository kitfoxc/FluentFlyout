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
  WAITING: "waiting",
  CALIBRATING: "calibrating",
  RUNNING: "running",
  STALLED: "stalled",
  PAUSED: "paused"
});

const PAUSED_SLEEP_MS = 5 * 60 * 1000;
const CALIBRATION_TIMEOUT_MS = 5000;
const CALIBRATION_MIN_SAMPLES = 3;
const CALIBRATION_MIN_SPAN_MS = 500;
const CALIBRATION_MIN_ADVANCE = 0.12;
const STALL_TIMEOUT_MS = 3500;
const STALE_TIMELINE_MS = 4500;
const RECOVERY_SMOOTH_MAX_SECONDS = 8;

let state = null;
let syncMode = SYNC.SLEEPING;
let animationFrame = 0;
let pauseSleepTimer = 0;
let currentCoverUrl = null;
let pendingCoverImage = null;
let currentTrackKey = null;
let sleeping = true;
let sleepReason = "no-media";
let lastPositionSample = null;
let lastAdvanceAt = 0;
let calibrationStartedAt = 0;
let calibrationSamples = [];
let recoverySamples = [];

// The browser owns a continuous playhead only after SMTC's timeline has been
// observed advancing. During startup and buffering it deliberately holds still.
let positionAnchor = 0;
let positionAnchorAt = performance.now();
let correctionAmount = 0;
let correctionStartedAt = 0;
let correctionDuration = 900;

const maxSoftCorrection = 0.6;
const seekSnapThreshold = 3.0;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function getTrackKey(media) {
  return [media?.sessionId || "", media?.title || ""].join("\u001f");
}

function getTimelineAgeMs(media) {
  const timestamp = Date.parse(media?.timelineLastUpdatedTime || "");
  // Some SMTC providers leave LastUpdatedTime at DateTimeOffset.MinValue.
  // Treat that sentinel as unavailable and fall back to event-arrival timing.
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1)) return null;
  return Date.now() - timestamp;
}

function hasFreshTimeline(media) {
  const age = getTimelineAgeMs(media);
  // Older themes/sources may not send this additive field. In that case,
  // event arrival time remains the fallback freshness signal.
  return age === null || (age >= -1000 && age <= STALE_TIMELINE_MS);
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
  correctionAmount = 0;
  releaseCover();
  elements.widget.classList.add("is-hidden", "is-sleeping");

  if (clearMedia) {
    state = null;
    currentTrackKey = null;
    calibrationSamples = [];
    recoverySamples = [];
    lastPositionSample = null;
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

function getInterpolatedPosition(now = performance.now()) {
  if (!state) return 0;

  const elapsed = syncMode === SYNC.RUNNING && state.playbackStatus === "Playing"
    ? Math.max(0, now - positionAnchorAt) / 1000
    : 0;

  let position = positionAnchor + elapsed;

  if (correctionAmount !== 0) {
    const progress = Math.min(1, Math.max(0, (now - correctionStartedAt) / correctionDuration));
    const easedProgress = progress * progress * (3 - 2 * progress);
    position += correctionAmount * easedProgress;

    if (progress >= 1) {
      positionAnchor = position;
      positionAnchorAt = now;
      correctionAmount = 0;
    }
  }

  const duration = Math.max(0, Number(state.duration) || 0);
  return duration > 0
    ? Math.min(duration, Math.max(0, position))
    : Math.max(0, position);
}

function renderPosition(position) {
  const duration = Math.max(0, Number(state?.duration) || 0);
  elements.progressFill.style.width = duration > 0
    ? `${(Math.max(0, Math.min(duration, position)) / duration) * 100}%`
    : "0%";
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(duration);
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

function resetAnchor(position, now = performance.now()) {
  positionAnchor = Math.max(0, Number(position) || 0);
  positionAnchorAt = now;
  correctionAmount = 0;
  correctionStartedAt = now;
  correctionDuration = 900;
}

function beginCalibration(media, now) {
  const position = Math.max(0, Number(media.position) || 0);
  syncMode = SYNC.CALIBRATING;
  calibrationStartedAt = now;
  calibrationSamples = [{ position, at: now, fresh: hasFreshTimeline(media) }];
  recoverySamples = [];
  lastPositionSample = position;
  lastAdvanceAt = now;
  resetAnchor(position, now);
  stopAnimation();
  renderPosition(position);
}

function enterStalled(now) {
  if (syncMode === SYNC.RUNNING)
    resetAnchor(getInterpolatedPosition(now), now);
  syncMode = SYNC.STALLED;
  calibrationSamples = [];
  recoverySamples = [];
  stopAnimation();
  renderPosition(positionAnchor);
}

function startRunning(position, now, recovery = false) {
  const target = Math.max(0, Number(position) || 0);

  if (recovery) {
    const difference = target - positionAnchor;
    if (difference < -0.8 || Math.abs(difference) > RECOVERY_SMOOTH_MAX_SECONDS) {
      resetAnchor(target, now);
    } else {
      correctionAmount = difference;
      correctionStartedAt = now;
      correctionDuration = Math.max(900, Math.min(2200, Math.abs(difference) * 350));
      positionAnchorAt = now;
    }
  } else {
    resetAnchor(target, now);
  }

  syncMode = SYNC.RUNNING;
  lastAdvanceAt = now;
  lastPositionSample = target;
  calibrationSamples = [];
  recoverySamples = [];
  startAnimation();
}

function processCalibrationSample(position, now, media) {
  if (!hasFreshTimeline(media)) {
    if (now - calibrationStartedAt >= CALIBRATION_TIMEOUT_MS)
      enterStalled(now);
    return;
  }

  calibrationSamples.push({ position, at: now, fresh: true });
  calibrationSamples = calibrationSamples.filter(sample => now - sample.at <= 2000);

  if (calibrationSamples.length >= CALIBRATION_MIN_SAMPLES) {
    const first = calibrationSamples[0];
    const latest = calibrationSamples[calibrationSamples.length - 1];
    const span = latest.at - first.at;
    const advance = latest.position - first.position;

    if (span >= CALIBRATION_MIN_SPAN_MS && advance >= CALIBRATION_MIN_ADVANCE) {
      startRunning(position, now);
      return;
    }

    // A backwards movement during startup is likely a seek/reset, not proof
    // that playback has begun. Restart the sample window at the new position.
    if (advance < -0.25)
      calibrationSamples = [{ position, at: now, fresh: true }];
  }

  if (now - calibrationStartedAt >= CALIBRATION_TIMEOUT_MS) {
    resetAnchor(position, now);
    syncMode = SYNC.STALLED;
    recoverySamples = [];
    renderPosition(position);
  }
}

function processStalledSample(position, now, media) {
  if (!hasFreshTimeline(media)) return;

  recoverySamples.push({ position, at: now });
  recoverySamples = recoverySamples.filter(sample => now - sample.at <= 1200);

  if (recoverySamples.length >= 2) {
    const first = recoverySamples[0];
    const latest = recoverySamples[recoverySamples.length - 1];
    if (latest.position - first.position >= 0.12 && latest.at - first.at >= 200) {
      startRunning(position, now, true);
      return;
    }
  }

  lastPositionSample = position;
}

function synchronizePosition(media, now) {
  const incomingPosition = Math.max(0, Number(media.position) || 0);

  if (syncMode === SYNC.CALIBRATING) {
    processCalibrationSample(incomingPosition, now, media);
    return;
  }

  if (syncMode === SYNC.STALLED || syncMode === SYNC.WAITING) {
    processStalledSample(incomingPosition, now, media);
    return;
  }

  if (syncMode !== SYNC.RUNNING) {
    beginCalibration(media, now);
    return;
  }

  if (!hasFreshTimeline(media)) {
    enterStalled(now);
    return;
  }

  const currentPosition = getInterpolatedPosition(now);
  const difference = incomingPosition - currentPosition;
  const previousSample = lastPositionSample;
  const timeSinceLastAdvance = now - lastAdvanceAt;

  if (previousSample !== null && incomingPosition > previousSample + 0.04)
    lastAdvanceAt = now;

  lastPositionSample = incomingPosition;

  // A clear backwards seek or a large discontinuity while actively running
  // should remain responsive. Ordinary drift is slewed instead of snapped.
  if (difference >= seekSnapThreshold
      && difference <= RECOVERY_SMOOTH_MAX_SECONDS
      && timeSinceLastAdvance >= 1000) {
    // A forward jump after a period without timeline advancement is more
    // likely a buffer recovery than an intentional seek. Ease toward it.
    positionAnchor = currentPosition;
    positionAnchorAt = now;
    correctionAmount = difference;
    correctionStartedAt = now;
    correctionDuration = Math.max(900, Math.min(2200, difference * 350));
    lastAdvanceAt = now;
    startAnimation();
    return;
  }

  if (difference < -0.8 || Math.abs(difference) >= seekSnapThreshold) {
    resetAnchor(incomingPosition, now);
    lastAdvanceAt = now;
    renderPosition(incomingPosition);
    return;
  }

  positionAnchor = currentPosition;
  positionAnchorAt = now;
  correctionAmount = Math.max(-maxSoftCorrection, Math.min(maxSoftCorrection, difference));
  correctionStartedAt = now;
  correctionDuration = 900;
}

function updateProgress() {
  animationFrame = 0;
  if (sleeping || document.hidden || syncMode !== SYNC.RUNNING || !state)
    return;

  const now = performance.now();
  if (now - lastAdvanceAt > STALL_TIMEOUT_MS) {
    enterStalled(now);
    return;
  }

  renderPosition(getInterpolatedPosition(now));
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
    if (trackChanged || previousState?.playbackStatus !== "Paused") {
      currentTrackKey = nextTrackKey;
      syncMode = SYNC.PAUSED;
      resetAnchor(media.position, now);
      calibrationSamples = [];
      recoverySamples = [];
      stopAnimation();
    }

    if (sleeping && sleepReason === "paused") {
      schedulePausedSleep();
      return;
    }

    wakePage();
    renderMetadata(media);
    setCover(media.coverUrl || null);
    renderPosition(Math.max(0, Number(media.position) || positionAnchor));
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
    renderMetadata(media);
    setCover(media.coverUrl || null);
    beginCalibration(media, now);
    return;
  }

  renderMetadata(media);
  setCover(media.coverUrl || null);
  synchronizePosition(media, now);

  if (syncMode !== SYNC.RUNNING)
    renderPosition(positionAnchor);
}

function handleVisibilityChange() {
  if (document.hidden) {
    if (syncMode === SYNC.RUNNING)
      resetAnchor(getInterpolatedPosition(), performance.now());
    stopAnimation();
    return;
  }

  if (!state || sleeping) return;
  if (state.playbackStatus === "Playing") {
    beginCalibration(state, performance.now());
  } else if (state.playbackStatus === "Paused") {
    renderPosition(Math.max(0, Number(state.position) || positionAnchor));
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
    if (state.playbackStatus === "Playing")
      beginCalibration(state, performance.now());
    else {
      renderPosition(positionAnchor);
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
