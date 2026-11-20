import {
  clampPosition,
  filterStartupJitter,
  getProjectionBudget,
  getReportedPosition,
  projectBoundedPosition,
  reconcilePosition
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

const PAUSED_SLEEP_MS = 5 * 60 * 1000;
let media = null;
let trackKey = null;
let anchor = null;
let animationFrame = 0;
let pauseTimer = 0;
let sleeping = true;
let sleepReason = "no-media";
let currentCoverUrl = null;
let pendingCover = null;

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function cancelAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function clearPauseTimer() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = 0;
}

function releaseCover() {
  if (pendingCover) {
    pendingCover.onload = null;
    pendingCover.onerror = null;
    pendingCover.src = "";
    pendingCover = null;
  }
  elements.cover.removeAttribute("src");
  elements.cover.hidden = true;
  elements.coverPlaceholder.hidden = false;
  currentCoverUrl = null;
}

function setCover(url) {
  if (url === currentCoverUrl) return;
  releaseCover();
  if (!url) return;
  currentCoverUrl = url;
  const image = new Image();
  pendingCover = image;
  image.onload = () => {
    if (pendingCover !== image || currentCoverUrl !== url) return;
    pendingCover = null;
    image.onload = image.onerror = null;
    elements.cover.src = url;
    elements.cover.hidden = false;
    elements.coverPlaceholder.hidden = true;
  };
  image.onerror = () => {
    if (pendingCover !== image || currentCoverUrl !== url) return;
    pendingCover = null;
    image.onload = image.onerror = null;
    releaseCover();
  };
  image.src = url;
}

function sleep(reason, clearState = false) {
  sleeping = true;
  sleepReason = reason;
  cancelAnimation();
  clearPauseTimer();
  releaseCover();
  elements.widget.classList.add("is-hidden", "is-sleeping");
  if (clearState) {
    media = null;
    trackKey = null;
    anchor = null;
  }
}

function wake() {
  sleeping = false;
  sleepReason = "";
  elements.widget.classList.remove("is-hidden", "is-sleeping");
}

function schedulePauseSleep() {
  if (pauseTimer || sleeping) return;
  pauseTimer = setTimeout(() => {
    pauseTimer = 0;
    if (media?.playbackStatus === "Paused") sleep("paused");
  }, PAUSED_SLEEP_MS);
}

function renderPosition(position) {
  const duration = Math.max(0, Number(media?.duration) || 0);
  const current = clampPosition(position, duration);
  elements.progressFill.style.width = duration > 0
    ? `${current / duration * 100}%`
    : "0%";
  elements.position.textContent = formatTime(current);
  elements.duration.textContent = formatTime(duration);
}

function renderMetadata(state) {
  elements.title.textContent = state.title || "Unknown track";
  elements.artist.textContent = state.artist || "";
  elements.album.textContent = state.album || "";
  elements.player.textContent = state.playerName || "";
  elements.status.textContent = state.playbackStatus === "Playing"
    ? "NOW PLAYING" : state.playbackStatus === "Paused" ? "PAUSED" : "STOPPED";
  elements.widget.classList.toggle("is-paused", state.playbackStatus !== "Playing");
  elements.progressArea.classList.toggle("is-unavailable", !(Number(state.duration) > 0));
  if (elements.connection)
    elements.connection.textContent = window.FluentFlyout?.isConnected?.() ? "CONNECTED" : "OFFLINE";
}

function renderFrame() {
  animationFrame = 0;
  if (sleeping || document.hidden || media?.playbackStatus !== "Playing" || !anchor)
    return;
  const now = performance.now();
  renderPosition(projectBoundedPosition(anchor, now));
  // Stop all animation work when the latest trusted sample expires.
  if (now - anchor.at < anchor.budgetMs)
    animationFrame = requestAnimationFrame(renderFrame);
}

function startAnimation() {
  cancelAnimation();
  if (!sleeping && !document.hidden && media?.playbackStatus === "Playing" &&
      anchor?.budgetMs > 0)
    animationFrame = requestAnimationFrame(renderFrame);
}

function render(next) {
  if (!next?.isAvailable || next.playbackStatus === "Stopped" ||
      next.playbackStatus === "Closed") {
    sleep("no-media", true);
    return;
  }

  const now = performance.now();
  const key = `${next.sessionId || ""}\u001f${next.title || ""}`;
  const changed = key !== trackKey;
  const resumed = media?.playbackStatus !== "Playing";
  const duration = Math.max(0, Number(next.duration) || 0);
  const reported = clampPosition(getReportedPosition(next), duration);
  const previous = anchor ? projectBoundedPosition(anchor, now) : reported;
  const projectionMs = getProjectionBudget(next);

  media = next;
  trackKey = key;

  if (next.playbackStatus === "Paused") {
    // Once the page slept on a long pause, do not reload cover art until resume.
    if (sleeping && sleepReason === "paused") return;
    wake();
    clearPauseTimer();
    anchor = { position: reported, at: now, budgetMs: 0, duration };
    renderMetadata(next);
    setCover(next.coverUrl || null);
    renderPosition(reported);
    cancelAnimation();
    schedulePauseSleep();
    return;
  }

  clearPauseTimer();
  wake();
  renderMetadata(next);
  setCover(next.coverUrl || null);

  const candidate = changed || resumed
    ? reported
    : filterStartupJitter(previous, reported, duration);
  const position = changed || resumed
    ? candidate
    : reconcilePosition(previous, candidate, duration);

  // The browser only projects the backend-provided budget. It does not
  // reinterpret SMTC timestamps, detect buffering, or apply a second PLL.
  anchor = { position, at: now, budgetMs: projectionMs, duration };
  renderPosition(position);
  startAnimation();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimation();
  } else if (!sleeping && anchor) {
    renderPosition(projectBoundedPosition(anchor, performance.now()));
    startAnimation();
  }
});

window.addEventListener("pagehide", () => {
  cancelAnimation();
  clearPauseTimer();
  releaseCover();
});

window.addEventListener("pageshow", () => {
  if (media && !sleeping) {
    setCover(media.coverUrl || null);
    renderPosition(projectBoundedPosition(anchor, performance.now()));
    startAnimation();
    if (media.playbackStatus === "Paused") schedulePauseSleep();
  }
});

if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(render);
} else {
  console.error("FluentFlyout browser API was not loaded. Include /js/fluentflyout-api.js before app.js.");
}
