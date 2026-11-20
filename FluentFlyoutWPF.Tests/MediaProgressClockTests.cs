using System.Diagnostics;
using FluentFlyout.Classes.Utils;
using FluentFlyoutWPF.Classes.OBS.Models;
using FluentFlyoutWPF.Classes.OBS.Services;
using Xunit;

namespace FluentFlyoutWPF.Tests;

public sealed class MediaProgressClockTests
{
    private static readonly DateTimeOffset Epoch = new(2026, 11, 20, 0, 0, 0, TimeSpan.Zero);

    private static long Tick(double seconds) =>
        (long)(seconds * Stopwatch.Frequency);

    private static DateTimeOffset At(double seconds) => Epoch.AddSeconds(seconds);

    private static TimeSpan Update(
        MediaProgressClock clock,
        string session,
        double position,
        double updatedAt,
        double now,
        bool playing,
        double duration = 300)
    {
        return clock.Update(
            session,
            TimeSpan.FromSeconds(position),
            At(updatedAt),
            TimeSpan.FromSeconds(duration),
            playing,
            At(now),
            Tick(now));
    }

    [Fact]
    public void UsesTimelineTimestampToCompensateForDeliveryDelay()
    {
        var clock = new MediaProgressClock();

        var result = Update(clock, "player-a", 10, -1, 0, playing: true);

        Assert.Equal(TimeSpan.FromSeconds(11), result);
    }

    [Fact]
    public void AdvancesWithMonotonicTimeBetweenIdenticalSamples()
    {
        var clock = new MediaProgressClock();

        Assert.Equal(TimeSpan.FromSeconds(10), Update(clock, "player-a", 10, 0, 0, true));
        Assert.Equal(TimeSpan.FromSeconds(10.5), Update(clock, "player-a", 10, 0, 0.5, true));
        Assert.Equal(TimeSpan.FromSeconds(12), Update(clock, "player-a", 10, 0, 2, true));
    }

    [Fact]
    public void IgnoresSmallTimelineJitter()
    {
        var clock = new MediaProgressClock();

        Update(clock, "player-a", 10, 0, 0, true);
        var result = Update(clock, "player-a", 10.2, 0.3, 0.3, true);

        Assert.Equal(TimeSpan.FromSeconds(10.3), result);
    }

    [Fact]
    public void PauseFreezesAndResumeStartsFromThePausedPosition()
    {
        var clock = new MediaProgressClock();

        Update(clock, "player-a", 10, 0, 0, true);
        Assert.Equal(TimeSpan.FromSeconds(11), Update(clock, "player-a", 11, 1, 1, false));
        Assert.Equal(TimeSpan.FromSeconds(11), Update(clock, "player-a", 11, 1, 4, false));
        Assert.Equal(TimeSpan.FromSeconds(11), Update(clock, "player-a", 11, 4, 4, true));
        Assert.Equal(TimeSpan.FromSeconds(12), Update(clock, "player-a", 11, 4, 5, true));
    }

    [Fact]
    public void StaleTimelineStopsAndFreshSampleReanchorsWithoutJumping()
    {
        var clock = new MediaProgressClock();

        Update(clock, "player-a", 0, 0, 0, true);
        Assert.Equal(TimeSpan.FromSeconds(2.5), Update(clock, "player-a", 0, 0, 2.5, true));
        Assert.Equal(TimeSpan.FromSeconds(2.5), Update(clock, "player-a", 0, 0, 4, true));
        Assert.Equal(TimeSpan.FromSeconds(2.5), Update(clock, "player-a", 2.5, 4, 4, true));
        Assert.Equal(TimeSpan.FromSeconds(3.5), Update(clock, "player-a", 2.5, 4, 5, true));
    }

    [Fact]
    public void ChangingSessionResetsThePlayhead()
    {
        var clock = new MediaProgressClock();

        Update(clock, "player-a", 120, 0, 0, true);
        Assert.Equal(TimeSpan.Zero, Update(clock, "player-b", 0, 1, 1, true));
        Assert.Equal(TimeSpan.FromSeconds(1), Update(clock, "player-b", 0, 1, 2, true));
    }

    [Fact]
    public void PositionIsClampedToTheTimelineEnd()
    {
        var clock = new MediaProgressClock();

        var result = Update(clock, "player-a", 9, -5, 0, true, duration: 10);

        Assert.Equal(TimeSpan.FromSeconds(10), result);
    }
}

public sealed class MediaStateStoreTests
{
    [Fact]
    public void PublishAssignsSequenceAndClearPublishesUnavailableState()
    {
        var store = new MediaStateStore();
        var first = store.Publish(new NowPlayingInfo
        {
            IsAvailable = true,
            SessionId = "session-a",
            Title = "Track"
        });
        var cleared = store.Clear();

        Assert.Equal(1, first.Sequence);
        Assert.Equal(2, cleared.Sequence);
        Assert.Same(cleared, store.Current);
        Assert.False(store.Current.IsAvailable);
        Assert.Null(store.Current.SessionId);
    }
}
