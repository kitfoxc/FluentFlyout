// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

namespace FluentFlyoutWPF.Classes.OBS.Server;

/// <summary>
/// Owns connected Browser Source sockets. Media snapshots use latest-value
/// delivery so slow clients never accumulate stale playback-position frames.
/// Control messages (such as theme.changed) retain FIFO delivery.
/// </summary>
public sealed class WebSocketHub
{
    private readonly ConcurrentDictionary<Guid, ClientConnection> _clients = new();

    public int ClientCount => _clients.Count;

    public Guid Add(WebSocket socket)
    {
        ArgumentNullException.ThrowIfNull(socket);

        var id = Guid.NewGuid();
        var connection = new ClientConnection(socket, () => RemoveFailedClient(id));
        _clients.TryAdd(id, connection);
        return id;
    }

    public void Remove(Guid id)
    {
        _clients.TryRemove(id, out _);
    }

    /// <summary>Queues a reliable control message for every connected client.</summary>
    public Task BroadcastAsync(string message, CancellationToken cancellationToken = default)
    {
        foreach (var client in _clients.Values)
            client.EnqueueControl(message);

        return Task.CompletedTask;
    }

    /// <summary>
    /// Queues a replaceable media snapshot. If a client is busy sending, only
    /// the newest pending snapshot is retained.
    /// </summary>
    public void BroadcastLatestMedia(string message)
    {
        foreach (var client in _clients.Values)
            client.EnqueueLatestMedia(message);
    }

    /// <summary>Queues the initial state snapshot for a newly connected client.</summary>
    public void SendLatestMedia(Guid clientId, string message)
    {
        if (_clients.TryGetValue(clientId, out var client))
            client.EnqueueLatestMedia(message);
    }

    private void RemoveFailedClient(Guid id)
    {
        if (_clients.TryRemove(id, out var client))
        {
            try
            {
                client.Abort();
            }
            catch
            {
                // Ignore socket cleanup failures.
            }
        }
    }

    private sealed class ClientConnection
    {
        private readonly WebSocket _socket;
        private readonly Action _onFailure;
        private readonly object _sync = new();
        private readonly Queue<string> _controlMessages = new();
        private string? _latestMediaMessage;
        private bool _sending;

        public ClientConnection(WebSocket socket, Action onFailure)
        {
            _socket = socket;
            _onFailure = onFailure;
        }

        public void EnqueueControl(string message)
        {
            var startSender = false;
            lock (_sync)
            {
                _controlMessages.Enqueue(message);
                if (!_sending)
                {
                    _sending = true;
                    startSender = true;
                }
            }

            if (startSender)
                _ = ProcessQueueAsync();
        }

        public void EnqueueLatestMedia(string message)
        {
            var startSender = false;
            lock (_sync)
            {
                // Replace pending media state rather than queueing every
                // intermediate timeline event.
                _latestMediaMessage = message;
                if (!_sending)
                {
                    _sending = true;
                    startSender = true;
                }
            }

            if (startSender)
                _ = ProcessQueueAsync();
        }

        public void Abort() => _socket.Abort();

        private async Task ProcessQueueAsync()
        {
            while (true)
            {
                string message;
                lock (_sync)
                {
                    if (_controlMessages.Count > 0)
                    {
                        message = _controlMessages.Dequeue();
                    }
                    else if (_latestMediaMessage is not null)
                    {
                        message = _latestMediaMessage;
                        _latestMediaMessage = null;
                    }
                    else
                    {
                        _sending = false;
                        return;
                    }
                }

                try
                {
                    if (_socket.State != WebSocketState.Open)
                    {
                        _onFailure();
                        return;
                    }

                    var bytes = Encoding.UTF8.GetBytes(message);
                    await _socket.SendAsync(
                        new ArraySegment<byte>(bytes),
                        WebSocketMessageType.Text,
                        endOfMessage: true,
                        CancellationToken.None).ConfigureAwait(false);
                }
                catch
                {
                    _onFailure();
                    return;
                }
            }
        }
    }
}
