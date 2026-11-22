// SPDX-License-Identifier: GPL-3.0-or-later
using System.Buffers.Binary;

namespace FluentFlyoutWPF.Classes.Audio;

internal static class PcmFrames
{
    internal static void Analyze(ReadOnlySpan<byte> data, int channels, int bits, bool floating, TempoEstimator estimator)
    {
        if (channels < 1 || bits is not (8 or 16 or 24 or 32) || (floating && bits != 32)) return;
        int width = bits / 8, frameSize = channels * width;
        while (data.Length >= frameSize)
        {
            double sum = 0;
            for (int channel = 0; channel < channels; channel++)
            {
                var sample = data.Slice(channel * width, width);
                float value = bits switch
                {
                    8 => (sample[0] - 128) / 128f,
                    16 => BinaryPrimitives.ReadInt16LittleEndian(sample) / 32768f,
                    24 => ((sample[0] << 8) | (sample[1] << 16) | (sample[2] << 24)) / 2147483648f,
                    32 when floating => BinaryPrimitives.ReadSingleLittleEndian(sample),
                    _ => BinaryPrimitives.ReadInt32LittleEndian(sample) / 2147483648f
                };
                if (float.IsFinite(value)) sum += Math.Clamp(value, -1f, 1f);
            }
            estimator.Add((float)(sum / channels));
            data = data[frameSize..];
        }
    }
}
