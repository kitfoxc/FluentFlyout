// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

namespace FluentFlyoutWPF.Classes.OBS.Models;

/// <summary>
/// Normalized media state shared by FluentFlyout UI and external presentation
/// clients such as the OBS Browser Source.
/// </summary>
public sealed record NowPlayingInfo
{
    public long Sequence { get; init; }

    public string? SessionId { get; init; }

    public string? Title { get; init; }

    public string? Artist { get; init; }

    public string? Album { get; init; }

    public string? PlayerName { get; init; }

    public NowPlayingPlaybackStatus PlaybackStatus { get; init; }
        = NowPlayingPlaybackStatus.Stopped;

    /// <summary>Current playback position, in seconds.</summary>
    public double Position { get; init; }

    /// <summary>Track duration, in seconds. Zero means unknown.</summary>
    public double Duration { get; init; }

    /// <summary>
    /// Remaining milliseconds the browser may safely extrapolate this snapshot.
    /// Zero means paused, buffering, or too long since the last trustworthy sample.
    /// </summary>
    public int PositionProjectionMs { get; init; }

    /// <summary>
    /// Original SMTC timestamp retained as protocol metadata. The native
    /// seekbar and WebSocket position use a shared monotonic clock instead.
    /// </summary>
    public DateTimeOffset? TimelineLastUpdatedTime { get; init; }

    /// <summary>Opaque identifier used by the local cover-art endpoint.</summary>
    public string? CoverId { get; init; }

    public string? CoverUrl { get; init; }

    public bool IsAvailable { get; init; }

    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;

    public static NowPlayingInfo Empty { get; } = new()
    {
        IsAvailable = false,
        PlaybackStatus = NowPlayingPlaybackStatus.Stopped,
        Position = 0,
        Duration = 0
    };
}

public enum NowPlayingPlaybackStatus
{
    Stopped,
    Playing,
    Paused,
    Closed
}
