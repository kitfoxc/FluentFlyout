// FluentFlyout WebSocket browser API (protocol 1.0)
(() => {
  const listeners = new Set();
  let socket = null;
  let currentState = null;
  let currentSequence = -1;
  let connected = false;
  let reconnectDelay = 1000;

  function emit(state) {
    currentState = state;
    for (const listener of [...listeners]) {
      try { listener(state); }
      catch (error) { console.error("FluentFlyout theme callback failed", error); }
    }
  }

  async function connect() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load WebSocket configuration");
      const config = await response.json();
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${scheme}//${location.host}${config.websocketPath}?token=${encodeURIComponent(config.token)}`
      );

      socket.onopen = () => {
        connected = true;
        reconnectDelay = 1000;
      };

      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message?.protocol !== "1.0") return;
          if (message.type === "theme.changed") {
            location.reload();
            return;
          }
          if (!message.data || !["state.snapshot", "media.changed"].includes(message.type)) return;

          const sequence = Number(message.sequence ?? message.data.sequence ?? -1);
          // Ignore delayed or duplicated frames. The server coalesces pending
          // media updates, but this also protects themes across reconnect races.
          if (Number.isFinite(sequence) && sequence >= 0 && sequence <= currentSequence)
            return;
          if (Number.isFinite(sequence) && sequence >= 0)
            currentSequence = sequence;

          const media = { ...message.data };
          if (media.coverUrl) {
            const cover = new URL(media.coverUrl, location.origin);
            cover.searchParams.set("token", config.token);
            media.coverUrl = cover.href;
          }
          emit(media);
        } catch (error) {
          console.warn("Invalid FluentFlyout WebSocket message", error);
        }
      };

      socket.onerror = () => socket.close();
      socket.onclose = () => {
        connected = false;
        window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      };
    } catch (error) {
      connected = false;
      console.warn("FluentFlyout WebSocket unavailable", error);
      window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    }
  }

  window.FluentFlyout = Object.freeze({
    protocolVersion: "1.0",
    getState: () => currentState,
    isConnected: () => connected,
    onMediaChanged(callback) {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      listeners.add(callback);
      if (currentState) callback(currentState);
      return () => listeners.delete(callback);
    }
  });

  connect();
})();
