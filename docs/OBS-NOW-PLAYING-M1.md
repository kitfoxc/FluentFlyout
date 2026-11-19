# OBS Now Playing — implementation notes

## M1 — normalized media state

- `NowPlayingInfo`: immutable DTO shared by the desktop UI and external clients.
- `MediaStateStore`: thread-safe latest snapshot, monotonically increasing
  sequence number, and change notification.
- `MediaSessionSelector`: isolated pinned → focused → first-allowed selector.
- Existing `MainWindow` SMTC callbacks publish media-property, playback,
  timeline and session-closed state without moving the existing Flyout,
  Taskbar Widget, seek bar or Next Up behavior.

## M2 — local HTTP and WebSocket transport

- `ObsWebServer`: Kestrel server bound only to `127.0.0.1`.
- `WebSocketHub`: manages Browser Source clients and serializes socket sends.
- Per-process random token protects state, WebSocket and cover-art endpoints.
- Browser requests carrying an Origin header are restricted to localhost on
  the configured port.
- `CoverArtStore`: bounded in-memory PNG cache populated from the existing
  SMTC thumbnail and BitmapHelper pipeline.
- `Web/`: transparent Fluent-inspired Browser Source page, CSS and JS client.
- The page receives an immediate state snapshot, processes sequence numbers,
  extrapolates playback progress locally and reconnects with exponential backoff.
- Web assets are copied to the application output directory.
- Server startup and shutdown are tied to the MainWindow lifetime.

## M3 — user-configurable integration

- Added persisted `ObsNowPlayingEnabled` and `ObsNowPlayingPort` settings.
- Added OBS Now Playing controls to System Settings.
- Disabling the integration stops the HTTP/WebSocket listener without
  stopping SMTC or affecting the native FluentFlyout media UI.
- Changing the port stops and restarts the local service on the new port.
- Port values are restricted to 1024–65535; the default remains 17832.
- The listener remains loopback-only (`127.0.0.1`), not LAN-accessible.
- Settings continue to use the existing XML persistence mechanism.

### Browser Source URL

`http://127.0.0.1:<configured-port>/`

### HTTP endpoints

- `GET /api/health`
- `GET /api/config` (same-origin configuration/token bootstrap)
- `GET /api/now-playing?token=...`
- `GET /api/covers/{coverId}?token=...`

### WebSocket

`ws://127.0.0.1:<configured-port>/ws?token=...`

Protocol version: `1.0`. The server sends `state.snapshot` on connect and
`media.changed` for subsequent SMTC updates. Playback commands are not exposed.

## M3.1 — independent OBS media source selection

- Added a System Settings picker listing currently available, allowed SMTC players.
- `Automatic (follow FluentFlyout)` keeps OBS aligned with the app's existing
  active-session selection.
- Selecting a player pins that SMTC session for OBS only; the desktop Flyout,
  Taskbar Widget and existing global pinned-player preference remain unchanged.
- The OBS-specific session ID is persisted separately as
  `ObsPinnedSessionId`.
- OBS state is refreshed when any media session changes, including the
  independently selected player. Closing the selected session clears the
  OBS-specific pin and returns to automatic selection.
- Existing app filtering rules are applied to the OBS source list and selector.

## Local verification checklist

1. Build `FluentFlyoutWPF.csproj` with .NET 10 on Windows.
2. Confirm the service starts when OBS Now Playing is enabled.
3. Disable the setting and confirm the listener stops.
4. Re-enable it and confirm the default URL works again.
5. Change the port, then confirm the old port closes and the new port serves
   `/api/health`.
6. Verify the OBS Browser Source reconnects after a port change using the new URL.

## Follow-up

- Add media source selection modes (Auto, pinned session, priority list).
- Add status diagnostics and a copy-URL action.
- Test multiple simultaneous Browser Sources and long-running reconnections.
- Validate packaged runtime requirements for ASP.NET Core.


## WebSocket page and user HTML templates

The integration is now presented as a first-class **WebSocket** page beside the
other feature pages in Settings; its controls are no longer embedded in System.

- User templates live in `%APPDATA%\\FluentFlyout\\web-theme`.
- On first run, the packaged default HTML page is copied to
  `default.html` in that folder.
- The WebSocket page scans top-level `.html` files and offers a refresh action.
- Selecting a template updates the persisted `WebSocketThemeFileName` setting.
- The server serves the selected HTML file at the same Browser Source root URL.
- Connected Browser Sources receive `theme.changed` and reload the page.
- Custom templates include `/js/fluentflyout-api.js` and use
  `FluentFlyout.onMediaChanged(callback)` to receive media snapshots.
- Initial implementation supports self-contained HTML files with inline CSS/JS.
  Supporting companion assets in nested theme folders is intentionally deferred.
- HTML templates execute JavaScript in OBS Browser Source and must be treated
  as trusted local code.

### Custom HTML example

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My WebSocket theme</title></head>
<body>
  <img id="cover" alt="">
  <h1 id="title">Nothing playing</h1>
  <p id="artist"></p>
  <script src="/js/fluentflyout-api.js"></script>
  <script>
    FluentFlyout.onMediaChanged(media => {
      document.querySelector("#title").textContent = media.title || "";
      document.querySelector("#artist").textContent = media.artist || "";
      document.querySelector("#cover").src = media.coverUrl || "";
    });
  </script>
</body>
</html>
```
