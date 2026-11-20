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

    [Fact]
    public void WebThemeManager_RejectsTraversalAndDoesNotFollowThemeLinks()
    {
        var root = Path.Combine(Path.GetTempPath(), "FluentFlyout.Tests", Guid.NewGuid().ToString("N"));
        var webRoot = Path.Combine(root, "web");
        var themeRoot = Path.Combine(root, "themes");
        var externalRoot = Path.Combine(root, "external");

        Directory.CreateDirectory(webRoot);
        Directory.CreateDirectory(externalRoot);
        File.WriteAllText(Path.Combine(webRoot, "index.html"), "<html>default</html>");
        File.WriteAllText(Path.Combine(externalRoot, "secret.txt"), "outside");
        var manager = new WebThemeManager(webRoot, themeRoot);

        try
        {
            Directory.CreateDirectory(Path.Combine(themeRoot, "Minimal"));
            File.WriteAllText(Path.Combine(themeRoot, "Minimal", "index.html"), "<html>minimal</html>");

            Assert.Throws<InvalidOperationException>(() =>
                manager.ResolveThemeAssetPath("../external/secret.txt", "Minimal"));

            var linkedTheme = Path.Combine(themeRoot, "Escape");
            try
            {
                Directory.CreateSymbolicLink(linkedTheme, externalRoot);
                Assert.DoesNotContain("Escape", manager.GetAvailableThemes());
                Assert.Throws<InvalidOperationException>(() =>
                    manager.ResolveThemeAssetPath("secret.txt", "Escape"));
            }
            catch (Exception ex) when (
                ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
            {
                // Some Windows environments do not grant symlink creation to the
                // test process. Lexical traversal rejection is still asserted.
            }

            var linkedEntryFolder = Path.Combine(themeRoot, "LinkedEntry");
            Directory.CreateDirectory(linkedEntryFolder);
            try
            {
                File.CreateSymbolicLink(
                    Path.Combine(linkedEntryFolder, "index.html"),
                    Path.Combine(externalRoot, "secret.txt"));
                Assert.Throws<InvalidOperationException>(() =>
                    manager.ResolveThemePath("LinkedEntry"));
            }
            catch (Exception ex) when (
                ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
            {
                // See the symlink privilege note above.
            }
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void WebThemeManager_SeedsCompleteRendererAndPreservesExistingCustomizations()
    {
        var root = Path.Combine(Path.GetTempPath(), "FluentFlyout.Tests", Guid.NewGuid().ToString("N"));
        var themeRoot = Path.Combine(root, "themes");
        var defaultFolder = Path.Combine(themeRoot, "default");

        try
        {
            var manager = new WebThemeManager(themeDirectory: themeRoot);
            var index = Path.Combine(defaultFolder, "index.html");
            var css = Path.Combine(defaultFolder, "css", "fluent.css");
            var app = Path.Combine(defaultFolder, "js", "app.js");
            var helpers = Path.Combine(defaultFolder, "js", "progress-utils.js");

            Assert.True(File.Exists(index));
            Assert.True(File.Exists(css));
            Assert.True(File.Exists(app));
            Assert.True(File.Exists(helpers));
            Assert.Contains("href=\"css/fluent.css\"", File.ReadAllText(index));
            Assert.Contains("src=\"js/app.js\"", File.ReadAllText(index));
            Assert.Contains("/js/fluentflyout-api.js", File.ReadAllText(index));
            Assert.Equal(app, manager.ResolveThemeAssetPath("js/app.js", "default"));

            // A user edit is authoritative; a second start must not silently
            // overwrite it. Missing individual assets may be restored.
            File.WriteAllText(css, "/* user customization */");
            File.Delete(helpers);
            _ = new WebThemeManager(themeDirectory: themeRoot);

            Assert.Equal("/* user customization */", File.ReadAllText(css));
            Assert.True(File.Exists(helpers));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void WebThemeManager_UpgradesHtmlOnlyDefaultWithoutOverwritingItsEntry()
    {
        var root = Path.Combine(Path.GetTempPath(), "FluentFlyout.Tests", Guid.NewGuid().ToString("N"));
        var themeRoot = Path.Combine(root, "themes");
        var defaultFolder = Path.Combine(themeRoot, "default");

        try
        {
            Directory.CreateDirectory(defaultFolder);
            const string legacyHtml = "<html><head><link href=\"/css/fluent.css\"></head><body><script src=\"/js/app.js\"></script></body></html>";
            File.WriteAllText(Path.Combine(defaultFolder, "index.html"), legacyHtml);

            var manager = new WebThemeManager(themeDirectory: themeRoot);

            Assert.Equal(legacyHtml, File.ReadAllText(Path.Combine(defaultFolder, "index.html")));
            Assert.True(File.Exists(manager.ResolveThemeAssetPath("css/fluent.css", "default")));
            Assert.True(File.Exists(manager.ResolveThemeAssetPath("js/app.js", "default")));
            Assert.True(File.Exists(manager.ResolveThemeAssetPath("js/progress-utils.js", "default")));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
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
