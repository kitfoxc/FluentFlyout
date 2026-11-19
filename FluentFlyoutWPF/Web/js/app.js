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
let receivedAt = performance.now();
let animationFrame = 0;
let currentCoverUrl = null;

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
  state = media;
  receivedAt = performance.now();

  const available = Boolean(state?.isAvailable);
  elements.widget.classList.toggle("is-hidden", !available);
  if (!available) {
    cancelAnimationFrame(animationFrame);
    state = null;
    return;
  }

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
  let position = Math.max(0, Number(state.position) || 0);
  if (state.playbackStatus === "Playing")
    position += (performance.now() - receivedAt) / 1000;
  if (duration > 0) position = Math.min(position, duration);

  elements.progressFill.style.width = duration > 0 ? `${(position / duration) * 100}%` : "0%";
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(duration);
  animationFrame = requestAnimationFrame(updateProgress);
}

if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onMediaChanged(render);
} else {
  console.error("FluentFlyout browser API was not loaded. Include /js/fluentflyout-api.js before app.js.");
}
