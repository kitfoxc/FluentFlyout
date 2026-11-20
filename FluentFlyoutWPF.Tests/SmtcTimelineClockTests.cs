using System.Diagnostics;
using FluentFlyoutWPF.Classes.Utils;
using Xunit;

namespace FluentFlyoutWPF.Tests;

public sealed class SmtcTimelineClockTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 20, 0, 0, 0, TimeSpan.Zero);
    private static long Ticks(double seconds) => (long)(seconds * Stopwatch.Frequency);
    private static TimeSpan Sec(double seconds) => TimeSpan.FromSeconds(seconds);

    [Fact]
    public void PlayingPosition_UsesMonotonicTimeAndStopsAfterBoundedHorizon()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("player", Sec(10), Sec(60), T0, true, Ticks(0));
        Assert.Equal(12, clock.Estimate("player", Ticks(2))!.Value.TotalSeconds, 3);
        Assert.Equal(15, clock.Estimate("player", Ticks(90))!.Value.TotalSeconds, 3);
    }

    [Fact]
    public void PauseWithUnchangedTimeline_FreezesPredictedPosition()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("player", Sec(10), Sec(60), T0, true, Ticks(0));
        clock.Observe("player", Sec(10), Sec(60), T0, false, Ticks(2));
        Assert.Equal(12, clock.Estimate("player", Ticks(60))!.Value.TotalSeconds, 3);
    }

    [Fact]
    public void ARepeatedSampleDoesNotRestartTheExtrapolationWindow()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("player", Sec(10), Sec(60), T0, true, Ticks(0));
        clock.Observe("player", Sec(10), Sec(60), T0, true, Ticks(4));
        Assert.Equal(15, clock.Estimate("player", Ticks(12))!.Value.TotalSeconds, 3);
    }

    [Fact]
    public void NewlyTimestampedUnchangedPositionFreezesBuffering()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("player", Sec(10), Sec(60), T0, true, Ticks(0));
        clock.Observe("player", Sec(10), Sec(60), T0.AddSeconds(2), true, Ticks(2));
        Assert.Equal(10, clock.Estimate("player", Ticks(9))!.Value.TotalSeconds, 3);
        clock.Observe("player", Sec(12), Sec(60), T0.AddSeconds(4), true, Ticks(4));
        Assert.InRange(clock.Estimate("player", Ticks(5))!.Value.TotalSeconds, 12, 13.1);
    }

    [Fact]
    public void SeekAndDurationClampTakeEffectImmediately()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("player", Sec(10), Sec(30), T0, true, Ticks(0));
        clock.Observe("player", Sec(25), Sec(30), T0.AddSeconds(1), true, Ticks(1));
        Assert.Equal(25, clock.Estimate("player", Ticks(1))!.Value.TotalSeconds, 3);
        Assert.Equal(30, clock.Estimate("player", Ticks(10))!.Value.TotalSeconds, 3);
    }

    [Fact]
    public void SessionsAreIndependentAndRemovalClearsTheirState()
    {
        var clock = new SmtcTimelineClock();
        clock.Observe("first", Sec(3), Sec(30), T0, true, Ticks(0));
        clock.Observe("second", Sec(8), Sec(30), T0, false, Ticks(0));
        Assert.Equal(8, clock.Estimate("second", Ticks(9))!.Value.TotalSeconds, 3);
        clock.Remove("first");
        Assert.Null(clock.Estimate("first", Ticks(9)));
    }
}
