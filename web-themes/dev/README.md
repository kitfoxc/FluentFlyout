# dev

将 dev 文件夹解压到 web-theme，在 FluentFlyout 中选择 dev。诊断区展示 WebSocket 媒体快照中的 bpm 及其状态。

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

The built-in page uses the original FluentFlyout timeline model rather than
waiting for multiple advancing Position samples. It calculates the logical
playhead from the latest SMTC Position plus the elapsed time since
LastUpdatedTime. If that timestamp is missing or a sentinel, the server's
UpdatedAt timestamp is used as the initial fallback anchor. Subsequent
updates without a valid SMTC timestamp do not repeatedly re-anchor an
unchanged Position; the browser continues from its local monotonic clock and
uses clear Position discontinuities only as seek/reset signals. A stale but
valid SMTC timestamp is not treated as proof that playback has stopped. The calculated
position is bounded by the reported track duration when known.

The renderer keeps separate logical and visual playheads. The logical
playhead uses the original SMTC timeline model and the browser's monotonic
clock; the visual playhead is a presentation-only layer.

When a new track starts with a valid SMTC timeline timestamp, a time-bounded
startup guard protects the first visual anchor for up to 4.2 seconds. It waits
for two consecutive advancing raw Position samples and for the estimated
playhead to catch up before releasing early. If Position remains unchanged,
the guard times out and resumes from the last displayed position. During the
guard, a backward timeline sample may refresh the logical anchor but cannot
pull the visible playhead backward. A raw Position decrease greater than the
backward-seek threshold is treated as an explicit seek and is applied
immediately.

Outside that guard, a timestamp-derived backward delta alone is not treated as
a seek: some providers refresh TimelineLastUpdatedTime while Position remains
at zero during startup. Backward snaps require a corresponding raw Position
discontinuity. The visual playhead otherwise interpolates forward only;
ordinary forward drift uses a short exponential-smoothing time constant and
larger forward recovery gaps use a longer one. Confirmed seeks and large
forward discontinuities snap immediately rather than animating in the wrong
direction. The progress fill is updated with CSS transform at animation-frame
frequency, while the displayed time text is throttled to five updates per
second. The guard is presentation-only and does not change SMTC, WebSocket,
or the original logical timeline calculation.

SMTC does not expose a universal buffering flag. If a provider reports
Playing while audio is actually buffering, the logical playhead may continue
to advance until a new timeline anchor arrives. A later forward correction is
visually eased when reasonably small; a clear seek or very large discontinuity
is applied immediately.

For resource hygiene, the built-in page runs no animation frame while paused
or asleep. It enters sleep immediately when no media is available or playback
is stopped/closed, and after five minutes of continuous pause. Sleep hides and detaches the widget, releases album-art image resources,
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

On first initialization, the bundled renderer template is extracted into
`web-theme/default` as `index.html`, `css/fluent.css`, `js/app.js`, and
`js/progress-utils.js`. All four files are then served directly from that
writable directory. Edit any of these files and manually refresh the OBS Browser
Source to see the changes; no application rebuild is needed. No automatic file
watching, renderer version migration, or overwriting of existing files occurs.
The communication adapter at `/js/fluentflyout-api.js` remains bundled with
the application and is not editable through the theme directory.

Every immediate subfolder of `web-theme` represents exactly one
theme. FluentFlyout does not scan loose files in the root or recursively scan
nested folders.

```text
web-theme/
├── default/
│   ├── index.html
│   ├── css/
│   │   └── fluent.css
│   └── js/
│       ├── app.js
│       └── progress-utils.js
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
upgrade when the new default entry does not already exist. Existing
`default/index.html` is never overwritten; missing default renderer CSS/JS
files are initialized individually. Older HTML with absolute `/css/fluent.css`,
`/js/app.js`, and `/js/progress-utils.js` references continues to work:
these URLs are compatibility aliases to the external `default` folder. Other loose root
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


## Default theme customization notes

The refreshed default theme is a diagnostic player layout. It displays every
field in the Protocol 1.0 `NowPlayingInfo` snapshot (including session ID,
sequence, playback state, availability, cover identifiers, SMTC timeline
timestamp and service update timestamp), plus renderer connection and
efficiency-mode state.

Progress adaptation is explicitly reported:
- **SMTC timeline**: a valid `timelineLastUpdatedTime` is available; the
  playhead is extrapolated from Position and that timestamp.
- **UpdatedAt fallback**: SMTC's timeline timestamp is missing or sentinel;
  UpdatedAt supplies the initial fallback anchor.
- **Position direct**: neither timestamp is usable; only reported Position and
  obvious discontinuities can guide the local playhead.
- **Incomplete**: Duration is missing or invalid, so a percentage cannot be
  calculated. The raw Position and Duration remain visible.

The default renderer enters efficiency mode immediately when there is no
available media or playback is stopped/closed. After five minutes of continuous
pause it also enters efficiency mode. In efficiency mode animation frames and
pause timers are stopped; the single WebSocket subscription remains active so
new media can wake the page. A paused track does not run a progress animation.

### What can be customized

- `index.html`: layout, labels, section ordering and additional presentation
  elements. Keep every DOM ID referenced by `app.js`.
- `css/fluent.css`: all visual styling. The `:root` variables near the top
  are the primary color, spacing and radius controls.
- `js/app.js`: presentation logic, displayed diagnostics, smoothing values
  in `CONFIG`, and the five-minute pause efficiency timeout.

### Required interface code — do not remove

- In `index.html`, keep `/js/fluentflyout-api.js` before the renderer module.
- Keep `window.FluentFlyout.onMediaChanged(callback)` and
  `window.FluentFlyout.onConnectionChanged(callback)` subscriptions.
- Keep the Protocol 1.0 payload property names. The renderer expects the
  normalized fields documented above.
- Keep the `progress-utils.js` module exports imported by `app.js`.
- The API adapter owns the local token, WebSocket reconnect logic and cover
  URL authentication. Never print the complete cover URL because its query
  string contains the process-local token.

The HTML comments mark required DOM/API contracts and customizable regions.
The CSS comments mark theme tokens. The JavaScript comments distinguish the
required interface contract from customizable presentation configuration.
