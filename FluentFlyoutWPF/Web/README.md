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

The built-in page keeps a continuous local playhead between snapshots. Small
position differences are applied gradually; large discontinuities are treated
as explicit seeks or timeline resets. This prevents each WebSocket update from
restarting the progress animation and makes transient SMTC position jitter less
visible. The shared `FluentFlyout.onMediaChanged(callback)` API remains
Protocol 1.0 compatible.

The page is transparent outside the Fluent-inspired media card. It hides when
no SMTC session is available and reconnects automatically after service or
Browser Source restarts.

## Runtime note

The current implementation uses the `Microsoft.AspNetCore.App` shared
framework for Kestrel. Development machines with the .NET 10 SDK have this
framework available. Before distributing a framework-dependent build, ensure
the ASP.NET Core 10 Runtime is installed alongside the .NET Desktop Runtime,
or configure the release packaging as self-contained. This packaging decision
is tracked for the next milestone.


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
`album`, `playerName`, `playbackStatus`, `position`, `duration`, and
`coverUrl`. The cover URL already includes the short-lived-in-process local
service token. `FluentFlyout.onMediaChanged(callback)` immediately invokes
the callback with the latest state when available and returns an unsubscribe
function. `FluentFlyout.getState()` returns the latest snapshot, and
`FluentFlyout.isConnected()` reports WebSocket connectivity.

Templates may reference CSS, JavaScript and images using paths relative to the selected theme folder. These requests are served from that folder through the guarded `/theme-assets/` route. Absolute application paths such as `/js/fluentflyout-api.js` continue to work. Paths cannot be used to access files outside the selected theme folder.

Treat imported templates as trusted local code: HTML scripts execute in OBS's browser context. Only immediate theme folders are selectable; nested folders are asset subfolders, not separate themes.
