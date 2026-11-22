// SPDX-License-Identifier: GPL-3.0-or-later
namespace FluentFlyoutWPF.Classes.Audio;

// Use 10 ms RMS windows and a bounded history of recent onset intervals.
// All time measurements use audio frames; callback sizes never enter the clock.
internal sealed class TempoEstimator(int sampleRate)
{
    private readonly int window = Math.Max(1, sampleRate / 100);
    private readonly Queue<int> intervals = new();
    private double energy, previous, floor;
    private int frames, tick, lastOnset = -1000;
    internal double? Bpm { get; private set; }
    internal double Confidence { get; private set; }

    internal void Add(float mono)
    {
        energy += mono * mono;
        if (++frames < window) return;
        double level = Math.Sqrt(energy / frames);
        frames = 0;
        energy = 0;
        tick++;
        double rise = level - previous;
        previous = level;
        bool onset = rise > Math.Max(0.012, floor * 3) && tick - lastOnset >= 20;
        floor += 0.04 * (Math.Max(0, rise) - floor);
        if (tick - lastOnset > 150)
        {
            intervals.Clear();
            Bpm = null;
            Confidence = 0;
        }
        if (!onset) return;
        int gap = tick - lastOnset;
        lastOnset = tick;
        if (gap > 150) return;
        intervals.Enqueue(gap);
        if (intervals.Count > 14) intervals.Dequeue();
        if (intervals.Count < 5) return;

        // Directly observed intervals carry more weight than subdivisions or
        // missed beats. An isolated double/half interval cannot flip tempo.
        double bestScore = 0;
        double period = 0;
        foreach (int candidate in intervals)
        {
            if (candidate < 30 || candidate > 120) continue;
            double score = 0, sum = 0;
            foreach (int interval in intervals)
            {
                double ratio = (double)interval / candidate;
                double multiple = ratio > 1.5 ? 2 : ratio < 0.75 ? 0.5 : 1;
                double normalized = interval / multiple;
                if (Math.Abs(normalized - candidate) > Math.Max(2, candidate * 0.06)) continue;
                double weight = multiple == 1 ? 1 : 0.4;
                sum += normalized * weight;
                score += weight;
            }
            if (score <= bestScore) continue;
            bestScore = score;
            period = sum / score;
        }
        Confidence = bestScore / intervals.Count;
        Bpm = Confidence >= 0.70 ? 60.0 * sampleRate / (window * period) : null;
    }
}
