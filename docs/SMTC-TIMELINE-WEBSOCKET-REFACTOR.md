# SMTC timeline and WebSocket refactor

## Branch and baseline

- Base: `master` (`4fb7254`).
- Branch: `refactor/smtc-timeline-websocket`.
- OBS WebSocket integration was imported from `feature/obs-now-playing-m1` as
  a single reviewable baseline commit. The older branch is not modified.

## Why the original progress path was unreliable

`MainWindow.SeekbarUpdateUi` previously used
`timeline.Position + (DateTime.Now - timeline.LastUpdatedTime.DateTime)`.
This mixed an adjustable wall clock with a provider timestamp, could run ahead
through buffering, and treated reaching the nominal end time as a synthetic
`Closed` playback status. It also used a thread-pool timer to perform UI
updates, increasing synchronization and lifecycle risk.

## New architecture

`SmtcTimelineClock` is a small, lock-protected, per-session model shared
between the native seekbar and OBS media snapshots:

1. Receive the reported position, duration, raw SMTC last-updated timestamp,
   and current playback state.
2. Treat repeated position+timestamp observations as the same sample.
3. Require actual source movement after initial playback or resuming, rather
   than advancing immediately when the status becomes Playing.
4. Re-anchor to a confirmed post-buffering sample. During normal playing,
   ignore small jitter, apply bounded partial corrections, and snap on seeks.
5. Use `Stopwatch.GetTimestamp()` for interpolation and cap extrapolation
   at five seconds without new evidence.
6. Stop extrapolating on pause, stop, buffering evidence, or at song duration.

`MainWindow` now uses a `DispatcherTimer` on its owning UI thread. It
does not poll `GetTimelineProperties` on every 300ms UI update. A per-session
clock avoids conflicts when OBS is pinned to a different player.

`ObsWebServer` projects the cached state at serialization time. Its additive
`positionProjectionMs` field describes the **remaining** interpolation
budget, not a fresh five-second window. The WebSocket protocol remains 1.0.

The bundled HTML theme has no browser-side calibration state machine. It
only clamps positions and animates within the server-provided budget.
Independent user themes remain supported under
`%APPDATA%\\FluentFlyout\\web-theme\\<folder>`.

## Preserved functionality and safety constraints

- Localhost-only HTTP/WS endpoints, random token authentication and origin
  restrictions; no media control commands over WebSocket.
- Separate WebSocket settings and theme selector.
- Latest-value media queue with bounded client control queues.
- Cover caching, non-recursive themes, path traversal/symlink checks.
- Pause sleep and cover cleanup in the bundled theme.

## Limits

SMTC has no universal buffer-state notification. A provider that never
updates its timeline cannot be distinguished from a stalled decoder. The
five-second maximum and movement confirmation prioritize avoiding unbounded
false progress over synthesizing a precise timeline without source evidence.
The model does not infer non-1x playback rate.

A Windows runtime/OBS test remains necessary to check each music source.

## Windows CI

Workflow: `.github/workflows/obs-now-playing-build.yml` (Windows runner,
.NET 10, Node test helpers, xUnit, Debug, Release x64 and ARM64).

A regular Git push to `refactor/smtc-timeline-websocket` triggers the workflow.
To trigger it from a local checkout even if the GitHub API integration did
not create a run:

```powershell
git fetch origin
git switch refactor/smtc-timeline-websocket
git commit --allow-empty -m "ci: trigger Windows SMTC verification"
git push origin refactor/smtc-timeline-websocket
```

Do not treat a passing Node test as proof of a passing WPF build or successful
OBS runtime behavior. Verify Actions results before merging PR #1.
