const elements = {
  widget: document.querySelector("#widget"),
  cover: document.querySelector("#cover"),
  coverPlaceholder: document.querySelector("#cover-placeholder"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  album: document.querySelector("#album"),
  player: document.querySelector("#player"),
  status: document.querySelector("#status-label"),
  playingDot: document.querySelector("#playing-dot"),
  progressArea: document.querySelector("#progress-area"),
  progressFill: document.querySelector("#progress-fill"),
  position: document.querySelector("#position"),
  duration: document.querySelector("#duration"),
  connection: document.querySelector("#connection")
};

let socket;
let reconnectDelay = 1000;
let authToken = "";
let state = null;
let lastSequence = -1;
let receivedAt = performance.now();
let animationFrame = 0;

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

function setConnected(connected) {
  elements.connection.classList.toggle("is-disconnected", !connected);
}

function setCover(url) {
  if (!url) {
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
    return;
  }

  const image = new Image();
  image.onload = () => {
    elements.cover.src = url;
    elements.cover.hidden = false;
    elements.coverPlaceholder.hidden = true;
  };
  image.onerror = () => {
    elements.cover.hidden = true;
    elements.coverPlaceholder.hidden = false;
  };
  image.src = url;
}

function render(nextState) {
  state = nextState;
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
  elements.progressArea.classList.toggle(
    "is-unavailable",
    !(Number(state.duration) > 0)
  );

  setCover(state.coverUrl ? `${state.coverUrl}?token=${encodeURIComponent(authToken)}` : null);
  updateProgress();
}

function updateProgress() {
  if (!state) return;

  const duration = Math.max(0, Number(state.duration) || 0);
  let position = Math.max(0, Number(state.position) || 0);

  if (state.playbackStatus === "Playing") {
    position += (performance.now() - receivedAt) / 1000;
  }

  if (duration > 0) position = Math.min(position, duration);

  elements.progressFill.style.width =
    duration > 0 ? `${(position / duration) * 100}%` : "0%";
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(duration);

  animationFrame = requestAnimationFrame(updateProgress);
}

function handleMessage(message) {
  if (!message || message.protocol !== "1.0" || !message.data) return;
  if (Number(message.sequence) <= lastSequence) return;

  lastSequence = Number(message.sequence);
  render(message.data);
}

async function connect() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to obtain local service configuration");
    const config = await response.json();
    authToken = config.token;

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(
      `${scheme}//${location.host}${config.websocketPath}?token=${encodeURIComponent(authToken)}`
    );

    socket.onopen = () => {
      reconnectDelay = 1000;
      setConnected(true);
    };

    socket.onmessage = event => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn("Invalid media message", error);
      }
    };

    socket.onerror = () => socket.close();

    socket.onclose = () => {
      setConnected(false);
      window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };
  } catch (error) {
    console.warn("OBS media service unavailable", error);
    setConnected(false);
    window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }
}

connect();
