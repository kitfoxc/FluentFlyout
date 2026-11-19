# OBS Browser Source

With FluentFlyout running, add an OBS **Browser Source** with this URL:

`http://127.0.0.1:17832/`

Suggested initial canvas size: **520 × 150**.

The page is served by FluentFlyout itself. It obtains a per-process token from
the same-origin configuration endpoint and connects to the local WebSocket.
Do not copy the token into stream overlays or public URLs.

The MVP page is transparent outside the Fluent-inspired media card. It hides
when no SMTC session is available and reconnects automatically after service
or Browser Source restarts.

Current protocol: **1.0**.

The current M2 transport publishes metadata and playback timeline snapshots.
Cover-art delivery is wired into the page contract but will be enabled in the
next integration pass once SMTC thumbnail bytes are connected to the local
cover cache.
