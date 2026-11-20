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
- The WebSocket page recursively scans `.html` files in the theme directory and its subfolders, with a refresh action.
- Selecting a template updates the persisted `WebSocketThemeFileName` setting.
- The server serves the selected HTML file at the same Browser Source root URL.
- Connected Browser Sources receive `theme.changed` and reload the page.
- Custom templates include `/js/fluentflyout-api.js` and use
  `FluentFlyout.onMediaChanged(callback)` to receive media snapshots.
- Themes can be grouped into subfolders, each containing multiple HTML templates.
  The selector displays the relative folder path alongside each template name.
- Relative CSS, JavaScript and image references are served from the selected
  HTML file's containing folder through a path-guarded theme asset endpoint.
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


## M3.2 — folder-based HTML theme library and Home dashboard entry

- HTML themes are discovered recursively under `%APPDATA%\\FluentFlyout\\web-theme`.
- The persisted selection is a relative path such as `Minimal/compact.html`.
- The selector shows the category folder path and template name, e.g.
  `Minimal / compact`; root-level templates are labelled `Root`.
- The selected HTML file's containing folder is the asset root. Relative CSS,
  JavaScript and image references are served through `/theme-assets/`; the
  endpoint rejects paths that escape the selected folder.
- The Home dashboard now has a WebSocket card directly before System Settings.
  It displays the enabled/disabled state and opens the dedicated WebSocket page.


## M3.3 — WebSocket delivery and browser progress smoothing

This iteration intentionally does not change the original FluentFlyout SMTC
position calculation or the native media Flyout seek-bar implementation.
The optimization is isolated to the OBS publishing and Browser Source path.

- `ObsWebServer` coalesces media-state callbacks over a 100 ms window and
  publishes only the newest pending snapshot.
- `WebSocketHub` uses a per-client sender. A slow Browser Source retains at
  most one pending media snapshot; newer snapshots replace older pending ones.
- Control messages such as `theme.changed` use a separate FIFO queue and are
  not overwritten by media snapshots.
- Removed the global socket-send semaphore. Each client still has exactly one
  sender, while a slow client no longer blocks broadcasts to other clients.
- The browser API rejects duplicate or older sequence numbers, including
  delayed frames around reconnects.
- The built-in theme maintains its own continuous playhead between snapshots.
  Small incoming position differences are eased over time; large differences
  are applied immediately as seek/timeline discontinuities.
- Protocol 1.0 and the existing media fields remain unchanged. Custom themes
  continue receiving the same `onMediaChanged` snapshots.

### M3.3 verification

1. Confirm `MainWindow.xaml.cs` SMTC position calculation and native seek-bar
   logic are unchanged.
2. Confirm a burst of timeline events produces at most one pending media
   snapshot per client.
3. Simulate a slow Browser Source and verify old pending snapshots are replaced
   rather than delivered as a backlog.
4. Connect two Browser Sources and verify a slow client does not delay the
   other client.
5. Verify duplicate/out-of-order sequence numbers are ignored.
6. Verify ordinary sub-second position changes do not restart or visibly jump
   the built-in progress animation.
7. Verify a large manual seek still updates the progress bar promptly.
8. Verify `theme.changed` is delivered even during frequent media updates.


## WebSocket progress calibration and idle sleep

This iteration keeps FluentFlyout's original media-position calculation and
native seek bar untouched. The only C# change in `MainWindow.xaml.cs` copies
the existing SMTC `TimelineProperties.LastUpdatedTime` into the additive
`timelineLastUpdatedTime` field for Browser Source consumers.

The built-in Browser Source now:

- Waits for at least three fresh, advancing timeline samples across a minimum
  500 ms window before starting local progress interpolation.
- Holds the displayed position during startup calibration and buffering.
- Enters a stalled state after 3.5 seconds without observed forward movement,
  or when the SMTC sample timestamp is stale by more than 4.5 seconds.
- Requires consecutive forward samples before resuming from a stall.
- Smooths a short forward jump after a detected pause in timeline movement;
  ordinary large seeks remain immediate.
- Keeps paused progress static and sleeps after five minutes of continuous
  pause.
- Sleeps immediately when no media is available or the playback state is
  Stopped/Closed.
- Stops requestAnimationFrame while calibrating, stalled, paused, hidden, or
  asleep; releases pending and displayed cover-image resources on sleep; and
  keeps only the single WebSocket subscription needed to wake on new playback.

The WebSocket connection intentionally remains open while the widget sleeps.
Closing it would prevent immediate wake-up and require polling/reconnect timers,
which would add rather than remove background work.

### Verification checklist

1. Start a network stream with delayed buffering: the progress bar must remain
   still until fresh SMTC samples advance consistently.
2. Confirm normal local playback starts after calibration without a visible
   artificial delay.
3. Buffer during playback: the progress bar must freeze instead of continuing
   to run ahead.
4. Resume after buffering: short forward gaps should ease smoothly; a manual
   seek should still respond promptly.
5. Pause playback: progress remains static; after five minutes the widget
   disappears and album-art resources are released.
6. Resume after the paused sleep: the widget wakes and recalibrates.
7. Stop playback or remove the media session: the widget sleeps immediately.
8. Leave the source idle for several minutes and verify there is no active
   animation-frame loop or accumulating timer/listener count.
