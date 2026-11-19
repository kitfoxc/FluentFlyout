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
published state. The page extrapolates progress locally between Timeline
updates and re-synchronizes when new state arrives.

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

The built-in `index.html` is copied there as `default.html`. Organize
additional themes into subfolders, with one or more HTML files and their
supporting CSS, JavaScript, and image assets in each folder. For example:

```text
web-theme/
├── default.html
├── Minimal/
│   ├── compact.html
│   ├── wide.html
│   └── style.css
└── Neon/
    ├── neon.html
    ├── theme.css
    └── background.png
```

The WebSocket page recursively discovers `.html` files. The selector displays
the folder path followed by the HTML name (for example, `Minimal / compact`).
Select a template to apply it; connected OBS Browser Sources are notified and
reload automatically. Use **Refresh themes** after adding or moving files.

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

Templates may reference CSS, JavaScript and images using paths relative to the selected HTML file. These requests are served from that HTML file's containing theme folder through the guarded `/theme-assets/` route. Absolute application paths such as `/js/fluentflyout-api.js` continue to work. Theme folder paths cannot be used to access files outside the selected theme folder.

Treat imported templates as trusted local code: HTML scripts execute in OBS's browser context. Only HTML files are selectable; each HTML file's containing folder is its asset root.
