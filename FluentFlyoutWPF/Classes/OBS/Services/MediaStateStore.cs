// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyoutWPF.Classes.OBS.Models;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Thread-safe, process-wide-in-instance snapshot of the latest media state.
/// New OBS clients can read Current immediately instead of waiting for the
/// next SMTC event.
/// </summary>
public sealed class MediaStateStore
{
    private readonly object _sync = new();
    private NowPlayingInfo _current = NowPlayingInfo.Empty;
    private long _sequence;

    public event Action<NowPlayingInfo>? Changed;

    public NowPlayingInfo Current
    {
        get
        {
            lock (_sync)
                return _current;
        }
    }

    /// <summary>
    /// Publishes a complete snapshot. Sequence numbers are assigned centrally
    /// so WebSocket consumers can detect stale or missed updates.
    /// </summary>
    public NowPlayingInfo Publish(NowPlayingInfo state)
    {
        ArgumentNullException.ThrowIfNull(state);

        NowPlayingInfo published;
        Action<NowPlayingInfo>? handlers;

        lock (_sync)
        {
            published = state with
            {
                Sequence = ++_sequence,
                UpdatedAt = DateTimeOffset.UtcNow
            };

            _current = published;
            handlers = Changed;
        }

        // Never execute external subscribers while holding the state lock.
        if (handlers is not null)
        {
            foreach (Action<NowPlayingInfo> handler in handlers.GetInvocationList())
            {
                try
                {
                    handler(published);
                }
                catch (Exception ex)
                {
                    NLog.LogManager.GetCurrentClassLogger()
                        .Error(ex, "A media-state subscriber failed");
                }
            }
        }

        return published;
    }

    public NowPlayingInfo Clear()
    {
        return Publish(NowPlayingInfo.Empty);
    }
}
