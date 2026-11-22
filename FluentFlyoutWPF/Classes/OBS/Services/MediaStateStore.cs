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

    private long _trackGeneration;
    public (long Generation, NowPlayingInfo State) ReadTempoContext()
    {
        lock (_sync) return (_trackGeneration, _current);
    }

    public void SetTempo(long generation, double? bpm)
    {
        NowPlayingInfo published;
        lock (_sync)
        {
            if (generation != _trackGeneration || bpm == _current.Bpm) return;
            published = _current = _current with { Sequence = ++_sequence, Bpm = bpm };
        }
        Notify(Changed, published);
    }

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
            bool reset = state.SessionId != _current.SessionId || state.Title != _current.Title ||
                state.Artist != _current.Artist || state.Album != _current.Album ||
                state.PlaybackStatus != _current.PlaybackStatus || state.IsAvailable != _current.IsAvailable;
            if (reset) _trackGeneration++;
            published = state with
            {
                Bpm = reset ? null : _current.Bpm,
                Sequence = ++_sequence,
                UpdatedAt = DateTimeOffset.UtcNow
            };

            _current = published;
            handlers = Changed;
        }

        Notify(handlers, published);
        return published;
    }

    private static void Notify(Action<NowPlayingInfo>? handlers, NowPlayingInfo published)
    {
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
    }

    public NowPlayingInfo Clear()
    {
        return Publish(NowPlayingInfo.Empty);
    }
}
