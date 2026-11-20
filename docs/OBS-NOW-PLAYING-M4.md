# OBS Now Playing — M4 remediation plan

Target branch: `feature/obs-now-playing-m1`  
Baseline: `548ccbf073c46b69083d37da6eca2a03ba852d40`  
Scope: stability, performance, configuration validation, and theme-resource safety.

## Non-negotiable compatibility constraints

- Do not change FluentFlyout's original SMTC position calculation or native seek-bar behavior.
- Keep WebSocket protocol version 1.0 and all existing message fields compatible.
- Preserve existing user themes and the current immediate-child theme-folder model.
- Prefer bounded work and latest-value delivery over unbounded queues.

## M4.1 — Browser progress correctness

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `FluentFlyoutWPF/Web/js/app.js` — paused branch in `render()` | Distinguish valid numeric zero from missing/invalid position | Seeking to 0 while paused displays 0:00 rather than the previous anchor | Pause, seek to 0, and verify position and progress width are zero |
| Same — `handleVisibilityChange()` | Use the same explicit position validation | A hidden/visible transition does not resurrect an old paused position | Hide and restore the Browser Source while paused at 0 |
| Same — `beginCalibration()` | Do not add stale initial snapshots to the calibration sample set | Only fresh timeline samples can prove playback advancement | Begin with an expired timestamp; interpolation must remain stopped |
| Same — `processCalibrationSample()` | Retain fresh samples for the full calibration timeout | Lower-frequency SMTC updates can satisfy the three-sample requirement | Three fresh advancing samples at 1.5–4.5-second intervals calibrate successfully |
| Same — `processStalledSample()` | Use a recovery window compatible with low-frequency providers | A stalled source can recover when two fresh advancing samples arrive slowly | Two fresh samples 1.5–4 seconds apart resume playback smoothly |
| Same — `synchronizePosition()` | Preserve seek snapping and drift correction | Manual seeks remain responsive; ordinary drift remains eased | Verify backward seek, large forward seek, and sub-second drift |

## M4.2 — Media and cover-art performance

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `FluentFlyoutWPF/MainWindow.xaml.cs` — media property/playback callbacks | Publish only when the changed session is the OBS-selected session | Unrelated players cannot trigger OBS media reads | Change a non-selected player's timeline and verify no OBS snapshot is published |
| Same — `MediaManager_OnAnyTimelinePropertyChanged()` | Add a timeline-only publishing path using the event's timeline snapshot | Timeline updates change position/duration/status without reading metadata or artwork | Timeline event does not call media-property or thumbnail APIs |
| Same — `PublishObsMediaState()` | Use a single thumbnail-hash result for the current artwork | Artwork is processed only on metadata/playback changes | One stable-hash operation per full media snapshot |
| `FluentFlyoutWPF/Classes/Utils/BitmapHelper.cs` — thumbnail API | Add an overload returning the hash alongside the decoded image | Callers needing both values do not hash the same stream twice | Existing callers remain source-compatible; OBS caller uses one hash |
| `FluentFlyoutWPF/Classes/OBS/Services/CoverArtStore.cs` — `Store()` | Make deduplication, encoding, insertion, and eviction atomic | Concurrent duplicate requests do not encode or enqueue the same key twice | Concurrent same-key Store calls create one cache entry; capacity remains bounded |

## M4.3 — WebSocket lifecycle and backpressure

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `FluentFlyoutWPF/Classes/OBS/Server/WebSocketHub.cs` — `ClientConnection` | Apply a bounded send timeout | A slow or wedged Browser Source cannot hold a sender indefinitely | A stalled send is aborted and its client is removed |
| Same — `EnqueueControl()` | Bound the FIFO control queue | Control-message bursts cannot grow memory without limit | Queue overflow removes the unhealthy client |
| Same — hub lifecycle | Add batch client-abort/clear support | Server shutdown releases every connected socket | Stop server with multiple clients and verify client count returns to zero |
| `FluentFlyoutWPF/Classes/OBS/Server/ObsWebServer.cs` — `StopAsync()` | Always dispose the captured WebApplication even if StopAsync fails | A failed stop does not orphan the host | Repeated stop/start after an induced stop failure remains possible |
| `FluentFlyoutWPF/MainWindow.xaml.cs` — settings gate and `CleanupResources()` | Serialize shutdown with settings-driven Start/Stop and make cleanup idempotent | Shutdown cannot race a port reconfiguration into a new listener | Close while toggling enable/port; no listener remains after exit |

## M4.4 — Configuration validation

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `FluentFlyoutWPF/ViewModels/UserSettings.cs` — `CompleteInitialization()` | Normalize OBS settings after XML deserialization and before initialization completes | Invalid persisted values cannot bypass property-change validation | Port outside 1024–65535 becomes 17832 |
| Same — theme/session settings | Normalize null/blank pin and invalid theme folder names | Invalid imported settings fall back safely | Import empty, rooted, separator-containing, and legacy theme values without startup failure |
| `FluentFlyoutWPF/Classes/Settings/SettingsManager.cs` — restore paths | Keep primary, backup, and import paths using the same normalization entry point | All restore sources receive identical validation | Test primary XML, backup XML, and imported XML |

## M4.5 — Theme filesystem boundary

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `FluentFlyoutWPF/Classes/OBS/Services/WebThemeManager.cs` — `GetAvailableThemes()` | Exclude reparse-point theme directories | A junction/symlink is not treated as a normal theme | A linked theme folder is not listed |
| Same — `ResolveThemeFolder()` | Reject or safely fall back from linked theme folders | Selected themes cannot redirect the theme root | Selecting a linked theme never reads outside web-theme |
| Same — `ResolveThemeAssetPath()` | Check each existing path component for reparse points | Asset paths cannot escape through a junction/symlink | A linked asset directory/file is rejected |
| Same — `ResolveThemePath()` | Apply the same guard to entry HTML | Entry HTML cannot bypass asset checks | A linked index/default HTML file is rejected |

## M4.6 — Automated and release verification

| File / location | Change | Expected behavior | Acceptance criteria |
|---|---|---|---|
| `.github/workflows/obs-now-playing-build.yml` and `FluentFlyout.SourceGenerators/FluentFlyout.SourceGenerators.csproj` | Keep the Roslyn analyzer AnyCPU and build Debug plus Release for x64/ARM64 | Architecture-specific app builds do not prevent the compiler from loading source generators | All tests and x64/ARM64 builds succeed |
| `FluentFlyoutWPF/Web/js/progress-utils.js` and `progress-utils.test.mjs` | Extract and test pure position/freshness/sample-window helpers | Zero, stale timestamps, low-frequency calibration, and slow recovery are deterministic | `node --test` passes in CI |
| `.github/workflows/build-msix.yml`, `Package.appxmanifest`, and `FluentFlyoutWPF/Web/README.md` | Make the ASP.NET Core 10 shared-framework prerequisite explicit; decide self-contained packaging only after install testing | Users and release maintainers can verify the runtime dependency instead of assuming Desktop Runtime is sufficient | `dotnet --list-runtimes` shows WindowsDesktop.App and AspNetCore.App 10.0; install and launch MSIX and verify `/api/health` |
| Release matrix | Verify x64 and ARM64 compatibility | Both supported architectures resolve required runtime assets | Both architecture builds succeed |

## Implementation status

- [x] M4.1 browser progress correctness — implemented and covered by passing Node tests.
- [x] M4.2 media and cover-art performance — implemented; Debug and Release builds pass.
- [x] M4.3 WebSocket lifecycle and backpressure — implemented and covered by passing service tests.
- [x] M4.4 configuration validation — implemented; Debug and Release builds pass.
- [x] M4.5 theme filesystem boundary — implemented and covered by path/reparse-point tests.
- [x] M4.6 automated tests and architecture builds — Node tests, 5 OBS service tests, Debug, Release x64, and Release ARM64 all pass.
- [ ] M4.6.1 packaged-runtime acceptance — install the actual MSIX on a clean machine, verify the required .NET 10 Desktop and ASP.NET Core runtimes, launch FluentFlyout, and check `http://127.0.0.1:<configured-port>/api/health`.

### CI verification

- Workflow run: [#44644100982](https://github.com/kitfoxc/FluentFlyout/actions/runs/44644100982) — success.
- Browser progress tests: passed.
- OBS service tests: 5 passed, 0 failed, 0 skipped.
- WPF Debug build: succeeded.
- WPF Release x64 build: succeeded.
- WPF Release ARM64 build: succeeded.
- Build errors: 0. The build still reports 36 existing compiler warnings and the solution restore emits NU1503 for the MSIX packaging project; neither prevented the WPF builds.

The code and CI gates above are complete. Actual MSIX installation and runtime dependency verification remain an explicit manual release gate because the current CI workflow builds the WPF app but does not install the packaged app on a clean Windows machine.
