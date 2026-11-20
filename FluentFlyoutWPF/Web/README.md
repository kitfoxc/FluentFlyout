# OBS WebSocket Now Playing

FluentFlyout can expose its currently selected SMTC media session to a local OBS Browser Source.

## Connect OBS

Add a Browser Source with:

`http://127.0.0.1:17832/`

The port can be changed in FluentFlyout's WebSocket settings. The service listens on loopback only and uses a per-process random token for state, WebSocket, and cover-art requests.

## Themes

Themes are folders under:

`%AppData%\\FluentFlyout\\web-theme`

Each immediate child folder is one theme. Put an `index.html` file and its assets in that folder. FluentFlyout does not recursively scan for themes. The built-in `default` folder is created automatically.

Custom themes can include `/js/fluentflyout-api.js` and subscribe to media changes:

```js
window.FluentFlyout.onMediaChanged(media => {
  console.log(media.title, media.position, media.duration);
});
```

## WebSocket protocol 1.0

The server sends a complete `state.snapshot` when a client connects and `media.changed` messages after SMTC updates. Each message includes a monotonically increasing sequence number. The media position is the raw SMTC timeline position; `timelineLastUpdatedTime` indicates when that position was sampled.

The built-in theme extrapolates between samples using `performance.now()`, waits for forward progress before starting its playhead, freezes after prolonged source stagnation, and applies small corrections without snapping on every update.

The endpoint is read-only. Playback commands are not exposed.
