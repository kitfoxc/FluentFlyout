// SPDX-License-Identifier: GPL-3.0-or-later
using FluentFlyoutWPF.Classes.Audio;
using Xunit;

namespace FluentFlyoutWPF.Tests;

public class TempoEstimatorTests
{
    public static IEnumerable<object[]> ClickTracks()
    {
        foreach (int rate in new[] { 44100, 48000 })
        foreach (int channels in new[] { 1, 2 })
        foreach (int bpm in new[] { 80, 120, 160 })
            yield return new object[] { rate, channels, bpm };
    }

    [Theory]
    [MemberData(nameof(ClickTracks))]
    public void LocksWithinTenSecondsAndClearsAfterSilence(int rate, int channels, int bpm)
    {
        var detector = new TempoEstimator(rate);
        int beat = (int)Math.Round(rate * 60.0 / bpm);
        const int packetFrames = 211;
        var bytes = new byte[packetFrames * channels * 2];
        for (int offset = 0; offset < rate * 10; offset += packetFrames)
        {
            int count = Math.Min(packetFrames, rate * 10 - offset);
            for (int frame = 0; frame < count; frame++)
            {
                // Signal on one channel only; time still advances by full frames.
                bytes[frame * channels * 2 + 1] = (byte)((offset + frame) % beat < rate / 50 ? 96 : 0);
            }
            PcmFrames.Analyze(bytes.AsSpan(0, count * channels * 2), channels, 16, false, detector);
        }
        Assert.NotNull(detector.Bpm);
        Assert.InRange(detector.Bpm.Value, bpm - 3.0, bpm + 3.0);
        Assert.InRange(detector.Confidence, 0.70, 1.0);
        for (int frame = 0; frame < rate * 2; frame++) detector.Add(0);
        Assert.Null(detector.Bpm);
    }

    [Fact]
    public void IrregularIsolatedSoundsStayUnknown()
    {
        var detector = new TempoEstimator(48000);
        foreach (int gap in new[] { 39, 92, 54, 117, 73, 33, 86, 62, 102, 44, 79, 113 })
        {
            for (int frame = 0; frame < gap * 480; frame++)
                detector.Add(frame < 480 ? 0.5f : 0f);
        }
        Assert.Null(detector.Bpm);
    }
}
