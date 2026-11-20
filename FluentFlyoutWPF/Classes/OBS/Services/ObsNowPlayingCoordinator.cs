// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyout.Classes;
using FluentFlyout.Classes.Utils;
using FluentFlyoutWPF.Classes.OBS.Models;
using FluentFlyoutWPF.Classes.OBS.Server;
using Windows.Media.Control;
using static WindowsMediaController.MediaManager;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Owns the optional OBS Now Playing integration and its SMTC subscriptions.
/// Failures in this coordinator are isolated from FluentFlyout's original media UI.
/// </summary>
public sealed class ObsNowPlayingCoordinator
{
    private static readonly NLog.Logger Logger = NLog.LogManager.GetCurrentClassLogger();

    private readonly WindowsMediaController.MediaManager _mediaManager;
    private readonly MediaStateStore _mediaStateStore;
    private readonly CoverArtStore _coverArtStore;
    private readonly Func<MediaSession?> _getActiveMediaSession;
    private readonly Func<MediaSession?, bool> _isSessionAllowed;
    private readonly Func<GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionMediaProperties?> _tryGetMediaProperties;
    private readonly Func<string?> _getPinnedSessionId;
    private readonly Action _clearPinnedSession;
    private readonly Func<bool> _isEnabled;
    private readonly Func<int> _getPort;
    private readonly Func<string?> _getThemeFolderName;
    private readonly MediaSessionSelector _sessionSelector = new();

    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly CancellationTokenSource _shutdownCts = new();
    private WebThemeManager? _themeManager;
    private ObsWebServer? _server;
    private int _started;
    private int _subscribed;
    private int _stopping;

    public ObsNowPlayingCoordinator(
        WindowsMediaController.MediaManager mediaManager,
        MediaStateStore mediaStateStore,
        CoverArtStore coverArtStore,
        Func<MediaSession?> getActiveMediaSession,
        Func<MediaSession?, bool> isSessionAllowed,
        Func<GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionMediaProperties?> tryGetMediaProperties,
        Func<string?> getPinnedSessionId,
        Action clearPinnedSession,
        Func<bool> isEnabled,
        Func<int> getPort,
        Func<string?> getThemeFolderName)
    {
        _mediaManager = mediaManager ?? throw new ArgumentNullException(nameof(mediaManager));
        _mediaStateStore = mediaStateStore ?? throw new ArgumentNullException(nameof(mediaStateStore));
        _coverArtStore = coverArtStore ?? throw new ArgumentNullException(nameof(coverArtStore));
        _getActiveMediaSession = getActiveMediaSession ?? throw new ArgumentNullException(nameof(getActiveMediaSession));
        _isSessionAllowed = isSessionAllowed ?? throw new ArgumentNullException(nameof(isSessionAllowed));
        _tryGetMediaProperties = tryGetMediaProperties ?? throw new ArgumentNullException(nameof(tryGetMediaProperties));
        _getPinnedSessionId = getPinnedSessionId ?? throw new ArgumentNullException(nameof(getPinnedSessionId));
        _clearPinnedSession = clearPinnedSession ?? throw new ArgumentNullException(nameof(clearPinnedSession));
        _isEnabled = isEnabled ?? throw new ArgumentNullException(nameof(isEnabled));
        _getPort = getPort ?? throw new ArgumentNullException(nameof(getPort));
        _getThemeFolderName = getThemeFolderName ?? throw new ArgumentNullException(nameof(getThemeFolderName));
    }

    /// <summary>
    /// Marks the coordinator as available and, when already opted in, subscribes before
    /// MainWindow attaches its original UI handlers.
    /// </summary>
    public void Start()
    {
        if (Volatile.Read(ref _stopping) != 0 ||
            Interlocked.CompareExchange(ref _started, 1, 0) != 0)
            return;

        try
        {
            if (_isEnabled())
            {
                Subscribe();
                RefreshMediaSource();
            }
        }
        catch (Exception ex)
        {
            Unsubscribe();
            Logger.Error(ex, "Failed to initialize OBS SMTC event subscriptions");
        }
    }

    public void RefreshMediaSource()
    {
        TryPublishMediaState("manual refresh");
    }

    public void RefreshTheme()
    {
        if (_server?.IsRunning == true)
            _ = NotifyThemeChangedSafeAsync();
    }

    /// <summary>Applies the current opt-in and port settings.</summary>
    public void ApplySettings()
    {
        _ = ApplySettingsAsync();
    }

    private async Task ApplySettingsAsync()
    {
        if (Volatile.Read(ref _started) == 0 || Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            await _lifecycleGate.WaitAsync(_shutdownCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            return;
        }

        try
        {
            if (Volatile.Read(ref _started) == 0 || Volatile.Read(ref _stopping) != 0)
                return;

            if (!_isEnabled())
            {
                Unsubscribe();
                if (_server?.IsRunning == true)
                    await _server.StopAsync(_shutdownCts.Token).ConfigureAwait(false);

                return;
            }

            Subscribe();
            RefreshMediaSource();
            EnsureServer();

            if (_server!.IsRunning)
                await _server.StopAsync(_shutdownCts.Token).ConfigureAwait(false);

            if (Volatile.Read(ref _stopping) != 0 || _shutdownCts.IsCancellationRequested)
                return;

            var port = _getPort();
            if (_server.Port != port)
                _server.ReconfigurePort(port);

            await _server.StartAsync(_shutdownCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            // Expected when the app is shutting down while Kestrel starts or stops.
        }
        catch (Exception ex)
        {
            // Directory, port-binding and Kestrel failures must not affect the desktop flyout.
            Logger.Error(ex, "Failed to apply OBS Now Playing settings");

            if (_server?.IsRunning != true)
                Unsubscribe();
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    private void EnsureServer()
    {
        // Delay touching Roaming storage and creating Kestrel until the user opts in.
        _themeManager ??= new WebThemeManager();
        _server ??= new ObsWebServer(
            _mediaStateStore,
            _coverArtStore,
            _themeManager,
            () => _getThemeFolderName() ?? "default",
            _getPort());
    }

    /// <summary>
    /// Detaches OBS event handlers first, then asynchronously stops the local server.
    /// A bounded wait keeps application shutdown from blocking the WPF dispatcher.
    /// </summary>
    public async Task StopAsync(TimeSpan timeout)
    {
        if (Interlocked.Exchange(ref _stopping, 1) != 0)
            return;

        Interlocked.Exchange(ref _started, 0);
        Unsubscribe();
        _shutdownCts.Cancel();

        var gateAcquired = false;
        try
        {
            gateAcquired = await _lifecycleGate.WaitAsync(timeout).ConfigureAwait(false);
            if (!gateAcquired)
            {
                Logger.Warn("Timed out waiting for OBS server operations during shutdown");
                return;
            }

            if (_server is not null)
            {
                using var stopTimeout = new CancellationTokenSource(timeout);
                await _server.StopAsync(stopTimeout.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException ex)
        {
            Logger.Warn(ex, "OBS WebSocket server shutdown was cancelled or timed out");
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "Failed to stop OBS WebSocket server cleanly");
        }
        finally
        {
            if (gateAcquired)
                _lifecycleGate.Release();
        }
    }

    private async Task NotifyThemeChangedSafeAsync()
    {
        try
        {
            if (_server is not null)
                await _server.NotifyThemeChangedAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "Failed to notify OBS Browser Sources about the selected theme");
        }
    }

    private void Subscribe()
    {
        if (Interlocked.CompareExchange(ref _subscribed, 1, 0) != 0)
            return;

        try
        {
            _mediaManager.OnAnyMediaPropertyChanged += OnAnyMediaPropertyChanged;
            _mediaManager.OnAnyPlaybackStateChanged += OnAnyPlaybackStateChanged;
            _mediaManager.OnAnyTimelinePropertyChanged += OnAnyTimelinePropertyChanged;
            _mediaManager.OnAnySessionClosed += OnAnySessionClosed;
        }
        catch
        {
            Unsubscribe();
            throw;
        }
    }

    private void OnAnyPlaybackStateChanged(
        MediaSession mediaSession,
        GlobalSystemMediaTransportControlsSessionPlaybackInfo? playbackInfo = null)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            if (IsSelectedSession(mediaSession))
                PublishObsMediaState();
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "OBS playback-state event handling failed");
        }
    }

    private void OnAnyMediaPropertyChanged(
        MediaSession mediaSession,
        GlobalSystemMediaTransportControlsSessionMediaProperties mediaProperties)
    {
        if (Volatile.Read(ref _stopping) != 0 || mediaSession.ControlSession is null)
            return;

        try
        {
            if (IsSelectedSession(mediaSession))
                PublishObsMediaState();
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "OBS media-property event handling failed");
        }
    }

    private void OnAnyTimelinePropertyChanged(
        MediaSession mediaSession,
        GlobalSystemMediaTransportControlsSessionTimelineProperties timelineProperties)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            if (GetObsMediaSession() is { } obsSession &&
                string.Equals(obsSession.Id, mediaSession.Id, StringComparison.Ordinal))
            {
                PublishObsTimelineState(obsSession, timelineProperties);
            }
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "OBS timeline event handling failed");
        }
    }

    private void OnAnySessionClosed(MediaSession mediaSession)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            if (string.Equals(
                _getPinnedSessionId(),
                mediaSession.Id,
                StringComparison.Ordinal))
            {
                _clearPinnedSession();
            }

            PublishObsMediaState();
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "OBS session-close event handling failed");
        }
    }

    private bool IsSelectedSession(MediaSession mediaSession)
    {
        return GetObsMediaSession() is { } obsSession &&
            string.Equals(obsSession.Id, mediaSession.Id, StringComparison.Ordinal);
    }

    private MediaSession? GetObsMediaSession()
    {
        var sessions = _mediaManager.CurrentMediaSessions.Values
            .Where(session => _isSessionAllowed(session))
            .ToList();

        if (sessions.Count == 0)
            return null;

        return _sessionSelector.Select(
            sessions,
            _getActiveMediaSession(),
            _getPinnedSessionId(),
            session => session.Id,
            session => _isSessionAllowed(session));
    }

    private void TryPublishMediaState(string reason)
    {
        if (Volatile.Read(ref _started) == 0 || Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            PublishObsMediaState();
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "OBS media state publication failed during {0}", reason);
        }
    }

    private void PublishObsMediaState()
    {
        var session = GetObsMediaSession();
        if (session is null)
        {
            _mediaStateStore.Clear();
            return;
        }

        if (session.ControlSession is not { } controlSession)
        {
            _mediaStateStore.Clear();
            return;
        }

        var properties = _tryGetMediaProperties(controlSession);
        var playback = controlSession.GetPlaybackInfo();
        var timeline = controlSession.GetTimelineProperties();
        var duration = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalSeconds);
        var playerName = MediaPlayerData.GetAndCacheMediaPlayerData(session.Id).Item1;

        if (properties is null)
        {
            var current = _mediaStateStore.Current;
            if (!current.IsAvailable ||
                !string.Equals(current.SessionId, session.Id, StringComparison.Ordinal))
            {
                _mediaStateStore.Publish(new NowPlayingInfo
                {
                    SessionId = session.Id,
                    PlayerName = playerName,
                    PlaybackStatus = ToObsPlaybackStatus(playback?.PlaybackStatus),
                    Position = Math.Max(0, timeline.Position.TotalSeconds),
                    Duration = duration,
                    TimelineLastUpdatedTime = timeline.LastUpdatedTime,
                    IsAvailable = true
                });
            }

            return;
        }

        var thumbnail = BitmapHelper.GetThumbnail(properties.Thumbnail, out var thumbnailHash);
        var coverId = thumbnailHash == 0 || thumbnail is null
            ? null
            : _coverArtStore.Store($"{thumbnailHash:x8}", thumbnail);

        _mediaStateStore.Publish(new NowPlayingInfo
        {
            SessionId = session.Id,
            Title = properties.Title,
            Artist = properties.Artist,
            Album = properties.AlbumTitle,
            PlayerName = playerName,
            PlaybackStatus = ToObsPlaybackStatus(playback?.PlaybackStatus),
            Position = Math.Max(0, timeline.Position.TotalSeconds),
            Duration = duration,
            TimelineLastUpdatedTime = timeline.LastUpdatedTime,
            CoverId = coverId,
            CoverUrl = coverId is null ? null : $"/api/covers/{coverId}",
            IsAvailable = true
        });
    }

    private void PublishObsTimelineState(
        MediaSession session,
        GlobalSystemMediaTransportControlsSessionTimelineProperties timeline)
    {
        var current = _mediaStateStore.Current;
        if (!current.IsAvailable ||
            !string.Equals(current.SessionId, session.Id, StringComparison.Ordinal))
        {
            TryPublishMediaState("timeline session changed");
            return;
        }

        try
        {
            var playback = session.ControlSession.GetPlaybackInfo();
            _mediaStateStore.Publish(current with
            {
                PlaybackStatus = ToObsPlaybackStatus(playback?.PlaybackStatus),
                Position = Math.Max(0, timeline.Position.TotalSeconds),
                Duration = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalSeconds),
                TimelineLastUpdatedTime = timeline.LastUpdatedTime
            });
        }
        catch (Exception ex)
        {
            Logger.Debug(ex, "Failed to publish OBS timeline-only update");
        }
    }

    private static NowPlayingPlaybackStatus ToObsPlaybackStatus(
        GlobalSystemMediaTransportControlsSessionPlaybackStatus? playbackStatus)
    {
        return playbackStatus switch
        {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => NowPlayingPlaybackStatus.Playing,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => NowPlayingPlaybackStatus.Paused,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed => NowPlayingPlaybackStatus.Closed,
            _ => NowPlayingPlaybackStatus.Stopped
        };
    }

    private void Unsubscribe()
    {
        if (Interlocked.Exchange(ref _subscribed, 0) == 0)
            return;

        TryUnsubscribe(() => _mediaManager.OnAnyMediaPropertyChanged -= OnAnyMediaPropertyChanged);
        TryUnsubscribe(() => _mediaManager.OnAnyPlaybackStateChanged -= OnAnyPlaybackStateChanged);
        TryUnsubscribe(() => _mediaManager.OnAnyTimelinePropertyChanged -= OnAnyTimelinePropertyChanged);
        TryUnsubscribe(() => _mediaManager.OnAnySessionClosed -= OnAnySessionClosed);
    }

    private static void TryUnsubscribe(Action unsubscribe)
    {
        try
        {
            unsubscribe();
        }
        catch (Exception ex)
        {
            Logger.Warn(ex, "Failed to detach an OBS SMTC event handler");
        }
    }
}
