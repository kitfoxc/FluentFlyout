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

The optional `timelineLastUpdatedTime` field carries the SMTC sample timestamp.
It is metadata only: FluentFlyout's original SMTC position calculation and
native media seek bar are unchanged.

The built-in page uses a small progress synchronization state machine:

- `Waiting/Calibrating`: on track start or resume, hold the playhead until at
  least three fresh samples show forward movement over a minimum observation
  window. The page does not extrapolate during this phase.
- `Running`: interpolate locally with a monotonic browser clock and apply
  small corrections gradually.
- `Stalled`: if the timeline stops advancing or its sample timestamp becomes
  stale, freeze the playhead. Require consecutive advancing samples before
  resuming; short forward recovery gaps are eased rather than snapped.
- `Paused`: keep a static playhead and start an idle timer.

A large discontinuity during normal playback remains responsive as a seek.
A forward discontinuity after a detected stall is treated as a likely buffer
recovery and eased over a short interval. SMTC does not expose a universal
buffering flag, so stall detection is heuristic and may need tuning for
individual media sources.

For resource hygiene, the built-in page runs no animation frame while waiting,
stalled, paused, or asleep. It enters sleep immediately when no media is
available or playback is stopped/closed, and after five minutes of continuous
pause. Sleep hides and detaches the widget, releases album-art image resources,
and clears idle timers. The WebSocket listener remains connected so a new track
or resumed playback can wake the page immediately. The single media callback
is retained intentionally; no per-message listeners or animation loops are
created.

The shared `FluentFlyout.onMediaChanged(callback)` API remains Protocol 1.0
compatible; `timelineLastUpdatedTime` is an additive optional field.

The page is transparent outside the Fluent-inspired media card. It sleeps when
no SMTC media is available or playback is stopped, and after five minutes of
continuous pause. It reconnects automatically after service or Browser Source
restarts.

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
`album`, `playerName`, `playbackStatus`, `position`, `duration`, `timelineLastUpdatedTime`, and
`coverUrl`. The cover URL already includes the short-lived-in-process local
service token. `FluentFlyout.onMediaChanged(callback)` immediately invokes
the callback with the latest state when available and returns an unsubscribe
function. `FluentFlyout.getState()` returns the latest snapshot, and
`FluentFlyout.isConnected()` reports WebSocket connectivity.

Templates may reference CSS, JavaScript and images using paths relative to the selected theme folder. These requests are served from that folder through the guarded `/theme-assets/` route. Absolute application paths such as `/js/fluentflyout-api.js` continue to work. Paths cannot be used to access files outside the selected theme folder.

Treat imported templates as trusted local code: HTML scripts execute in OBS's browser context. Only immediate theme folders are selectable; nested folders are asset subfolders, not separate themes.
