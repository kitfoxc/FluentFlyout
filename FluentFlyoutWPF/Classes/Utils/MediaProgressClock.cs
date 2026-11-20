// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Diagnostics;

namespace FluentFlyout.Classes.Utils;

/// <summary>
/// Maintains one monotonic playhead for the native seek bar. SMTC timestamps
/// establish position anchors; Stopwatch time advances between fresh samples.
/// </summary>
public sealed class MediaProgressClock
{
    private static readonly DateTimeOffset ValidTimestampFloor =
        new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static readonly TimeSpan MaximumTimestampAge = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan StallTimeout = TimeSpan.FromMilliseconds(2500);
    private static readonly TimeSpan JitterTolerance = TimeSpan.FromMilliseconds(150);

    private readonly object _sync = new();
    private string? _sessionId;
    private TimeSpan _anchorPosition;
    private TimeSpan _lastRawPosition;
    private DateTimeOffset _lastTimelineUpdated;
    private long _anchorTimestamp;
    private long _lastSampleTimestamp;
    private bool _initialized;
    private bool _playing;
    private bool _stalled;

    public TimeSpan Update(
        string? sessionId,
        TimeSpan rawPosition,
        DateTimeOffset lastUpdatedTime,
        TimeSpan endTime,
        bool isPlaying)
    {
        return Update(
            sessionId,
            rawPosition,
            lastUpdatedTime,
            endTime,
            isPlaying,
            DateTimeOffset.UtcNow,
            Stopwatch.GetTimestamp());
    }

    internal TimeSpan Update(
        string? sessionId,
        TimeSpan rawPosition,
        DateTimeOffset lastUpdatedTime,
        TimeSpan endTime,
        bool isPlaying,
        DateTimeOffset utcNow,
        long timestamp)
    {
        lock (_sync)
        {
            if (!_initialized ||
                !string.Equals(_sessionId, sessionId, StringComparison.Ordinal))
            {
                ResetLocked(sessionId);
            }

            rawPosition = Clamp(rawPosition, endTime);

            if (!isPlaying)
            {
                SetAnchor(rawPosition, timestamp);
                RememberSample(rawPosition, lastUpdatedTime, timestamp);
                _playing = false;
                _stalled = false;
                return _anchorPosition;
            }

            var isNewSample = !_playing ||
                rawPosition != _lastRawPosition ||
                lastUpdatedTime != _lastTimelineUpdated;

            if (!_playing)
            {
                SetAnchor(EstimatePosition(rawPosition, lastUpdatedTime, endTime, utcNow), timestamp);
                _lastSampleTimestamp = timestamp;
                _playing = true;
                _stalled = false;
            }
            else if (isNewSample)
            {
                var wasStalled = _stalled;
                var estimate = EstimatePosition(rawPosition, lastUpdatedTime, endTime, utcNow);
                var current = GetPosition(timestamp, endTime);

                _lastSampleTimestamp = timestamp;
                _stalled = false;

                // Ignore small sampling jitter. Real seeks and meaningful drift
                // establish a new anchor immediately.
                if (wasStalled || (estimate - current).Duration() > JitterTolerance)
                    SetAnchor(estimate, timestamp);
            }
            else if (!_stalled &&
                     Stopwatch.GetElapsedTime(_lastSampleTimestamp, timestamp) >= StallTimeout)
            {
                // Do not let a stale "Playing" state advance forever while the
                // provider is buffering or has stopped updating its timeline.
                var stallAt = _lastSampleTimestamp +
                    (long)(StallTimeout.TotalSeconds * Stopwatch.Frequency);
                _anchorPosition = GetPosition(stallAt, endTime);
                _anchorTimestamp = stallAt;
                _stalled = true;
            }

            RememberSample(rawPosition, lastUpdatedTime, timestamp);
            return GetPosition(timestamp, endTime);
        }
    }

    public void Reset()
    {
        lock (_sync)
            ResetLocked(null);
    }

    private void ResetLocked(string? sessionId)
    {
        _sessionId = sessionId;
        _anchorPosition = TimeSpan.Zero;
        _lastRawPosition = TimeSpan.Zero;
        _lastTimelineUpdated = default;
        _anchorTimestamp = 0;
        _lastSampleTimestamp = 0;
        _initialized = false;
        _playing = false;
        _stalled = false;
    }

    private void SetAnchor(TimeSpan position, long timestamp)
    {
        _anchorPosition = position;
        _anchorTimestamp = timestamp;
        _initialized = true;
    }

    private void RememberSample(TimeSpan position, DateTimeOffset updatedAt, long timestamp)
    {
        _lastRawPosition = position;
        _lastTimelineUpdated = updatedAt;
        if (!_initialized)
        {
            _anchorTimestamp = timestamp;
            _initialized = true;
        }
    }

    private TimeSpan EstimatePosition(
        TimeSpan position,
        DateTimeOffset updatedAt,
        TimeSpan endTime,
        DateTimeOffset utcNow)
    {
        if (updatedAt >= ValidTimestampFloor)
        {
            var age = utcNow - updatedAt;
            if (age < TimeSpan.Zero)
                age = TimeSpan.Zero;
            else if (age > MaximumTimestampAge)
                age = MaximumTimestampAge;

            position += age;
        }

        return Clamp(position, endTime);
    }

    private TimeSpan GetPosition(long timestamp, TimeSpan endTime)
    {
        if (!_initialized)
            return TimeSpan.Zero;

        if (!_playing || _stalled || timestamp <= _anchorTimestamp)
            return Clamp(_anchorPosition, endTime);

        var elapsed = Stopwatch.GetElapsedTime(_anchorTimestamp, timestamp);
        return Clamp(_anchorPosition + elapsed, endTime);
    }

    private static TimeSpan Clamp(TimeSpan position, TimeSpan endTime)
    {
        if (position < TimeSpan.Zero)
            return TimeSpan.Zero;

        if (endTime > TimeSpan.Zero && position > endTime)
            return endTime;

        return position;
    }
}
