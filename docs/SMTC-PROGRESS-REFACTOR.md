# SMTC Progress and WebSocket Refactor

Branch: `feature/smtc-progress-refactor`  
Base: `master`

## Scope

- Keep the existing SMTC source and session-selection rules.
- Centralize native seek-bar progress in `MediaProgressClock`.
- Expose the same selected SMTC session to OBS through a local HTTP/WebSocket service.
- Keep the Browser Source renderer small and independent from the native WPF seek bar.
- Avoid a second OBS-only session pin, duplicate server-side media queue, or a multi-stage browser calibration state machine.

## Native SMTC progress

`MediaProgressClock` owns the native seek-bar playhead:

1. A SMTC timeline sample is interpreted at `LastUpdatedTime`.
2. Delivery delay is compensated using UTC time, capped at two seconds.
3. Between samples, `Stopwatch` advances the position monotonically.
4. Paused samples anchor the clock without extrapolation.
5. A session change, seek, or meaningful timeline correction establishes a new anchor. Differences up to 150 ms are treated as sampling jitter.
6. If the provider stops producing new position/timestamp samples for 2.5 seconds while reporting Playing, the clock freezes rather than advancing indefinitely.
7. Position is clamped to the timeline end when available.

The timer and timeline-event paths now feed the same clock, so they no longer alternate between raw and wall-clock-extrapolated values.

## WebSocket integration

- WebSocket output follows `GetActiveMediaSession()`, reusing FluentFlyout's existing filtering, pinned-session, focused-session and fallback behavior.
- There is no duplicate OBS-only media selector or `ObsPinnedSessionId`.
- The immutable media snapshot carries raw SMTC position and `TimelineLastUpdatedTime`.
- `MediaStateStore` assigns sequence numbers; new clients receive an immediate full snapshot.
- `WebSocketHub` keeps only the newest pending media snapshot per slow client. A second server-side coalescing queue is intentionally omitted.
- The server binds to `127.0.0.1`, protects state/WebSocket/cover endpoints with a per-process token, and serves custom theme assets from the selected theme folder.
- Theme folders are immediate children of `%AppData%\\FluentFlyout\\web-theme`; the built-in `default` folder is created automatically.

## Browser Source progress

The built-in theme uses a deliberately smaller model:

- It waits for forward SMTC progress before starting interpolation.
- It suppresses startup progress below two percent of the known duration.
- It uses `performance.now()` for local rendering and the SMTC timestamp to estimate the received position.
- It eases ordinary corrections, snaps clear seeks, and freezes after 4.5 seconds without source advancement.
- Paused pages sleep after five minutes; no-media/stopped pages release the cover image.

The browser and native seek bar do not share an extrapolated position. Both derive their own playhead from the same raw SMTC timeline, avoiding double extrapolation.

## Validation

Automated checks:

- `node --test FluentFlyoutWPF/Web/js/progress-utils.test.mjs`
- `dotnet test FluentFlyoutWPF.Tests/FluentFlyoutWPF.Tests.csproj`
- WPF Debug, Release x64 and Release ARM64 builds (GitHub Actions workflow).

Manual Windows/SMTC checks:

1. Start a track from 0 and verify the progress bar does not flicker around the first few samples.
2. Play for several minutes and verify monotonic movement between SMTC updates.
3. Pause and resume repeatedly; paused time must not be added.
4. Seek forward and backward; the seek bar should follow without a long correction tail.
5. Simulate buffering or a frozen SMTC timeline; the playhead should stop after the stall threshold.
6. Switch between players and tracks, including a new track that starts at 0.
7. Connect/reconnect OBS while playing, paused, stopped and with no active session.
8. Test a slow Browser Source client and confirm it receives the newest state rather than a backlog.
9. Change themes and port; verify the server restarts cleanly and existing native media behavior remains unchanged.

## Known limitation

When a player reports Playing but supplies no advancing timeline position and no usable timestamp, FluentFlyout cannot reconstruct the true audio playhead from duration and status alone. The clock intentionally freezes after the stall timeout instead of inventing continued progress. The 150 ms, 2.5 second and 4.5 second thresholds are conservative heuristics and should be tuned only against real SMTC traces.
