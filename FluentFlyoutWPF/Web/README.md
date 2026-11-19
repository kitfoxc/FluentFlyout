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
