(() => {
"use strict";

/*
 * Minimalist Player — FluentFlyout WebSocket renderer.
 *
 * REQUIRED:
 * - The host serves /js/fluentflyout-api.js on the same origin.
 * - Use window.FluentFlyout.onMediaChanged / onConnectionChanged.
 * - Protocol 1.0 media fields use lower camel case.
 * - The application adapter owns auth, reconnects, sequence filtering and
 *   tokenized coverUrl generation. Do not add a second socket or polling loop.
 *
 * Progress behavior is synchronized with the project's
 * fix/obs-visual-progress-stability branch.
 */

// CUSTOMIZABLE renderer settings.
const DEFAULTS = Object.freeze({
  TITLE: "Nothing Playing",
  ARTIST: "Get the music started",
  ALBUM: "Unknown Album",
  COVER: "./assets/default-cover.svg"
});

const CONFIG = Object.freeze({
  pauseSleepMs: 5 * 60 * 1000,
  normalSmoothingMs: 150,
  recoverySmoothingMs: 500,
  backwardSeekThresholdSeconds: 0.8,
  forwardSnapThresholdSeconds: 8,
  startupGuardMaxMs: 4200,
  startupAdvancingSamples: 2,
  startupMinPositionStepSeconds: 0.05,
  startupCatchUpToleranceSeconds: 0.15,
  textUpdateIntervalMs: 200,
  // CUSTOMIZABLE: smoothing time constant for explicit forward/backward seeks.
  seekSmoothingMs: 420,
  // CUSTOMIZABLE: cut-to-zero transition duration when the track changes.
  trackChangeResetMs: 360,
  // CUSTOMIZABLE: duration for visual corrections after a snapshot jump.
  progressCorrectionMs: 360
});

const SCROLL_SETTINGS = Object.freeze({
  titleSpeed: 12,
  artistAlbumSpeed: 12,
  // CUSTOMIZABLE: pause after each complete scrolling pass.
  pauseDurationMs: 1200
});

const MODE = Object.freeze({
  EFFICIENCY: "efficiency",
  RUNNING: "running",
  PAUSED: "paused"
});

const dom = {
  player: document.getElementById("player"),
  titleContainer: document.getElementById("track-title"),
  titleScroller: document.getElementById("title-scroller"),
  artistAlbumContainer: document.getElementById("track-artist-album-container"),
  artistAlbumScroller: document.getElementById("artist-album-scroller"),
  artistAlbumText: document.getElementById("track-artist-album-text"),
  cover: document.getElementById("album-cover"),
  timePercent: document.getElementById("time-percent"),
  progressTrack: document.getElementById("progress-track"),
  progressFill: document.getElementById("progress-fill"),
  progressThumb: document.getElementById("progress-thumb")
};

// ---- Project progress helpers (same semantics as progress-utils.js) ----
function getReportedPosition(media, fallback = 0) {
  const raw = media?.position;
  if (raw === null || raw === undefined || raw === "") {
    return Math.max(0, Number(fallback) || 0);
  }
  const position = Number(raw);
  return Number.isFinite(position) && position >= 0
    ? position
    : Math.max(0, Number(fallback) || 0);
}

function parseAnchorTimestamp(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1)) return null;
  if (timestamp - now > 1000) return null;
  return timestamp;
}

function hasValidTimelineTimestamp(media, now = Date.now()) {
  return parseAnchorTimestamp(media?.timelineLastUpdatedTime, now) !== null;
}

// A percentage is meaningful only when duration is known and there is at
// least one usable position/timestamp source. Otherwise render a stable 0%.
function hasUsableProgressData(media, now = Date.now()) {
  const duration = Number(media?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return false;

  const rawPosition = media?.position;
  const position = Number(rawPosition);
  const hasPosition =
    rawPosition !== null &&
    rawPosition !== undefined &&
    rawPosition !== "" &&
    Number.isFinite(position) &&
    position >= 0;

  const hasTimestamp =
    parseAnchorTimestamp(media?.timelineLastUpdatedTime, now) !== null ||
    parseAnchorTimestamp(media?.updatedAt, now) !== null;

  return hasPosition || hasTimestamp;
}

function clampPosition(position, duration = 0) {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  const safeDuration = Number(duration);
  return Number.isFinite(safeDuration) && safeDuration > 0
    ? Math.min(safeDuration, safePosition)
    : safePosition;
}

function getTimelinePosition(media, now = Date.now()) {
  const reported = getReportedPosition(media);
  const timestamp =
    parseAnchorTimestamp(media?.timelineLastUpdatedTime, now) ??
    parseAnchorTimestamp(media?.updatedAt, now);

  if (timestamp === null) return clampPosition(reported, media?.duration);
  return clampPosition(reported + Math.max(0, now - timestamp) / 1000, media?.duration);
}

function smoothPosition(current, target, deltaMs, timeConstantMs) {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : safeCurrent;
  const elapsed = Math.max(0, Number(deltaMs) || 0);
  const timeConstant = Math.max(1, Number(timeConstantMs) || 1);
  const alpha = 1 - Math.exp(-elapsed / timeConstant);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}

// Bounded startup guard for transient backward SMTC timeline samples.
function createStartupProgressGuard({
  maxDurationMs = 4200,
  minAdvancingSamples = 2,
  minPositionStepSeconds = 0.05,
  catchUpToleranceSeconds = 0.15
} = {}) {
  let active = false;
  let startedAt = 0;
  let lastReportedPosition = null;
  let advancingSamples = 0;

  const finitePosition = value => {
    const number = Number(value);
    return value !== null && value !== undefined && value !== "" &&
      Number.isFinite(number) && number >= 0 ? number : null;
  };

  const result = (released, reason = null, incoming = null, visual = null) => ({
    active,
    released,
    reason,
    hold: active && incoming !== null && visual !== null &&
      incoming < visual - catchUpToleranceSeconds,
    advancingSamples
  });

  return {
    start(initialPosition, now = 0) {
      active = true;
      startedAt = Number.isFinite(now) ? now : 0;
      lastReportedPosition = finitePosition(initialPosition);
      advancingSamples = 0;
      return result(false);
    },
    cancel() {
      active = false;
      advancingSamples = 0;
      return result(false);
    },
    observe({
      reportedPosition,
      incomingPosition,
      visualPosition,
      now = 0,
      explicitSeek = false
    } = {}) {
      if (!active) return result(false);
      if (explicitSeek) {
        active = false;
        return result(true, "seek");
      }

      const reported = finitePosition(reportedPosition);
      if (reported !== null) {
        if (lastReportedPosition !== null) {
          const delta = reported - lastReportedPosition;
          advancingSamples = delta >= minPositionStepSeconds
            ? advancingSamples + 1
            : 0;
        }
        lastReportedPosition = reported;
      }

      const incoming = finitePosition(incomingPosition);
      const visual = finitePosition(visualPosition);
      const caughtUp = incoming !== null && visual !== null &&
        incoming >= visual - catchUpToleranceSeconds;

      if (advancingSamples >= minAdvancingSamples && caughtUp) {
        active = false;
        return result(true, "stable");
      }
      if (Number.isFinite(now) && now - startedAt >= maxDurationMs) {
        active = false;
        return result(true, "timeout");
      }
      return result(false, null, incoming, visual);
    },
    get isActive() {
      return active;
    }
  };
}

const startupGuard = createStartupProgressGuard({
  maxDurationMs: CONFIG.startupGuardMaxMs,
  minAdvancingSamples: CONFIG.startupAdvancingSamples,
  minPositionStepSeconds: CONFIG.startupMinPositionStepSeconds,
  catchUpToleranceSeconds: CONFIG.startupCatchUpToleranceSeconds
});

// ---- Renderer state ----
let mediaState = null;
let mode = MODE.EFFICIENCY;
let sleepReason = "等待媒体快照";
let animationFrame = 0;
let pauseTimer = 0;
let disconnected = false;
let awaitingFreshSnapshot = false;

let currentTrackKey = null;
let currentTitleStr = DEFAULTS.TITLE;
let currentArtistAlbumStr = DEFAULTS.ARTIST;
let titleScrollAnimation = null;
let artistAlbumScrollAnimation = null;
let currentCoverUrl = "";
let pendingCoverImage = null;
let coverGeneration = 0;

let logicalAnchor = 0;
let logicalAnchorAt = performance.now();
let visualPosition = 0;
let displayedPercent = 0;
let progressCorrection = null;
let seekSmoothingActive = false;
let trackResetTransition = null;
let lastFrameAt = 0;
let lastTextAt = 0;
let lastReportedPosition = null;

// ---- Basic utilities ----
function setText(node, value) {
  if (node) {
    node.textContent = value === null || value === undefined || value === ""
      ? "—"
      : String(value);
  }
}

function durationSeconds() {
  const value = Number(mediaState?.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampToDuration(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? Math.max(0, number) : 0;
  const duration = durationSeconds();
  return duration > 0 ? Math.min(duration, safe) : safe;
}

function trackKey(media) {
  return [
    media?.sessionId || "",
    media?.title || "",
    media?.artist || ""
  ].join("\u001f");
}

function logicalPosition(now = performance.now()) {
  const advancing = !awaitingFreshSnapshot && mode === MODE.RUNNING &&
    mediaState?.playbackStatus === "Playing";
  const elapsed = advancing ? Math.max(0, now - logicalAnchorAt) / 1000 : 0;
  return clampToDuration(logicalAnchor + elapsed);
}

function setAnchor(position, now = performance.now(), syncVisual = false) {
  logicalAnchor = clampToDuration(position);
  logicalAnchorAt = now;
  if (syncVisual) visualPosition = logicalAnchor;
}

function clearPauseTimer() {
  if (pauseTimer) window.clearTimeout(pauseTimer);
  pauseTimer = 0;
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function startAnimation() {
  const canAnimatePlayback = mode === MODE.RUNNING;
  const canAnimatePausedSeek = mode === MODE.PAUSED && seekSmoothingActive;
  if (
    animationFrame ||
    awaitingFreshSnapshot ||
    (!canAnimatePlayback && !canAnimatePausedSeek && !progressCorrection) ||
    document.hidden
  ) return;
  lastFrameAt = performance.now();
  animationFrame = requestAnimationFrame(updateProgress);
}

function setStartupGuardState(active) {
  dom.player.classList.toggle("is-startup-hold", Boolean(active));
}

function beginStartupGuard(media, now = performance.now()) {
  if (hasValidTimelineTimestamp(media, Date.now())) {
    startupGuard.start(getReportedPosition(media), now);
    setStartupGuardState(true);
  } else {
    startupGuard.cancel();
    setStartupGuardState(false);
  }
}

// ---- Responsive text scrolling (safe textContent instead of HTML injection) ----
function createScrollSpan(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function cancelTextScrollAnimation(animation) {
  if (animation) animation.cancel();
}

function startTextScrollAnimation(scroller, firstSpan, speed) {
  if (typeof scroller.animate !== "function") return null;

  // The duplicated text occupies two equal halves. Moving by -50% completes
  // exactly one pass and places the duplicate at the original starting point.
  const distance = firstSpan.offsetWidth;
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const travelMs = Math.max(1, distance / Math.max(1, speed) * 1000);
  const pauseMs = Math.max(0, SCROLL_SETTINGS.pauseDurationMs);
  const cycleMs = travelMs + pauseMs;
  const travelOffset = travelMs / cycleMs;

  return scroller.animate(
    [
      {
        transform: "translateX(0)",
        // Ease in at the start, then ease out smoothly before the pause.
        easing: "cubic-bezier(0.42, 0, 0.58, 1)"
      },
      {
        transform: "translateX(-50%)",
        offset: travelOffset,
        easing: "linear"
      },
      { transform: "translateX(-50%)", offset: 1 }
    ],
    {
      duration: cycleMs,
      iterations: Infinity,
      easing: "linear"
    }
  );
}

function checkTitleScroll(force = false) {
  if (!dom.titleContainer || !dom.titleScroller) return;
  if (!force && dom.titleScroller.dataset.text === currentTitleStr) return;

  cancelTextScrollAnimation(titleScrollAnimation);
  titleScrollAnimation = null;

  const span = createScrollSpan(currentTitleStr);
  dom.titleScroller.replaceChildren(span);
  dom.titleScroller.classList.remove("animate");
  dom.titleContainer.classList.remove("is-scrolling");
  dom.titleScroller.style.animationDuration = "0s";
  dom.titleScroller.style.transform = "";
  dom.titleScroller.dataset.text = currentTitleStr;

  if (span.offsetWidth > dom.titleContainer.clientWidth) {
    dom.titleScroller.appendChild(span.cloneNode(true));
    dom.titleScroller.classList.add("animate");
    dom.titleContainer.classList.add("is-scrolling");
    titleScrollAnimation = startTextScrollAnimation(
      dom.titleScroller,
      span,
      SCROLL_SETTINGS.titleSpeed
    );
  }
}

function checkArtistAlbumScroll(force = false) {
  if (!dom.artistAlbumContainer || !dom.artistAlbumScroller) return;
  if (!force && dom.artistAlbumScroller.dataset.text === currentArtistAlbumStr) return;

  cancelTextScrollAnimation(artistAlbumScrollAnimation);
  artistAlbumScrollAnimation = null;

  const span = createScrollSpan(currentArtistAlbumStr);
  dom.artistAlbumScroller.replaceChildren(span);
  dom.artistAlbumScroller.classList.remove("animate");
  dom.artistAlbumContainer.classList.remove("is-scrolling");
  dom.artistAlbumScroller.style.animationDuration = "0s";
  dom.artistAlbumScroller.style.transform = "";
  dom.artistAlbumScroller.dataset.text = currentArtistAlbumStr;

  if (span.offsetWidth > dom.artistAlbumContainer.clientWidth) {
    dom.artistAlbumScroller.appendChild(span.cloneNode(true));
    dom.artistAlbumScroller.classList.add("animate");
    dom.artistAlbumContainer.classList.add("is-scrolling");
    artistAlbumScrollAnimation = startTextScrollAnimation(
      dom.artistAlbumScroller,
      span,
      SCROLL_SETTINGS.artistAlbumSpeed
    );
  }
}

function updateTrackText(title, artistAlbum) {
  if (title !== currentTitleStr) {
    currentTitleStr = title;
    dom.titleContainer.title = title;
    window.setTimeout(() => checkTitleScroll(true), 0);
  }

  if (artistAlbum !== currentArtistAlbumStr) {
    currentArtistAlbumStr = artistAlbum;
    dom.artistAlbumContainer.title = artistAlbum;
    setText(dom.artistAlbumText, artistAlbum);
    window.setTimeout(() => checkArtistAlbumScroll(true), 0);
  }
}

// The design-space line widths are fixed; viewport resizing scales the whole stage.
document.fonts.ready.then(() => {
  checkTitleScroll(true);
  checkArtistAlbumScroll(true);
});

// ---- Cover art: use adapter-supplied authenticated coverUrl directly ----
function releaseCoverRequest() {
  coverGeneration += 1;
  if (pendingCoverImage) {
    pendingCoverImage.onload = null;
    pendingCoverImage.onerror = null;
    pendingCoverImage.src = "";
    pendingCoverImage = null;
  }
}

function setCover(url) {
  const nextUrl = typeof url === "string" && url.trim()
    ? url
    : DEFAULTS.COVER;

  if (nextUrl === currentCoverUrl) return;

  releaseCoverRequest();
  currentCoverUrl = nextUrl;
  const generation = coverGeneration;
  dom.cover.classList.remove("loaded");

  const image = new Image();
  pendingCoverImage = image;

  image.onload = () => {
    if (generation !== coverGeneration || currentCoverUrl !== nextUrl) return;
    pendingCoverImage = null;
    dom.cover.src = nextUrl;
    dom.cover.classList.add("loaded");
  };

  image.onerror = () => {
    if (generation !== coverGeneration || currentCoverUrl !== nextUrl) return;
    pendingCoverImage = null;

    if (nextUrl !== DEFAULTS.COVER) {
      currentCoverUrl = "";
      setCover(DEFAULTS.COVER);
    } else {
      dom.cover.removeAttribute("src");
      dom.cover.classList.remove("loaded");
    }
  };

  image.src = nextUrl;
}

// ---- Metadata and progress UI ----
function renderMetadata(media) {
  const hasTrack = Boolean(
    media?.isAvailable &&
    typeof media.title === "string" &&
    media.title.trim()
  );

  const title = hasTrack ? media.title : DEFAULTS.TITLE;
  const artist = hasTrack ? (media.artist || "Unknown Artist") : DEFAULTS.ARTIST;
  const album = hasTrack ? (media.album || "") : "";
  updateTrackText(title, album ? `${artist} - ${album}` : artist);
}

function progressPercent(position) {
  if (!hasUsableProgressData(mediaState)) return 0;
  return clampToDuration(position) / durationSeconds() * 100;
}

function transitionProgress(position) {
  const target = progressPercent(position);
  if (target !== progressCorrection?.target) {
    progressCorrection = target === displayedPercent ? null : {
      from: displayedPercent,
      target,
      startedAt: performance.now()
    };
  }
  renderProgress(position, true);
  startAnimation();
}

function renderProgress(position, forceText = false, percentageOverride = null) {
  const now = performance.now();
  let percentage = percentageOverride ?? progressPercent(position);
  if (percentageOverride === null && progressCorrection) {
    const elapsed = Math.max(0, now - progressCorrection.startedAt);
    const progress = Math.min(1, elapsed / Math.max(1, CONFIG.progressCorrectionMs));
    if (progress >= 1) {
      progressCorrection = null;
      forceText = true;
    } else {
      const from = progressCorrection.from;
      percentage = from + (percentage - from) * (1 - (1 - progress) ** 3);
    }
  }
  displayedPercent = percentage;

  // Actual width is used because the thumb is positioned at the fill's 100% edge.
  dom.progressFill.style.width = `${percentage}%`;
  dom.progressThumb.hidden = false;

  dom.progressTrack.setAttribute("aria-valuenow", percentage.toFixed(1));
  dom.progressTrack.setAttribute("aria-valuetext", `${percentage.toFixed(1)}%`);

  if (forceText || now - lastTextAt >= CONFIG.textUpdateIntervalMs) {
    setText(dom.timePercent, `${Math.round(percentage)}%`);
    lastTextAt = now;
  }
}

// ---- Power-saving and playback transitions ----
function enterEfficiencyMode(reason) {
  trackResetTransition = null;
  seekSmoothingActive = false;
  startupGuard.cancel();
  setStartupGuardState(false);
  mode = MODE.EFFICIENCY;
  sleepReason = reason;
  stopAnimation();
  clearPauseTimer();
  dom.player.classList.add("is-efficiency");
  dom.player.dataset.renderState = "efficiency";
  dom.player.dataset.sleepReason = reason;
}

function wakeRenderer() {
  mode = MODE.RUNNING;
  sleepReason = "";
  dom.player.classList.remove("is-efficiency");
  dom.player.dataset.renderState = "running";
  dom.player.dataset.sleepReason = "";
}

function schedulePausedSleep() {
  clearPauseTimer();
  pauseTimer = window.setTimeout(() => {
    pauseTimer = 0;
    if (mediaState?.playbackStatus === "Paused") {
      enterEfficiencyMode("暂停超过 5 分钟");
    }
  }, CONFIG.pauseSleepMs);
}

function renderUnavailableState() {
  updateTrackText(DEFAULTS.TITLE, DEFAULTS.ARTIST);
  setCover(DEFAULTS.COVER);
  transitionProgress(0);
}

function handlePaused(media) {
  trackResetTransition = null;
  clearPauseTimer();
  mode = MODE.PAUSED;

  const now = performance.now();
  const reportedPosition = getReportedPosition(media);
  const pausedPosition = startupGuard.isActive
    ? Math.max(visualPosition, getTimelinePosition(media, Date.now()))
    : getReportedPosition(media, logicalPosition(now));

  const pausedSeekDetected =
    lastReportedPosition !== null &&
    (
      reportedPosition < lastReportedPosition - CONFIG.backwardSeekThresholdSeconds ||
      reportedPosition - lastReportedPosition > CONFIG.forwardSnapThresholdSeconds
    );
  const continuePausedSeekSmoothing =
    seekSmoothingActive || pausedSeekDetected;

  startupGuard.cancel();
  setStartupGuardState(false);

  // Preserve an in-flight paused seek across ordinary state snapshots.
  // Otherwise the next non-seek snapshot could snap the thumb to its target.
  setAnchor(pausedPosition, now, !continuePausedSeekSmoothing);
  seekSmoothingActive = continuePausedSeekSmoothing;
  lastReportedPosition = reportedPosition;
  transitionProgress(visualPosition);

  dom.player.classList.remove("is-efficiency");
  dom.player.dataset.renderState = "paused";
  dom.player.dataset.sleepReason = "暂停计时中";
  if (seekSmoothingActive) startAnimation();
  schedulePausedSleep();
}

function handlePlaying(media, changedTrack, previousTrackPercent, resync) {
  clearPauseTimer();
  seekSmoothingActive = false;

  const resetForNewPlayback = changedTrack || resync || [
    "没有可用的媒体会话",
    "播放已停止",
    "媒体会话已关闭"
  ].includes(sleepReason);

  const now = performance.now();
  const initial = getTimelinePosition(media, Date.now());
  const reported = getReportedPosition(media);
  wakeRenderer();

  if (resetForNewPlayback) {
    setAnchor(initial, now, true);
    beginStartupGuard(media, now);

    // On a real track change, animate the old track's percentage back to zero.
    // Keep the new track's logical anchor intact while only the visual fill resets.
    if (
      changedTrack &&
      hasUsableProgressData(media) &&
      previousTrackPercent !== null &&
      previousTrackPercent > 0
    ) {
      progressCorrection = null;
      trackResetTransition = {
        fromPercent: previousTrackPercent,
        startedAt: now,
        durationMs: CONFIG.trackChangeResetMs
      };
    } else {
      trackResetTransition = null;
    }
  } else {
    trackResetTransition = null;
    startupGuard.cancel();
    setStartupGuardState(false);
    setAnchor(Math.max(initial, visualPosition), now, false);
  }

  lastReportedPosition = reported;
  if (trackResetTransition) {
    renderProgress(0, true, trackResetTransition.fromPercent);
  } else {
    transitionProgress(visualPosition);
  }
  startAnimation();
}

function handlePlayingUpdate(media) {
  const now = performance.now();
  const reported = getReportedPosition(media);
  const current = logicalPosition(now);
  const wallNow = Date.now();
  const timelineValid = hasValidTimelineTimestamp(media, wallNow);
  const incoming = getTimelinePosition(media, wallNow);

  const backwardSeek = lastReportedPosition !== null &&
    reported < lastReportedPosition - CONFIG.backwardSeekThresholdSeconds;
  const forwardSeek = incoming - current > CONFIG.forwardSnapThresholdSeconds;
  let handledByStartupGuard = false;

  if (startupGuard.isActive && !timelineValid) {
    startupGuard.cancel();
    setStartupGuardState(false);
  }

  if (startupGuard.isActive && timelineValid) {
    handledByStartupGuard = true;
    const guard = startupGuard.observe({
      reportedPosition: reported,
      incomingPosition: incoming,
      visualPosition,
      now,
      explicitSeek: backwardSeek || forwardSeek
    });

    if (guard.released) {
      setStartupGuardState(false);
      if (guard.reason === "seek") {
        setAnchor(incoming, now, false);
        seekSmoothingActive = true;
      } else {
        setAnchor(Math.max(incoming, visualPosition), now, false);
      }
    } else {
      // Source anchor updates, but the visible playhead is held against rollback.
      setAnchor(incoming, now, false);
    }
  }

  if (!handledByStartupGuard) {
    if (!timelineValid) {
      if (backwardSeek) {
        setAnchor(reported, now, false);
        seekSmoothingActive = true;
      } else if (reported - current > CONFIG.forwardSnapThresholdSeconds) {
        setAnchor(reported, now, false);
        seekSmoothingActive = true;
      } else if (reported - current > 0.6) {
        setAnchor(reported, now, false);
      }
    } else {
      const difference = incoming - current;

      // A timestamp-only backward correction is not treated as a seek.
      if (backwardSeek || forwardSeek) {
        setAnchor(incoming, now, false);
        seekSmoothingActive = true;
      } else {
        setAnchor(difference < 0 ? current : incoming, now, false);
      }
    }
  }

  lastReportedPosition = reported;
  startAnimation();
}

let ringPlaybackActive = false;
function publishPlayback(playing) {
  if (playing === ringPlaybackActive) return;
  ringPlaybackActive = playing;
  window.dispatchEvent(new CustomEvent("color-player-playback", { detail: playing }));
}

function renderMedia(media) {
  if (disconnected) return;
  publishPlayback(Boolean(media?.isAvailable && media.playbackStatus === "Playing"));
  const resync = awaitingFreshSnapshot;
  awaitingFreshSnapshot = false;

  if (!media) {
    mediaState = null;
    currentTrackKey = null;
    lastReportedPosition = null;
    setAnchor(0, performance.now(), true);
    enterEfficiencyMode("没有可用的媒体会话");
    renderUnavailableState();
    return;
  }

  const incomingTrackKey = trackKey(media);
  const changedTrackBeforeUpdate =
    currentTrackKey !== null && incomingTrackKey !== currentTrackKey;
  const previousTrackPercent = displayedPercent;
  const previousVisualTarget = progressPercent(visualPosition);

  mediaState = media;

  renderMetadata(media);
  setCover(media.isAvailable && media.coverUrl ? media.coverUrl : DEFAULTS.COVER);

  const key = incomingTrackKey;
  const changedTrack = key !== currentTrackKey;
  const status = media.playbackStatus;

  if (!media.isAvailable) {
    currentTrackKey = key;
    enterEfficiencyMode("没有可用的媒体会话");
    renderUnavailableState();
    return;
  }

  if (status === "Stopped" || status === "Closed") {
    currentTrackKey = key;
    enterEfficiencyMode(status === "Closed" ? "媒体会话已关闭" : "播放已停止");
    transitionProgress(0);
    return;
  }

  if (status === "Paused") {
    currentTrackKey = key;
    if (changedTrack || resync) {
      // Establish the paused track's own position before comparing snapshots.
      startupGuard.cancel();
      seekSmoothingActive = false;
      lastReportedPosition = null;
      setAnchor(getReportedPosition(media), performance.now(), true);
    }
    handlePaused(media);
    return;
  }

  if (status !== "Playing") {
    currentTrackKey = key;
    enterEfficiencyMode("等待可识别的播放状态");
    transitionProgress(0);
    return;
  }

  if (changedTrack || resync || mode !== MODE.RUNNING) {
    currentTrackKey = key;
    handlePlaying(
      media,
      changedTrack,
      !resync && changedTrackBeforeUpdate ? previousTrackPercent : null,
      resync
    );
    return;
  }

  if (trackResetTransition && !hasUsableProgressData(media)) {
    trackResetTransition = null;
    transitionProgress(visualPosition);
  } else if (!trackResetTransition && progressPercent(visualPosition) !== previousVisualTarget) {
    transitionProgress(visualPosition);
  }
  handlePlayingUpdate(media);
}

// ---- Animation frame loop ----
function updateProgress() {
  animationFrame = 0;
  const playing = mode === MODE.RUNNING &&
    mediaState?.playbackStatus === "Playing";
  const pausedSeek = mode === MODE.PAUSED && seekSmoothingActive &&
    mediaState?.playbackStatus === "Paused";

  if (
    (!playing && !pausedSeek && !progressCorrection) ||
    awaitingFreshSnapshot ||
    document.hidden
  ) {
    return;
  }

  const now = performance.now();
  if (!playing && !pausedSeek) {
    renderProgress(mode === MODE.PAUSED ? visualPosition : 0);
    startAnimation();
    return;
  }

  // Phase 1: animate the previous track's fill back to the start.
  // Use percentage space here because the new track may have a different duration.
  if (trackResetTransition) {
    const elapsed = Math.max(0, now - trackResetTransition.startedAt);
    const progress = Math.min(1, elapsed / Math.max(1, trackResetTransition.durationMs));
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const resetPercent = trackResetTransition.fromPercent * (1 - eased);

    if (progress >= 1) {
      trackResetTransition = null;
      visualPosition = 0;
      lastFrameAt = now;
      renderProgress(0, true);
    } else {
      lastFrameAt = now;
      renderProgress(0, false, resetPercent);
      startAnimation();
      return;
    }
  }

  // Phase 2: confirmed seeks may move in either direction. Ordinary timeline
  // corrections remain monotonic to avoid reintroducing timestamp jitter.
  visualPosition = clampToDuration(visualPosition);
  const logicalTarget = logicalPosition(now);
  const deltaMs = Math.max(0, now - lastFrameAt);

  if (seekSmoothingActive) {
    visualPosition = clampToDuration(
      smoothPosition(
        visualPosition,
        logicalTarget,
        deltaMs,
        CONFIG.seekSmoothingMs
      )
    );

    if (Math.abs(logicalTarget - visualPosition) <= 0.025) {
      visualPosition = clampToDuration(logicalTarget);
      seekSmoothingActive = false;
    }
  } else {
    const target = Math.max(visualPosition, logicalTarget);
    const gap = target - visualPosition;

    if (gap > 0.001) {
      const smoothing = gap > 0.6
        ? CONFIG.recoverySmoothingMs
        : CONFIG.normalSmoothingMs;

      visualPosition = clampToDuration(
        smoothPosition(
          visualPosition,
          target,
          deltaMs,
          smoothing
        )
      );
    }
  }

  lastFrameAt = now;
  renderProgress(visualPosition);

  if (mode === MODE.RUNNING || seekSmoothingActive) {
    startAnimation();
  }
}

// ---- Browser lifecycle and API adapter subscriptions ----
function resumeVisibleAnimation() {
  if (document.hidden) return;
  const now = performance.now();
  if (trackResetTransition) {
    trackResetTransition.fromPercent = displayedPercent;
    trackResetTransition.startedAt = now;
  }
  if (progressCorrection) {
    progressCorrection.from = displayedPercent;
    progressCorrection.startedAt = now;
  }
  startAnimation();
}

function onVisibilityChange() {
  if (document.hidden) {
    if (mode === MODE.RUNNING) {
      setAnchor(logicalPosition(), performance.now(), false);
    }
    stopAnimation();
  } else {
    resumeVisibleAnimation();
  }
}

function onConnectionChange(connected) {
  disconnected = !connected;
  if (disconnected) publishPlayback(false);
  dom.player.dataset.connectionState = connected ? "connected" : "disconnected";
  if (disconnected) {
    // Keep the displayed frame until a fresh snapshot supplies the next anchor.
    awaitingFreshSnapshot = true;
    stopAnimation();
    clearPauseTimer();
    trackResetTransition = null;
    progressCorrection = null;
    seekSmoothingActive = false;
    startupGuard.cancel();
    setStartupGuardState(false);
  }
}

function onPageHide() {
  stopAnimation();
  clearPauseTimer();
  releaseCoverRequest();
  currentCoverUrl = "";
  dom.cover.removeAttribute("src");
  dom.cover.classList.remove("loaded");
}

function onPageShow() {
  if (mediaState) {
    setCover(
      mediaState.isAvailable && mediaState.coverUrl
        ? mediaState.coverUrl
        : DEFAULTS.COVER
    );
  }

  resumeVisibleAnimation();
  if (mode === MODE.PAUSED && !awaitingFreshSnapshot) {
    schedulePausedSleep();
  }
}

document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);

// Initial state.
setCover(DEFAULTS.COVER);
renderProgress(0, true);
dom.player.dataset.connectionState = "connecting";
dom.player.dataset.renderState = "efficiency";

// Direct file previews stay in the idle state. FluentFlyout serves the adapter
// from its own origin and is responsible for authentication and reconnection.
function subscribe() {
  const api = window.FluentFlyout;
  if (typeof api?.onMediaChanged !== "function") {
    dom.player.dataset.connectionState = "api-missing";
    return;
  }
  api.onMediaChanged(renderMedia);
  api.onConnectionChanged?.(onConnectionChange);
}

if (window.FluentFlyout || location.protocol === "file:") {
  subscribe();
} else {
  const adapter = document.createElement("script");
  adapter.src = "/js/fluentflyout-api.js";
  adapter.onload = subscribe;
  adapter.onerror = () => { dom.player.dataset.connectionState = "api-missing"; };
  document.head.append(adapter);
}
})();
