# Minimalist Player — FluentFlyout API Edition

This package updates the supplied three-file player to the current FluentFlyout
WebSocket Protocol 1.0 interface while preserving its original layout, percentage
badge, cover placement, scrolling title/artist-album text, and OBS scene theme
switching.

## Files

```text
index.html
main.js
style.css
README.md
```

## Install

1. Put these files together in the selected theme folder.
2. Make sure the theme is hosted by FluentFlyout's WebSocket theme server.
3. The page loads the app-owned adapter from `/js/fluentflyout-api.js`.
4. Refresh the theme / OBS Browser Source.

Do not copy a separate `fluentflyout-api.js` into the theme folder. The adapter
is supplied by the application and owns:
- `/api/config` token retrieval
- WebSocket connection and reconnection
- Protocol 1.0 message validation
- duplicate/out-of-order sequence filtering
- authenticated `coverUrl` generation

The renderer no longer polls `/api/query` and no longer calls
`/api/cover/convert`.

## Progress behavior

The renderer is synchronized with the project's `fix/obs-visual-progress-stability`
implementation:

| Setting | Value |
|---|---:|
| Normal smoothing time constant | 150 ms |
| Recovery smoothing time constant | 500 ms |
| Backward seek threshold | 0.8 s |
| Forward snap threshold | 8 s |
| Startup guard maximum duration | 4.2 s |
| Advancing samples before release | 2 |
| Minimum reported advance per sample | 0.05 s |
| Startup catch-up tolerance | 0.15 s |

Progress anchor priority:
1. `timelineLastUpdatedTime` (SMTC timeline timestamp)
2. `updatedAt` (timestamp fallback, matching the project helper)
3. reported `position` if no valid timestamp exists

During playback, the logical playhead uses a monotonic browser clock. The visible
playhead is smoothed independently. Timestamp-only backward corrections do not
cause a visual rollback; a clear backward `Position` discontinuity is treated as
a seek. The startup guard holds transient backward corrections until samples
stabilize, a seek is detected, or the bounded guard window expires.

The visual fill width is driven by the smoothed playhead with `requestAnimationFrame`.
The CSS width transition is intentionally disabled to avoid applying a second
smoothing layer.

## Data mapping

| Protocol 1.0 field | Player use |
|---|---|
| `title` | Track title |
| `artist` | Artist label |
| `album` | Album label appended to artist |
| `coverUrl` | Album artwork, including adapter-added token |
| `playbackStatus` | Playing / Paused / Stopped / Closed transitions |
| `position` | Reported timeline position, seconds |
| `duration` | Track duration, seconds |
| `timelineLastUpdatedTime` | Primary SMTC timeline anchor |
| `updatedAt` | Timestamp fallback |
| `isAvailable` | Active media session availability |
| `sessionId` | Track/session identity |
| `sequence` | Delivered and filtered by the API adapter |

## OBS theme switching

Scene names containing `[dark]` or `[light]` continue to select the player
palette. If neither tag exists, the default theme is light.

## Notes

- The original UI has a percentage badge rather than elapsed/remaining labels;
  it remains unchanged.
- The renderer does not expose playback controls because Protocol 1.0 currently
  supplies media state, not playback commands.
- Album artwork is loaded directly from the authenticated `coverUrl`; the
  access-token URL is never logged or displayed.
- The theme's progress bar uses its original fill/thumb DOM structure. The
  smoothing algorithm updates the fill width, which moves the thumb at its end.


## Default no-album-art cover

`default-cover.svg` is the supplied SVG artwork and is used whenever a track
does not provide cover art or its cover URL fails to load. It is referenced
relative to `index.html`, so it stays inside this theme folder.


## Track-change progress reset animation

When the media session reports a different track, the renderer captures the
previous track's displayed progress percentage and animates that fill back to
0% using an ease-out cubic curve (default duration: 360 ms). The reset is
performed in percentage space so it remains visually correct even when the
new track has a different duration. Once the reset completes, the new track's
normal logical timeline and smoothing take over. The SMTC anchor and startup
jitter guard are not reset or delayed by the visual-only transition.

Customize `CONFIG.trackChangeResetMs` in `main.js` to change the reset duration.


## Always-visible progress thumb and percentage

The progress thumb is never hidden. The percentage badge always shows a numeric
value. If duration is missing/invalid, or neither a usable `position` nor a
valid timeline/updated timestamp is available, the visual fill, thumb and
percentage stay at `0%`. When progress data becomes incomplete, the slider eases from the percentage
currently on screen to 0%, then stays there.


## Smooth manual seeking

Confirmed manual seeks now move the visible playhead smoothly in either direction
instead of snapping immediately. The logical SMTC/timeline anchor is updated
immediately, while the visual playhead interpolates toward it using a dedicated
420 ms exponential smoothing time constant. Normal playback remains monotonic
and keeps its existing 150/500 ms smoothing and startup jitter protection.

A seek while paused also animates: the renderer temporarily runs requestAnimationFrame
against the fixed paused target, then returns to its low-activity paused state.
Change `CONFIG.seekSmoothingMs` in `main.js` to tune the seek transition speed.


## Text marquee pause after each pass

Long title and artist/album text now scrolls one complete pass, pauses briefly,
then repeats. The pause is implemented as a stationary tail segment in the
Web Animations API timeline, so the text does not jump or restart when the
pause ends. The title and artist/album rows have independent animation handles
and are safely canceled/rebuilt when metadata changes or the layout is resized.

Customize `SCROLL_SETTINGS.pauseDurationMs` (default 1200 ms) to change the
pause duration. Existing per-row speeds remain unchanged.


## Legacy asset cleanup and eased marquee

Removed the remaining references to the previous application-bundled asset files from the HTML.
Both the initial album-cover image and the page favicon now use the theme-local
`./default-cover.svg`, so the theme no longer requests the old bundled cover
or a missing legacy favicon path.

The marquee now uses a per-keyframe cubic-bezier easing on each travel segment:
it accelerates gently at the beginning and decelerates gently as it reaches the
end of a pass. It then remains stationary for the configured pause duration
before the next pass. The duplicated text keeps the loop visually continuous.

## Smooth progress corrections

Pause, reconnect, timeline availability changes, and other snapshot updates that
would reposition the slider use a cubic ease-out from the last displayed
percentage (360 ms by default, set by `CONFIG.progressCorrectionMs`). An
interrupted transition starts its replacement from the current on-screen value.
Disconnect still freezes the displayed progress until a fresh snapshot arrives.
Playing track changes with usable progress retain the separate reset-to-zero
animation before following the new timeline.
