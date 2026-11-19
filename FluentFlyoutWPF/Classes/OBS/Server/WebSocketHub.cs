// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

namespace FluentFlyoutWPF.Classes.OBS.Server;

/// <summary>
/// Owns connected Browser Source sockets and serializes outbound sends.
/// </summary>
public sealed class WebSocketHub
{
    private readonly ConcurrentDictionary<Guid, WebSocket> _clients = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    public int ClientCount => _clients.Count;

    public Guid Add(WebSocket socket)
    {
        var id = Guid.NewGuid();
        _clients.TryAdd(id, socket);
        return id;
    }

    public void Remove(Guid id)
    {
        _clients.TryRemove(id, out _);
    }

    public async Task SendAsync(WebSocket socket, string message, CancellationToken cancellationToken = default)
    {
        if (socket.State != WebSocketState.Open)
            return;

        var bytes = Encoding.UTF8.GetBytes(message);
        await _sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    cancellationToken).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async Task BroadcastAsync(string message, CancellationToken cancellationToken = default)
    {
        foreach (var client in _clients.ToArray())
        {
            try
            {
                await SendAsync(client.Value, message, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Remove(client.Key);
                try
                {
                    client.Value.Abort();
                }
                catch
                {
                    // Ignore socket cleanup failures.
                }
            }
        }
    }
}
