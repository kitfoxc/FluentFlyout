// SPDX-License-Identifier: GPL-3.0-or-later
using Microsoft.Win32;
using NAudio.Wave;
using System.Diagnostics;
using System.Threading.Channels;

namespace FluentFlyoutWPF.Classes.Audio;

// Headless entry point for a future WebSocket consumer. Construct on demand,
// await disposal when the last consumer leaves. No WPF bitmap is created.
internal sealed class BpmCaptureSession : IAsyncDisposable
{
    private sealed record Reading(double Bpm, double Confidence, long Timestamp);
    private sealed record Packet(byte[] Data, long Sequence, long Timestamp);
    private static readonly NLog.Logger Logger = NLog.LogManager.GetCurrentClassLogger();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task worker;
    private volatile Reading? latest;

    public (double Bpm, double Confidence)? Current
    {
        get
        {
            var result = latest;
            return result != null && Stopwatch.GetElapsedTime(result.Timestamp).TotalSeconds < 1.5
                ? (result.Bpm, result.Confidence) : null;
        }
    }

    public BpmCaptureSession() => worker = Task.Run(() => RunAsync(lifetime.Token));

    private async Task RunAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                try { await CaptureAsync(token).ConfigureAwait(false); }
                catch (Exception ex) when (!token.IsCancellationRequested)
                {
                    Logger.Warn(ex, "BPM capture unavailable");
                }
                finally { latest = null; }
                await Task.Delay(500, token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private async Task CaptureAsync(CancellationToken token)
    {
        var queue = Channel.CreateBounded<Packet>(new BoundedChannelOptions(8)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.DropOldest
        });
        long sequence = 0;
        int interrupted = 0;
        void Interrupt()
        {
            Interlocked.Exchange(ref interrupted, 1);
            queue.Writer.TryComplete();
        }
        void Changed(object? sender, DefaultDeviceChangedEventArgs args) => Interrupt();
        void PowerChanged(object sender, PowerModeChangedEventArgs args) => Interrupt();
        void SessionChanged(object sender, SessionSwitchEventArgs args) => Interrupt();
        void Receive(object? sender, WaveInEventArgs args)
        {
            if (args.BytesRecorded > 0)
                queue.Writer.TryWrite(new Packet(args.Buffer.AsSpan(0, args.BytesRecorded).ToArray(),
                    ++sequence, Stopwatch.GetTimestamp()));
        }

        var monitor = AudioDeviceMonitor.Instance;
        monitor.DefaultDeviceChanged += Changed;
        try
        {
            SystemEvents.PowerModeChanged += PowerChanged;
            SystemEvents.SessionSwitch += SessionChanged;
            using var device = monitor.GetDefaultRenderDevice();
            if (device == null) return;
            using var input = new SharedLoopbackInput(device);
            input.DataAvailable += Receive;
            input.RecordingStopped += (_, _) => Interrupt();
            input.StartRecording();
            var format = input.WaveFormat;
            var encoding = format.Encoding;
            if (format is WaveFormatExtensible ext)
            {
                if (ext.SubFormat == new Guid("00000003-0000-0010-8000-00aa00389b71")) encoding = WaveFormatEncoding.IeeeFloat;
                if (ext.SubFormat == new Guid("00000001-0000-0010-8000-00aa00389b71")) encoding = WaveFormatEncoding.Pcm;
            }
            bool floating = encoding == WaveFormatEncoding.IeeeFloat;
            var estimator = new TempoEstimator(format.SampleRate);
            long previousSequence = 0, previousTime = 0;
            await foreach (var packet in queue.Reader.ReadAllAsync(token).ConfigureAwait(false))
            {
                if (Volatile.Read(ref interrupted) != 0 || token.IsCancellationRequested) break;
                if (packet.Sequence != previousSequence + 1 ||
                    (previousTime != 0 && Stopwatch.GetElapsedTime(previousTime, packet.Timestamp).TotalSeconds > 1.5))
                    estimator = new TempoEstimator(format.SampleRate);
                previousSequence = packet.Sequence;
                previousTime = packet.Timestamp;
                if (encoding != WaveFormatEncoding.Pcm && !floating) continue;
                PcmFrames.Analyze(packet.Data, format.Channels, format.BitsPerSample, floating, estimator);
                latest = estimator.Bpm is double bpm ? new Reading(bpm, estimator.Confidence, packet.Timestamp) : null;
            }
        }
        finally
        {
            monitor.DefaultDeviceChanged -= Changed;
            SystemEvents.PowerModeChanged -= PowerChanged;
            SystemEvents.SessionSwitch -= SessionChanged;
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        try { await worker.ConfigureAwait(false); }
        finally { lifetime.Dispose(); }
    }
}
