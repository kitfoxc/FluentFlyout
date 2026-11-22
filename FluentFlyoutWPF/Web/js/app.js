import {
  clampPosition,
  createStartupProgressGuard,
  getReportedPosition,
  getTimelinePosition,
  hasValidTimelineTimestamp,
  smoothPosition
} from "./progress-utils.js";

/*
 * REQUIRED INTERFACE:
 * - Keep /js/fluentflyout-api.js loaded before this module.
 * - Keep FluentFlyout.onMediaChanged and onConnectionChanged subscriptions.
 * - Keep Protocol 1.0 property names; the API adapter owns auth and reconnect.
 *
 * CUSTOMIZABLE:
 * - CONFIG values below tune visual smoothing and pause sleep behavior.
 * - Everything after the interface setup is renderer presentation logic.
 */

const el = {
  dashboard: document.getElementById("dashboard"),
  cover: document.getElementById("cover"),
  coverPlaceholder: document.getElementById("cover-placeholder"),
  trackTitle: document.getElementById("track-title"),
  trackSubtitle: document.getElementById("track-subtitle"),
  playerName: document.getElementById("player-name"),
  playbackIndicator: document.getElementById("playback-indicator"),
  playbackState: document.getElementById("playback-state"),
  connectionDot: document.getElementById("connection-dot"),
  connectionState: document.getElementById("connection-state"),
  progressTrack: document.getElementById("progress-track"),
  progressFill: document.getElementById("progress-fill"),
  progressKnob: document.getElementById("progress-knob"),
  position: document.getElementById("position"),
  duration: document.getElementById("duration"),
  adaptationText: document.getElementById("adaptation-text")
};

const CONFIG = Object.freeze({
  // CUSTOMIZABLE: paused media sleeps after this continuous idle duration.
  pauseSleepMs: 5 * 60 * 1000,

  // CUSTOMIZABLE: time-based smoothing; values are milliseconds.
  normalSmoothingMs: 150,
  recoverySmoothingMs: 500,

  // CUSTOMIZABLE: explicit seek thresholds; small backward noise is ignored.
  backwardSeekThresholdSeconds: 0.8,
  forwardSeekThresholdSeconds: 8,

  // CUSTOMIZABLE: first-seconds startup rollback protection.
  startupGuardMaxMs: 4200,
  startupAdvancingSamples: 2,
  startupMinPositionStepSeconds: 0.05,
  startupCatchUpToleranceSeconds: 0.15,

  // CUSTOMIZABLE: a sub-2% rollback during startup is treated as transient
  // noise unless the guard times out or a clear forward seek is observed.
  startupNoiseFloorPercent: 2,

  // CUSTOMIZABLE: time labels are updated at most five times per second.
  textUpdateIntervalMs: 200
});

const startupGuard = createStartupProgressGuard({
  maxDurationMs: CONFIG.startupGuardMaxMs,
  minAdvancingSamples: CONFIG.startupAdvancingSamples,
  minPositionStepSeconds: CONFIG.startupMinPositionStepSeconds,
  catchUpToleranceSeconds: CONFIG.startupCatchUpToleranceSeconds
});

const MODE = Object.freeze({
  SLEEP: "sleep",
  RUNNING: "running",
  PAUSED: "paused"
});

let mediaState = null;
let mode = MODE.SLEEP;
let sleepReason = "等待媒体";
let animationFrame = 0;
let pauseTimer = 0;
let currentTrackKey = null;
let currentCoverUrl = null;
let pendingCoverImage = null;
let coverGeneration = 0;

let logicalAnchor = 0;
let logicalAnchorAt = performance.now();
let visualPosition = 0;
let lastFrameAt = 0;
let lastTextAt = 0;
let lastReportedPosition = null;
let connected = false;

function setText(node, value) {
  if (!node) return;
  node.textContent =
    value === null || value === undefined || value === ""
      ? "—"
      : String(value);
}

function formatTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—:—";

  const total = Math.floor(number);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getDuration() {
  const duration = Number(mediaState?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function clamp(value) {
  return clampPosition(value, getDuration());
}

function getTrackKey(media) {
  return [
    media?.sessionId || "",
    media?.title || "",
    media?.artist || "",
    media?.album || ""
  ].join("\u001f");
}

function logicalPosition(now = performance.now()) {
  const isAdvancing =
    mode === MODE.RUNNING && mediaState?.playbackStatus === "Playing";
  const elapsed = isAdvancing ? Math.max(0, now - logicalAnchorAt) / 1000 : 0;
  return clamp(logicalAnchor + elapsed);
}

function setAnchor(position, now = performance.now(), syncVisual = false) {
  logicalAnchor = clamp(position);
  logicalAnchorAt = now;
  if (syncVisual) visualPosition = logicalAnchor;
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function startAnimation() {
  if (animationFrame || mode !== MODE.RUNNING || document.hidden) return;
  lastFrameAt = performance.now();
  animationFrame = requestAnimationFrame(updateProgress);
}

function clearPauseTimer() {
  if (pauseTimer) window.clearTimeout(pauseTimer);
  pauseTimer = 0;
}

function releaseCover() {
  coverGeneration += 1;

  if (pendingCoverImage) {
    pendingCoverImage.onload = null;
    pendingCoverImage.onerror = null;
    pendingCoverImage.src = "";
    pendingCoverImage = null;
  }

  if (el.cover) {
    el.cover.removeAttribute("src");
    el.cover.hidden = true;
  }
  if (el.coverPlaceholder) el.coverPlaceholder.hidden = false;
  currentCoverUrl = null;
}

function setCover(url) {
  const nextUrl = typeof url === "string" && url.trim() ? url : null;
  if (nextUrl === currentCoverUrl) return;

  releaseCover();
  currentCoverUrl = nextUrl;
  if (!nextUrl) return;

  const generation = coverGeneration;
  const image = new Image();
  pendingCoverImage = image;

  image.onload = () => {
    if (generation !== coverGeneration || currentCoverUrl !== nextUrl) return;
    pendingCoverImage = null;
    el.cover.src = nextUrl;
    el.cover.hidden = false;
    el.coverPlaceholder.hidden = true;
  };

  image.onerror = () => {
    if (generation !== coverGeneration || currentCoverUrl !== nextUrl) return;
    pendingCoverImage = null;
    currentCoverUrl = null;
    el.cover.removeAttribute("src");
    el.cover.hidden = true;
    el.coverPlaceholder.hidden = false;
  };

  image.src = nextUrl;
}

function getProgressSource(media) {
  const now = Date.now();

  if (hasValidTimelineTimestamp(media, now)) {
    return "SMTC 时间线";
  }

  const updatedAt = Date.parse(media?.updatedAt || "");
  if (
    Number.isFinite(updatedAt) &&
    updatedAt >= Date.UTC(2000, 0, 1) &&
    updatedAt - now <= 1000
  ) {
    return "UpdatedAt 初始回退";
  }

  return "Position 直读";
}

function renderMetadata(media) {
  const title = media.title || "未知曲目";
  const artist = media.artist || "";
  const album = media.album || "";
  const subtitle = [artist, album].filter(Boolean).join(" — ");

  setText(el.trackTitle, title);
  setText(el.trackSubtitle, subtitle || media.playerName || "媒体信息不完整");
  setText(el.playerName, media.playerName || "未知音源");

  const status = media.playbackStatus || "Unknown";
  setText(
    el.playbackState,
    status === "Playing" ? "正在播放" :
      status === "Paused" ? "已暂停" :
      status === "Closed" ? "已关闭" :
      status === "Stopped" ? "已停止" : status
  );

  el.playbackIndicator.classList.toggle("is-paused", status === "Paused");
  el.playbackIndicator.classList.toggle("is-playing", status === "Playing");
  el.playbackIndicator.setAttribute(
    "aria-label",
    status === "Playing" ? "正在播放" : status === "Paused" ? "已暂停" : status
  );

  const source = getProgressSource(media);
  setText(el.adaptationText, source);
}

function renderProgress(position, forceText = false) {
  const duration = getDuration();
  const current = clamp(position);
  const percentage = duration > 0
    ? Math.max(0, Math.min(100, current / duration * 100))
    : null;

  // Set the actual fill width so its 999px capsule radius remains full-size
  // even when the played segment is very short.
  el.progressFill.style.width = `${percentage ?? 0}%`;
  el.progressKnob.hidden = percentage === null;
  if (percentage !== null) {
    el.progressKnob.style.left = `${percentage}%`;
  }

  el.progressTrack.setAttribute(
    "aria-valuenow",
    percentage === null ? "0" : percentage.toFixed(1)
  );
  el.progressTrack.setAttribute(
    "aria-valuetext",
    percentage === null
      ? "时长或进度数据不完整"
      : `${percentage.toFixed(1)}%`
  );

  const now = performance.now();
  if (forceText || now - lastTextAt >= CONFIG.textUpdateIntervalMs) {
    setText(el.position, formatTime(current));
    setText(el.duration, duration > 0 ? formatTime(duration) : "时长未知");
    lastTextAt = now;
  }
}

function wake() {
  el.dashboard.classList.remove("is-sleeping");
  sleepReason = "";
}

function enterSleep(reason, clearArtwork = false) {
  startupGuard.cancel();
  mode = MODE.SLEEP;
  sleepReason = reason;
  stopAnimation();
  clearPauseTimer();
  el.dashboard.classList.add("is-sleeping");
  if (clearArtwork) releaseCover();
}

function schedulePausedSleep() {
  clearPauseTimer();
  pauseTimer = window.setTimeout(() => {
    pauseTimer = 0;
    if (mediaState?.playbackStatus === "Paused") {
      enterSleep("暂停超过 5 分钟", true);
    }
  }, CONFIG.pauseSleepMs);
}

function getInitialPosition(media) {
  // UpdatedAt is permitted only as the initial fallback anchor.
  return getTimelinePosition(media, Date.now(), {
    allowUpdatedAtFallback: true,
    fallback: 0
  });
}

function getIncomingPosition(media, now, current) {
  // Once playback is underway, do not repeatedly re-anchor from UpdatedAt.
  if (hasValidTimelineTimestamp(media, Date.now())) {
    return getTimelinePosition(media, Date.now(), {
      allowUpdatedAtFallback: false,
      fallback: current
    });
  }

  // Without a valid SMTC timestamp, Position discontinuities are the only
  // correction signal; ordinary progression continues on performance.now().
  return getReportedPosition(media, current);
}

function beginStartupGuard(media, now = performance.now()) {
  if (hasValidTimelineTimestamp(media, Date.now())) {
    startupGuard.start(getReportedPosition(media), now);
  } else {
    startupGuard.cancel();
  }
}

function percentOf(position) {
  const duration = getDuration();
  return duration > 0 ? Math.max(0, Math.min(100, position / duration * 100)) : null;
}

function handlePaused(media) {
  stopAnimation();
  clearPauseTimer();

  const now = performance.now();
  const reported = getReportedPosition(media, logicalPosition(now));
  const current = logicalPosition(now);
  const hasExplicitBackwardSeek =
    lastReportedPosition !== null &&
    reported < lastReportedPosition - CONFIG.backwardSeekThresholdSeconds;

  const pausedPosition = hasExplicitBackwardSeek
    ? getInitialPosition(media)
    : Math.max(current, visualPosition, getIncomingPosition(media, now, current));

  startupGuard.cancel();
  setAnchor(pausedPosition, now, true);
  visualPosition = pausedPosition;
  lastReportedPosition = reported;
  mode = MODE.PAUSED;
  wake();
  renderProgress(visualPosition, true);
  schedulePausedSleep();
}

function handlePlaying(media, changedTrack) {
  clearPauseTimer();

  const now = performance.now();
  const wasPausedSleep = mode === MODE.SLEEP &&
    sleepReason === "暂停超过 5 分钟" &&
    !changedTrack;

  const shouldReset = changedTrack ||
    (mode === MODE.SLEEP && !wasPausedSleep);

  wake();

  if (shouldReset) {
    const initial = getInitialPosition(media);
    setAnchor(initial, now, true);
    beginStartupGuard(media, now);
  } else {
    const current = logicalPosition(now);
    const incoming = getIncomingPosition(media, now, current);
    startupGuard.cancel();
    setAnchor(Math.max(incoming, visualPosition, current), now, false);
  }

  lastReportedPosition = getReportedPosition(media);
  mode = MODE.RUNNING;
  renderProgress(visualPosition, true);
  startAnimation();
}

function handlePlayingUpdate(media) {
  const now = performance.now();
  const current = logicalPosition(now);
  const reported = getReportedPosition(media, current);
  const incoming = getIncomingPosition(media, now, current);

  const timelineValid = hasValidTimelineTimestamp(media, Date.now());
  const backwardSeek = lastReportedPosition !== null &&
    reported < lastReportedPosition - CONFIG.backwardSeekThresholdSeconds;
  const forwardSeek = incoming - current > CONFIG.forwardSeekThresholdSeconds;

  let handledByStartupGuard = false;

  if (startupGuard.isActive && !timelineValid) {
    startupGuard.cancel();
  }

  if (startupGuard.isActive && timelineValid) {
    handledByStartupGuard = true;

    const incomingPercent = percentOf(incoming);
    const visualPercent = percentOf(visualPosition);
    const tinyStartupRollback =
      incomingPercent !== null &&
      visualPercent !== null &&
      incomingPercent < CONFIG.startupNoiseFloorPercent &&
      visualPercent >= CONFIG.startupNoiseFloorPercent;

    const guard = startupGuard.observe({
      reportedPosition: reported,
      incomingPosition: incoming,
      visualPosition,
      now,
      explicitSeek: forwardSeek || (backwardSeek && !tinyStartupRollback)
    });

    if (guard.released) {
      if (guard.reason === "seek") {
        setAnchor(incoming, now, true);
        renderProgress(visualPosition, true);
      } else {
        // Resume from the furthest-forward trusted position; never animate
        // a false rollback after the first few unstable SMTC samples.
        setAnchor(Math.max(incoming, visualPosition), now, false);
      }
    } else {
      // Keep the logical source anchor current, while visual time is held
      // against backward startup jitter.
      setAnchor(incoming, now, false);
    }
  }

  if (!handledByStartupGuard) {
    if (timelineValid) {
      if (backwardSeek || forwardSeek) {
        // A clear seek is an intentional discontinuity and snaps immediately.
        setAnchor(incoming, now, true);
        renderProgress(visualPosition, true);
      } else {
        // Timestamp-only backward corrections and small sample noise are
        // ignored; the logical playhead remains monotonic.
        setAnchor(Math.max(current, incoming), now, false);
      }
    } else {
      const difference = reported - current;

      if (backwardSeek || difference > CONFIG.forwardSeekThresholdSeconds) {
        setAnchor(reported, now, true);
        renderProgress(visualPosition, true);
      } else if (difference > 0.6) {
        setAnchor(reported, now, false);
      } else {
        setAnchor(current, now, false);
      }
    }
  }

  lastReportedPosition = reported;
  startAnimation();
}

function updateProgress() {
  animationFrame = 0;

  if (
    mode !== MODE.RUNNING ||
    document.hidden ||
    !mediaState ||
    mediaState.playbackStatus !== "Playing"
  ) {
    return;
  }

  const now = performance.now();
  const current = clamp(visualPosition);
  const logical = logicalPosition(now);
  const target = Math.max(current, logical);
  const gap = target - current;

  if (gap > 0.001) {
    const smoothing = gap > 0.6
      ? CONFIG.recoverySmoothingMs
      : CONFIG.normalSmoothingMs;

    visualPosition = clamp(
      smoothPosition(current, target, Math.max(0, now - lastFrameAt), smoothing)
    );
  }

  lastFrameAt = now;
  renderProgress(visualPosition);
  startAnimation();
}

function render(media) {
  if (!media) return;

  mediaState = media;
  renderMetadata(media);
  setCover(media.coverUrl || null);

  const key = getTrackKey(media);
  const changedTrack = key !== currentTrackKey;
  const status = media.playbackStatus;

  if (!media.isAvailable) {
    currentTrackKey = key;
    enterSleep("没有可用的媒体会话", true);
    return;
  }

  if (status === "Stopped" || status === "Closed") {
    currentTrackKey = key;
    enterSleep(status === "Closed" ? "媒体会话已关闭" : "播放已停止", true);
    return;
  }

  if (status === "Paused") {
    currentTrackKey = key;
    handlePaused(media);
    return;
  }

  if (status === "Playing") {
    currentTrackKey = key;
    if (changedTrack || mode !== MODE.RUNNING) {
      handlePlaying(media, changedTrack);
    } else {
      handlePlayingUpdate(media);
    }
    return;
  }

  currentTrackKey = key;
  enterSleep("等待可识别的播放状态", false);
}

function onConnectionChange(value) {
  connected = Boolean(value);
  el.connectionDot.classList.toggle("is-online", connected);
  el.connectionDot.classList.toggle("is-offline", !connected);
  el.connectionDot.title = connected ? "WebSocket 已连接" : "WebSocket 连接断开";
  setText(el.connectionState, connected ? "已连接" : "连接断开");
}

function onVisibilityChange() {
  if (document.hidden) {
    if (mode === MODE.RUNNING) {
      setAnchor(logicalPosition(), performance.now(), false);
    }
    stopAnimation();
    return;
  }

  if (mode === MODE.RUNNING) startAnimation();
}

function onPageHide() {
  stopAnimation();
  clearPauseTimer();
  releaseCover();
}

function onPageShow() {
  if (mediaState?.coverUrl && mode !== MODE.SLEEP) {
    setCover(mediaState.coverUrl);
  }
  if (mode === MODE.RUNNING && mediaState?.playbackStatus === "Playing") {
    startAnimation();
  } else if (mode === MODE.PAUSED) {
    schedulePausedSleep();
  }
}

document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);

// REQUIRED INTERFACE: these subscriptions are provided by the bundled adapter.
// Do not replace them with a second WebSocket connection or custom token logic.
if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(render);
  window.FluentFlyout.onConnectionChanged?.(onConnectionChange);
} else {
  console.error(
    "FluentFlyout API missing. Keep /js/fluentflyout-api.js before js/app.js."
  );
  setText(el.adaptationText, "通信接口未加载");
}
