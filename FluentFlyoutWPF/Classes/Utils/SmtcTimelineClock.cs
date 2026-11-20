// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Diagnostics;

namespace FluentFlyoutWPF.Classes.Utils;

/// <summary>
/// A bounded, monotonic projection of SMTC timeline samples. This is the one
/// playback-position model used by the native flyout and the WebSocket bridge.
/// It never changes the media provider or assumes SMTC timestamps are accurate
/// wall-clock anchors.
/// </summary>
public sealed class SmtcTimelineClock
{
    public const double MaximumExtrapolationSeconds = 5.0;
    private const double SampleEpsilonSeconds = 0.04;
    private const double NoiseBandSeconds = 0.18;
    private const double SeekThresholdSeconds = 2.5;
    private const double DriftCorrectionFraction = 0.35;

    private sealed class Anchor
    {
        public double Position;
        public double Duration;
        public double SourcePosition;
        public DateTimeOffset SourceUpdatedAt;
        public long Ticks;
        public bool IsPlaying;
        public bool CanAdvance;
    }

    private readonly object _sync = new();
    private readonly Dictionary<string, Anchor> _anchors = new(StringComparer.Ordinal);

    /// <summary>
    /// Accepts an SMTC observation. A repeated sample is not treated as new
    /// evidence; a genuine unchanged position from a new timestamp freezes
    /// the clock (for buffering). Large changes are treated as seeks.
    /// </summary>
    public TimeSpan Observe(
        string sessionId,
        TimeSpan sourcePosition,
        TimeSpan duration,
        DateTimeOffset sourceUpdatedAt,
        bool isPlaying,
        long? monotonicTicks = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        long now = monotonicTicks ?? Stopwatch.GetTimestamp();
        double maximum = Math.Max(0, duration.TotalSeconds);
        double raw = Clamp(sourcePosition.TotalSeconds, maximum);

        lock (_sync)
        {
            if (!_anchors.TryGetValue(sessionId, out var anchor))
            {
                anchor = new Anchor
                {
                    Position = raw, Duration = maximum, SourcePosition = raw,
                    SourceUpdatedAt = sourceUpdatedAt, Ticks = now,
                    IsPlaying = isPlaying, CanAdvance = false
                };
                _anchors.Add(sessionId, anchor);
                return TimeSpan.FromSeconds(raw);
            }

            bool samePosition = Math.Abs(raw - anchor.SourcePosition) <= SampleEpsilonSeconds;
            bool sameTimestamp = sourceUpdatedAt == anchor.SourceUpdatedAt;
            bool sameState = isPlaying == anchor.IsPlaying;

            if (samePosition && sameTimestamp && sameState && maximum == anchor.Duration)
                return TimeSpan.FromSeconds(Project(anchor, now));

            double predicted = Project(anchor, now);
            double next;
            bool canAdvance;

            if (!isPlaying)
            {
                // A pause event can arrive before the SMTC timeline is updated.
                // Preserve the predicted pause point if the timeline is unchanged.
                next = anchor.IsPlaying && samePosition && sameTimestamp ? predicted : raw;
                canAdvance = false;
            }
            else if (!anchor.IsPlaying)
            {
                // A 'playing' state does not prove that the decoder has moved.
                // Wait for an advancing source sample before extrapolating.
                next = raw;
                canAdvance = !samePosition;
            }
            else if (!anchor.CanAdvance && !samePosition)
            {
                // First confirmed movement after startup or buffering is
                // authoritative: no extrapolated position exists to smooth.
                next = raw;
                canAdvance = true;
            }
            else if (samePosition)
            {
                // A newly timestamped but unchanged sample indicates a stalled
                // transport. Avoid inventing progress while a source buffers.
                next = raw;
                canAdvance = false;
            }
            else
            {
                double error = raw - predicted;
                next = Math.Abs(error) <= NoiseBandSeconds
                    ? predicted
                    : Math.Abs(error) >= SeekThresholdSeconds
                        ? raw
                        : predicted + error * DriftCorrectionFraction;
                canAdvance = true;
            }

            anchor.Position = Clamp(next, maximum);
            anchor.SourcePosition = raw;
            anchor.SourceUpdatedAt = sourceUpdatedAt;
            anchor.Duration = maximum;
            anchor.Ticks = now;
            anchor.IsPlaying = isPlaying;
            anchor.CanAdvance = canAdvance;

            return TimeSpan.FromSeconds(anchor.Position);
        }
    }

    /// <summary>Returns the latest position without polling SMTC again.</summary>
    public TimeSpan? Estimate(string sessionId, long? monotonicTicks = null)
    {
        if (string.IsNullOrEmpty(sessionId))
            return null;
        long now = monotonicTicks ?? Stopwatch.GetTimestamp();
        lock (_sync)
            return _anchors.TryGetValue(sessionId, out var anchor)
                ? TimeSpan.FromSeconds(Project(anchor, now))
                : null;
    }

    /// <summary>
    /// Remaining extrapolation budget at the moment a snapshot is sent.
    /// Clients must not restart a fresh 5-second clock for an old sample.
    /// </summary>
    public int RemainingProjectionMilliseconds(string sessionId, long? monotonicTicks = null)
    {
        if (string.IsNullOrEmpty(sessionId))
            return 0;
        long now = monotonicTicks ?? Stopwatch.GetTimestamp();
        lock (_sync)
        {
            if (!_anchors.TryGetValue(sessionId, out var anchor) ||
                !anchor.IsPlaying || !anchor.CanAdvance)
                return 0;

            double age = Math.Max(0, (double)(now - anchor.Ticks) / Stopwatch.Frequency);
            return (int)Math.Max(0, Math.Ceiling((MaximumExtrapolationSeconds - age) * 1000));
        }
    }

    public void Remove(string sessionId)
    {
        if (string.IsNullOrEmpty(sessionId))
            return;
        lock (_sync)
            _anchors.Remove(sessionId);
    }

    private static double Project(Anchor anchor, long now)
    {
        if (!anchor.IsPlaying || !anchor.CanAdvance)
            return anchor.Position;

        double elapsed = Math.Clamp(
            (double)(now - anchor.Ticks) / Stopwatch.Frequency,
            0, MaximumExtrapolationSeconds);
        return Clamp(anchor.Position + elapsed, anchor.Duration);
    }

    private static double Clamp(double value, double duration)
    {
        if (!double.IsFinite(value))
            return 0;
        value = Math.Max(0, value);
        return duration > 0 ? Math.Min(value, duration) : value;
    }
}
