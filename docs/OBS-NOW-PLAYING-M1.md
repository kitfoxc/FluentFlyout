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

- `ObsWebServer`: Kestrel server bound only to `127.0.0.1:17832`.
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

### Browser Source

`http://127.0.0.1:17832/`

Suggested initial size: 520 × 150.

### HTTP endpoints

- `GET /api/health`
- `GET /api/config` (same-origin configuration/token bootstrap)
- `GET /api/now-playing?token=...`
- `GET /api/covers/{coverId}?token=...`

### WebSocket

`ws://127.0.0.1:17832/ws?token=...`

Protocol version: `1.0`.

The server sends `state.snapshot` on connect and `media.changed` for
subsequent SMTC updates. The WebSocket endpoint is read-only; playback
commands are deliberately excluded from this milestone.

## Build validation

A Windows GitHub Actions workflow was added at
`.github/workflows/obs-now-playing-build.yml`. It restores the solution and
builds the WPF project on pushes to the OBS feature branch. A successful local
or CI build is still required before treating the implementation as verified.

## M3 follow-up

- Add OBS integration settings and configurable port/enable switch.
- Exercise multiple simultaneous Browser Sources and reconnect behavior.
- Validate thumbnail cache eviction and player-specific SMTC behavior.
- Add tests for protocol serialization and session selection.
