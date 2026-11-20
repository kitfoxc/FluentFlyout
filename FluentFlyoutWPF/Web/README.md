# OBS Browser Source

With FluentFlyout running, add an OBS **Browser Source** with this URL:

`http://127.0.0.1:17832/`

Suggested initial canvas size: **520 × 150**.

The page is served by FluentFlyout itself. It obtains a per-process random
access token from the same-origin configuration endpoint and connects to the
local WebSocket. The token is held in page memory and is not part of the
Browser Source URL. Do not publish the token or expose the local service to
your LAN.

## Local endpoints

- `GET /api/health` — service health and connected client count.
- `GET /api/config` — per-process token and WebSocket path (same-origin only).
- `GET /api/now-playing?token=...` — authenticated current state snapshot.
- `GET /api/covers/{coverId}?token=...` — authenticated cached PNG album art.
- `WS /ws?token=...` — authenticated real-time state stream.

The server binds only to `127.0.0.1`. Browser requests with an Origin header
are accepted only from localhost on the configured port. Playback-control
commands are intentionally not exposed in this MVP.

## Protocol 1.0

Each WebSocket message has this shape:

```json
{
  "protocol": "1.0",
  "type": "state.snapshot",
  "sequence": 12,
  "timestamp": "2026-11-19T19:30:00Z",
  "data": {
    "isAvailable": true,
    "title": "Track title",
    "artist": "Artist",
    "album": "Album",
    "playerName": "Player",
    "playbackStatus": "Playing",
    "position": 82.5,
    "duration": 200,
    "positionProjectionMs": 4200,
    "timelineLastUpdatedTime": "2026-11-19T19:30:00Z",
    "coverId": "a1b2c3d4",
    "coverUrl": "/api/covers/a1b2c3d4"
  }
}
```

A complete `state.snapshot` is sent immediately after connection. Subsequent
SMTC updates are sent as `media.changed`. Sequence numbers increase for each
published state, and clients ignore duplicate or older sequence numbers.

Timeline callbacks are coalesced for a short 100 ms window, so a burst publishes
only its newest snapshot. Each WebSocket client also has a latest-value media
slot: if a Browser Source is still receiving an older frame, intermediate
pending media frames are replaced instead of forming a send backlog. Control
messages such as `theme.changed` remain ordered and are not replaced by media
updates.

The optional `timelineLastUpdatedTime` field still carries the original SMTC
sample timestamp for compatibility. It is no longer used by the built-in HTML
theme to infer playback timing.

The native flyout and WebSocket now share `SmtcTimelineClock`:

- Source position changes are anchored using a monotonic clock.
- The playhead does not advance on initial `Playing` status alone. A real
  forward position sample must be observed first.
- Repeated samples do not reset the extrapolation deadline.
- A new timeline sample with unchanged position freezes the playhead for
  potential buffering; an explicit pause or stop always freezes it.
- Small position discrepancies are ignored or partially corrected, while
  large discontinuities are treated as seeks.
- Playback is extrapolated no further than five seconds after a confirmed
  position sample; the timeline is clamped to its reported duration.

The additive `positionProjectionMs` field tells HTML themes how many
milliseconds of further local interpolation the **current outgoing snapshot**
may use. `0` means the position is frozen. It is recalculated immediately
before WebSocket delivery (including new-client connection and HTTP snapshots),
so repeated/late snapshots do not restart an expired five-second budget.

The built-in page is a simple renderer: it uses `performance.now()` and
`positionProjectionMs` to animate and then stop. It does not independently
classify SMTC freshness, infer decoder activity, or maintain a second playback
calibration state machine. When `positionProjectionMs` is absent on an older
server, it uses a bounded five-second fallback. Existing custom themes can
ignore the additive field and continue using Protocol 1.0.

For resource hygiene, the built-in page has no animation loop when the
projection budget expires, when paused, or while hidden. It releases album
art immediately after stop/close and after five minutes of continuous pause.
The WebSocket connection remains open so playback can wake the page.

## Runtime note

The current implementation uses the `Microsoft.AspNetCore.App` shared
framework for Kestrel. A framework-dependent installation therefore needs both
the .NET 10 Desktop Runtime and the ASP.NET Core 10 Runtime. The MSIX manifest
does not currently declare an ASP.NET Core framework package, so do not assume
that installing the Desktop Runtime alone is sufficient.

To verify a machine's installed frameworks, run:

```powershell
dotnet --list-runtimes
```

The output should include `Microsoft.WindowsDesktop.App 10.0.x` and
`Microsoft.AspNetCore.App 10.0.x`. Development machines with the .NET 10 SDK
normally have the required shared frameworks. The release packaging decision
(self-contained deployment versus an explicit ASP.NET Core runtime prerequisite)
remains open until an actual MSIX install/launch test is completed.


## WebSocket HTML themes

FluentFlyout creates the user theme directory on first launch:

`%APPDATA%\\FluentFlyout\\web-theme`

The built-in `index.html` is copied into the `default` theme folder as
`index.html`. Every immediate subfolder of `web-theme` represents exactly one
theme. FluentFlyout does not scan loose files in the root or recursively scan
nested folders.

```text
web-theme/
├── default/
│   └── index.html
├── Minimal/
│   ├── index.html
│   ├── style.css
│   └── cover-frame.png
└── Neon/
    ├── index.html
    ├── theme.css
    └── background.png
```

Put one entry HTML file in each theme folder. The preferred entry filename is
`index.html`; if it is absent, FluentFlyout uses `default.html`, then the
first top-level `.html` file in that folder. Supporting CSS, JavaScript and
images can live beside the HTML or in asset subfolders.

The WebSocket page lists only immediate folder names, such as `default`,
`Minimal`, and `Neon`. It does not display HTML filenames or nested paths.
Select a folder to apply its theme; connected OBS Browser Sources reload
automatically. Use **Refresh themes** after adding or removing a theme folder.

Legacy root-level `default.html` is copied into `default/index.html` during
upgrade when the new default entry does not already exist. Other loose root
HTML files are intentionally ignored; move each theme into its own folder.
A custom HTML file should include the shared browser API:

```html
<script src="/js/fluentflyout-api.js"></script>
<script>
  FluentFlyout.onMediaChanged(media => {
    document.querySelector("#title").textContent = media.title || "";
    document.querySelector("#artist").textContent = media.artist || "";
    document.querySelector("#cover").src = media.coverUrl || "";
  });
</script>
```

The callback receives a media snapshot with fields such as `title`, `artist`,
`album`, `playerName`, `playbackStatus`, `position`, `duration`, `timelineLastUpdatedTime`, and
`coverUrl`. The cover URL already includes the short-lived-in-process local
service token. `FluentFlyout.onMediaChanged(callback)` immediately invokes
the callback with the latest state when available and returns an unsubscribe
function. `FluentFlyout.getState()` returns the latest snapshot, and
`FluentFlyout.isConnected()` reports WebSocket connectivity.

Templates may reference CSS, JavaScript and images using paths relative to the selected theme folder. These requests are served from that folder through the guarded `/theme-assets/` route. Absolute application paths such as `/js/fluentflyout-api.js` continue to work. Paths cannot be used to access files outside the selected theme folder.

Treat imported templates as trusted local code: HTML scripts execute in OBS's browser context. Only immediate theme folders are selectable; nested folders are asset subfolders, not separate themes.
