// SPDX-License-Identifier: GPL-3.0-or-later
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace FluentFlyoutWPF.Classes.Audio;

// One lease per consumer. Each running endpoint owns its own MMDevice so that
// releasing the original caller's device cannot invalidate another lease.
internal sealed class SharedLoopbackInput(MMDevice device) : IDisposable
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, Endpoint> Active = new();
    private readonly string deviceId = device.ID;
    private Endpoint? endpoint;
    public WaveFormat WaveFormat { get; private set; } = null!;
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    private sealed class Endpoint : IDisposable
    {
        private readonly MMDevice device;
        internal readonly WasapiLoopbackCapture Capture;
        internal volatile bool Stopped;
        internal int Users;

        internal Endpoint(string id)
        {
            using var enumerator = new MMDeviceEnumerator();
            device = enumerator.GetDevice(id);
            try
            {
                Capture = new WasapiLoopbackCapture(device);
                Capture.RecordingStopped += (_, _) => Stopped = true;
            }
            catch { device.Dispose(); throw; }
        }

        public void Dispose()
        {
            try { Capture.Dispose(); }
            finally { device.Dispose(); }
        }
    }

    public void StartRecording()
    {
        lock (Gate)
        {
            if (endpoint != null) return;
            if (!Active.TryGetValue(deviceId, out var stream) || stream.Stopped)
                Active[deviceId] = stream = new Endpoint(deviceId);
            endpoint = stream;
            stream.Users++;
            try
            {
                WaveFormat = stream.Capture.WaveFormat;
                stream.Capture.DataAvailable += ForwardData;
                stream.Capture.RecordingStopped += ForwardStop;
                if (stream.Users == 1) stream.Capture.StartRecording();
            }
            catch { StopRecording(); throw; }
        }
    }

    private void ForwardData(object? sender, WaveInEventArgs args) => DataAvailable?.Invoke(this, args);
    private void ForwardStop(object? sender, StoppedEventArgs args) => RecordingStopped?.Invoke(this, args);

    public void StopRecording()
    {
        lock (Gate)
        {
            var stream = endpoint;
            if (stream == null) return;
            endpoint = null;
            stream.Capture.DataAvailable -= ForwardData;
            stream.Capture.RecordingStopped -= ForwardStop;
            if (--stream.Users != 0) return;
            if (Active.GetValueOrDefault(deviceId) == stream) Active.Remove(deviceId);
            stream.Dispose();
        }
    }

    public void Dispose() => StopRecording();
}
