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

let state = null;
let animationFrame = 0;
let currentCoverUrl = null;
let currentTrackKey = null;

// The browser owns a continuous playhead between WebSocket snapshots. Incoming
// SMTC positions are synchronization hints, not a reason to restart the clock.
let positionAnchor = 0;
let positionAnchorAt = performance.now();
let correctionAmount = 0;
let correctionStartedAt = 0;
const correctionDuration = 900;
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

function getInterpolatedPosition(now = performance.now()) {
  if (!state) return 0;

  const elapsed = state.playbackStatus === "Playing"
    ? Math.max(0, now - positionAnchorAt) / 1000
    : 0;

  let position = positionAnchor + elapsed;

  if (correctionAmount !== 0) {
    const progress = Math.min(1, Math.max(0, (now - correctionStartedAt) / correctionDuration));
    const easedProgress = progress * progress * (3 - 2 * progress);
    position += correctionAmount * easedProgress;

    if (progress >= 1) {
      positionAnchor += correctionAmount;
      positionAnchorAt = now;
      correctionAmount = 0;
    }
  }

  const duration = Math.max(0, Number(state.duration) || 0);
  return duration > 0
    ? Math.min(duration, Math.max(0, position))
    : Math.max(0, position);
}

function synchronizePosition(media) {
  const now = performance.now();
  const incomingPosition = Math.max(0, Number(media.position) || 0);
  const nextTrackKey = getTrackKey(media);
  const trackChanged = state === null || nextTrackKey !== currentTrackKey;

  if (trackChanged) {
    positionAnchor = incomingPosition;
    positionAnchorAt = now;
    correctionAmount = 0;
    correctionStartedAt = now;
    currentTrackKey = nextTrackKey;
    return;
  }

  const currentPosition = getInterpolatedPosition(now);
  const difference = incomingPosition - currentPosition;

  // A large discontinuity is likely an explicit seek or track timeline reset.
  // Apply it immediately; ordinary sub-second SMTC jitter is slewed smoothly.
  if (Math.abs(difference) >= seekSnapThreshold) {
    positionAnchor = incomingPosition;
    positionAnchorAt = now;
    correctionAmount = 0;
    correctionStartedAt = now;
    return;
  }

  positionAnchor = currentPosition;
  positionAnchorAt = now;
  correctionAmount = Math.max(-maxSoftCorrection, Math.min(maxSoftCorrection, difference));
  correctionStartedAt = now;
  currentTrackKey = nextTrackKey;
}

function setCover(url) {
  if (url === currentCoverUrl) return;
  currentCoverUrl = url;

  if (!url) {
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
    elements.cover.removeAttribute("src");
    return;
  }

  const image = new Image();
  image.onload = () => {
    if (currentCoverUrl !== url) return;
    elements.cover.src = url;
    elements.cover.hidden = false;
    elements.coverPlaceholder.hidden = true;
  };
  image.onerror = () => {
    if (currentCoverUrl !== url) return;
    currentCoverUrl = null;
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
  };
  image.src = url;
}

function render(media) {
  const available = Boolean(media?.isAvailable);
  if (!available) {
    state = null;
    currentTrackKey = null;
    correctionAmount = 0;
    elements.widget.classList.add("is-hidden");
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    return;
  }

  synchronizePosition(media);
  state = media;

  elements.widget.classList.remove("is-hidden");
  elements.title.textContent = state.title || "Unknown track";
  elements.artist.textContent = state.artist || "";
  elements.album.textContent = state.album || "";
  elements.player.textContent = state.playerName || "";
  elements.status.textContent = state.playbackStatus === "Playing"
    ? "NOW PLAYING"
    : state.playbackStatus === "Paused" ? "PAUSED" : "STOPPED";

  elements.widget.classList.toggle("is-paused", state.playbackStatus !== "Playing");
  elements.progressArea.classList.toggle("is-unavailable", !(Number(state.duration) > 0));
  setCover(state.coverUrl || null);

  if (animationFrame) cancelAnimationFrame(animationFrame);
  updateProgress();
}

function updateProgress() {
  if (!state) return;

  const duration = Math.max(0, Number(state.duration) || 0);
  const position = getInterpolatedPosition();

  elements.progressFill.style.width = duration > 0
    ? `${(position / duration) * 100}%`
    : "0%";
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(duration);
  animationFrame = requestAnimationFrame(updateProgress);
}

if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(render);
} else {
  console.error("FluentFlyout browser API was not loaded. Include /js/fluentflyout-api.js before app.js.");
}
