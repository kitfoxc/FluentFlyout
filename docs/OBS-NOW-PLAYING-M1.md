# OBS Now Playing — M1 foundation

This milestone introduces the normalized media-state contract without moving
the existing SMTC event handlers out of `MainWindow`.

## Added components

- `NowPlayingInfo`: immutable DTO shared by the desktop UI and future OBS API.
- `MediaStateStore`: thread-safe latest snapshot, monotonically increasing
  sequence number, and change notification for future WebSocket subscribers.
- `MediaSessionSelector`: generic selector that preserves the existing
  pinned-session → focused-session → first-valid-session behavior while
  allowing the existing `MainWindow.IsSessionAllowed` predicate to be reused.

## Integration plan

The next integration change should instantiate one `MediaStateStore` and one
`MediaSessionSelector` for the lifetime of `MainWindow`. The current media
manager remains the single SMTC owner. Existing UI-specific side effects
(Next Up, Taskbar Widget, Flyout and seek bar) remain in `MainWindow`; the
SMTC callbacks additionally publish a normalized snapshot to the store.

The OBS server will subscribe to `MediaStateStore.Changed` and send
`MediaStateStore.Current` to newly connected Browser Sources.

## Deliberate non-goals for M1

- No new NuGet dependencies.
- No changes to the existing media-manager lifecycle.
- No HTTP or WebSocket listener yet.
- No playback-control commands.
- No changes to existing settings serialization.

This keeps the first change isolated and avoids changing the current desktop
media behavior before the OBS transport is implemented.
