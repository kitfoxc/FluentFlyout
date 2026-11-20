using System.Net.WebSockets;
using FluentFlyoutWPF.Classes.OBS.Models;
using FluentFlyoutWPF.Classes.OBS.Server;
using FluentFlyoutWPF.Classes.OBS.Services;
using Xunit;

namespace FluentFlyoutWPF.Tests;

public sealed class ObsCoreTests
{
    [Fact]
    public void MediaStateStore_AssignsMonotonicSequenceNumbers()
    {
        var store = new MediaStateStore();

        var first = store.Publish(new NowPlayingInfo
        {
            IsAvailable = true,
            Title = "First"
        });
        var second = store.Publish(new NowPlayingInfo
        {
            IsAvailable = true,
            Title = "Second"
        });

        Assert.Equal(1, first.Sequence);
        Assert.Equal(2, second.Sequence);
        Assert.Equal("Second", store.Current.Title);
        Assert.Equal(second.Sequence, store.Current.Sequence);
    }

    [Fact]
    public void MediaSessionSelector_PrefersPinnedThenFocusedSession()
    {
        var first = new FakeSession("first");
        var second = new FakeSession("second");
        var selector = new MediaSessionSelector();
        var sessions = new[] { first, second };

        Assert.Same(first, selector.Select(
            sessions,
            second,
            "first",
            session => session.Id));

        Assert.Same(second, selector.Select(
            sessions,
            second,
            "missing",
            session => session.Id));
    }

    [Fact]
    public async Task WebSocketHub_AbortAllRemovesAndAbortsEveryClient()
    {
        var hub = new WebSocketHub();
        var socket = new BlockingWebSocket();
        hub.Add(socket);

        hub.BroadcastLatestMedia("snapshot");
        await socket.SendStarted.WaitAsync(TimeSpan.FromSeconds(2));

        hub.AbortAll();

        Assert.Equal(0, hub.ClientCount);
        Assert.Equal(WebSocketState.Aborted, socket.State);
    }

    [Fact]
    public async Task WebSocketHub_DropsClientWhenControlQueueExceedsBound()
    {
        var hub = new WebSocketHub();
        var socket = new BlockingWebSocket();
        hub.Add(socket);

        await hub.BroadcastAsync("in-flight");
        await socket.SendStarted.WaitAsync(TimeSpan.FromSeconds(2));

        // One message is in flight. More than the 32-message pending control
        // limit must evict the slow client instead of growing the queue forever.
        for (var index = 0; index < 34; index++)
            await hub.BroadcastAsync($"control-{index}");

        Assert.Equal(0, hub.ClientCount);
        Assert.Equal(WebSocketState.Aborted, socket.State);
    }

    private sealed record FakeSession(string Id);

    private sealed class BlockingWebSocket : WebSocket
    {
        private readonly TaskCompletionSource _sendCompletion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _sendStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        private WebSocketState _state = WebSocketState.Open;
        public override WebSocketState State => _state;
        public override string? SubProtocol => null;
        public Task SendStarted => _sendStarted.Task;

        public override void Abort()
        {
            _state = WebSocketState.Aborted;
            _sendCompletion.TrySetCanceled();
        }

        public override Task CloseAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken)
        {
            _state = WebSocketState.Closed;
            _sendCompletion.TrySetResult();
            return Task.CompletedTask;
        }

        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken)
        {
            _state = WebSocketState.CloseSent;
            return Task.CompletedTask;
        }

        public override void Dispose()
        {
            Abort();
        }

        public override Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken cancellationToken)
        {
            return Task.FromResult(new WebSocketReceiveResult(
                0,
                WebSocketMessageType.Close,
                true));
        }

        public override Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken)
        {
            _sendStarted.TrySetResult();
            cancellationToken.Register(() => _sendCompletion.TrySetCanceled(cancellationToken));
            return _sendCompletion.Task;
        }
    }
}
