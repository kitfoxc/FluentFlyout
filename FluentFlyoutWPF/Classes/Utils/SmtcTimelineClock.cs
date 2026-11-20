// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Diagnostics;

namespace FluentFlyoutWPF.Classes.Utils;

/// <summary>
/// A bounded, monotonic projection of SMTC timeline samples. This is the one
/// playback-position model used by the native flyout and the WebSocket bridge.
/// </summary>
public sealed class SmtcTimelineClock
{
    public const double MaximumExtrapolationSeconds = 5.0;
    public const double FallbackStartDelaySeconds = 1.5;
    private const double SampleEpsilonSeconds = 0.04;
    private const double NoiseBandSeconds = 0.18;
    private const double SeekThresholdSeconds = 2.5;
    private const double DriftCorrectionFraction = 0.35;
    private const int FallbackProjectionMilliseconds = 1000;

    private sealed class Anchor
    {
        public double Position;
        public double Duration;
        public double SourcePosition;
        public DateTimeOffset SourceUpdatedAt;
        public long Ticks;
        public bool IsPlaying;
        public bool CanAdvance;
        public bool IsBuffering;
        public bool HasReliableTimeline;
    }

    private readonly object _sync = new();
    private readonly Dictionary<string, Anchor> _anchors = new(StringComparer.Ordinal);

    /// <summary>
    /// Accepts an SMTC observation. When a source exposes no usable timeline,
    /// playback state and a monotonic clock provide a fallback after a short
    /// startup grace period. A newly timestamped unchanged sample from a
    /// seek-capable source is treated as an explicit buffering signal.
    /// </summary>
    public TimeSpan Observe(
        string sessionId,
        TimeSpan sourcePosition,
        TimeSpan duration,
        DateTimeOffset sourceUpdatedAt,
        bool isPlaying,
        long? monotonicTicks = null,
        bool hasReliableTimeline = true)
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
                    Position = raw,
                    Duration = maximum,
                    SourcePosition = raw,
                    SourceUpdatedAt = sourceUpdatedAt,
                    Ticks = now,
                    IsPlaying = isPlaying,
                    CanAdvance = false,
                    HasReliableTimeline = hasReliableTimeline
                };
                _anchors.Add(sessionId, anchor);
                return TimeSpan.FromSeconds(raw);
            }

            bool samePosition = Math.Abs(raw - anchor.SourcePosition) <= SampleEpsilonSeconds;
            bool sameTimestamp = sourceUpdatedAt == anchor.SourceUpdatedAt;
            bool sameState = isPlaying == anchor.IsPlaying;

            if (samePosition && sameTimestamp && sameState &&
                hasReliableTimeline == anchor.HasReliableTimeline)
            {
                anchor.Duration = maximum;
                return TimeSpan.FromSeconds(Project(anchor, now));
            }

            double predicted = Project(anchor, now);
            double next;
            bool canAdvance;
            bool isBuffering;

            if (!isPlaying)
            {
                // A pause event can arrive before the SMTC timeline is updated.
                // Keep the projected point when the source cannot report position.
                next = anchor.IsPlaying && samePosition &&
                    (sameTimestamp || !hasReliableTimeline)
                    ? predicted
                    : raw;
                canAdvance = false;
                isBuffering = false;
            }
            else if (!anchor.IsPlaying)
            {
                // Resume from the provider's latest position. If it has no
                // position feed, the fallback clock starts after the grace period.
                next = raw;
                canAdvance = !samePosition;
                isBuffering = false;
            }
            else if (samePosition && !hasReliableTimeline)
            {
                // Non-seekable sources often keep LastUpdatedTime moving while
                // Position remains unavailable. Do not mistake that for buffering.
                if (anchor.IsBuffering)
                {
                    anchor.Position = raw;
                    anchor.Ticks = now;
                    anchor.CanAdvance = false;
                    anchor.IsBuffering = false;
                }

                anchor.SourceUpdatedAt = sourceUpdatedAt;
                anchor.Duration = maximum;
                anchor.HasReliableTimeline = false;
                return TimeSpan.FromSeconds(Project(anchor, now));
            }
            else if (samePosition)
            {
                // A fresh unchanged sample from a source with a usable timeline
                // is evidence of buffering, so freeze until the source moves again.
                next = raw;
                canAdvance = false;
                isBuffering = true;
            }
            else if (!anchor.CanAdvance)
            {
                // First confirmed movement after startup or buffering is
                // authoritative: there is no extrapolated position to smooth.
                next = raw;
                canAdvance = true;
                isBuffering = false;
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
                isBuffering = false;
            }

            anchor.Position = Clamp(next, maximum);
            anchor.SourcePosition = raw;
            anchor.SourceUpdatedAt = sourceUpdatedAt;
            anchor.Duration = maximum;
            anchor.Ticks = now;
            anchor.IsPlaying = isPlaying;
            anchor.CanAdvance = canAdvance;
            anchor.IsBuffering = isBuffering;
            anchor.HasReliableTimeline = hasReliableTimeline;

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
    /// Remaining projection budget at the moment a snapshot is sent.
    /// Fallback-clock snapshots are refreshed periodically by the host, so
    /// clients receive a short projection window instead of restarting 5 seconds.
    /// </summary>
    public int RemainingProjectionMilliseconds(string sessionId, long? monotonicTicks = null)
    {
        if (string.IsNullOrEmpty(sessionId))
            return 0;
        long now = monotonicTicks ?? Stopwatch.GetTimestamp();
        lock (_sync)
        {
            if (!_anchors.TryGetValue(sessionId, out var anchor) ||
                !anchor.IsPlaying || anchor.IsBuffering || anchor.Duration <= 0)
                return 0;

            double age = Math.Max(0, (double)(now - anchor.Ticks) / Stopwatch.Frequency);
            if (!anchor.CanAdvance)
            {
                if (age <= FallbackStartDelaySeconds)
                    return 0;

                return Project(anchor, now) < anchor.Duration
                    ? FallbackProjectionMilliseconds
                    : 0;
            }

            if (!anchor.HasReliableTimeline)
                return Project(anchor, now) < anchor.Duration
                    ? FallbackProjectionMilliseconds
                    : 0;

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
        if (!anchor.IsPlaying || anchor.IsBuffering || anchor.Duration <= 0)
            return anchor.Position;

        double elapsed = Math.Max(0, (double)(now - anchor.Ticks) / Stopwatch.Frequency);
        if (!anchor.CanAdvance)
            elapsed = Math.Max(0, elapsed - FallbackStartDelaySeconds);
        else if (anchor.HasReliableTimeline)
            elapsed = Math.Min(elapsed, MaximumExtrapolationSeconds);

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