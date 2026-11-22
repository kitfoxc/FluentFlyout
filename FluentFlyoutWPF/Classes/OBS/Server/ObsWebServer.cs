// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyoutWPF.Classes.OBS.Models;
using FluentFlyoutWPF.Classes.OBS.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Net.WebSockets;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FluentFlyoutWPF.Classes.OBS.Server;

/// <summary>
/// Loopback-only HTTP and WebSocket endpoint for OBS Browser Sources.
/// </summary>
public sealed class ObsWebServer : IAsyncDisposable
{
    public const int DefaultPort = 17832;

    private CancellationTokenSource? _tempoStop;
    private Task? _tempoWorker;
    private readonly MediaStateStore _stateStore;
    private readonly CoverArtStore _coverArtStore;
    private readonly WebThemeManager _themeManager;
    private readonly Func<string> _selectedThemeFileName;
    private readonly WebSocketHub _hub = new();
    private readonly string _browserApiPath;
    private readonly string _token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() }
    };

    private WebApplication? _app;
    private volatile bool _started;
    private readonly object _mediaPushSync = new();
    private NowPlayingInfo? _pendingMediaState;
    private bool _mediaPushScheduled;
    private CancellationTokenSource? _mediaPushCts;
    private static readonly TimeSpan MediaPushInterval = TimeSpan.FromMilliseconds(100);

    public ObsWebServer(
        MediaStateStore stateStore,
        CoverArtStore coverArtStore,
        WebThemeManager themeManager,
        Func<string> selectedThemeFileName,
        int port = DefaultPort)
    {
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _coverArtStore = coverArtStore ?? throw new ArgumentNullException(nameof(coverArtStore));
        _themeManager = themeManager ?? throw new ArgumentNullException(nameof(themeManager));
        _selectedThemeFileName = selectedThemeFileName ?? throw new ArgumentNullException(nameof(selectedThemeFileName));
        if (port is < 1024 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(port));

        Port = port;
        BaseUrl = $"http://127.0.0.1:{Port}";
        _browserApiPath = Path.Combine(AppContext.BaseDirectory, "Web", "js", "fluentflyout-api.js");
    }

    public int Port { get; private set; }

    public string BaseUrl { get; private set; }

    /// <summary>Changes the listening port while the server is stopped.</summary>
    public void ReconfigurePort(int port)
    {
        if (_started)
            throw new InvalidOperationException("Stop the OBS server before changing its port.");
        if (port is < 1024 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(port));

        Port = port;
        BaseUrl = $"http://127.0.0.1:{Port}";
    }

    public bool IsRunning => _started;

    public int ConnectedClients => _hub.ClientCount;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_started)
            return;

        if (!File.Exists(_browserApiPath))
            throw new FileNotFoundException("The bundled OBS browser communication API was not found.", _browserApiPath);

        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            ApplicationName = typeof(ObsWebServer).Assembly.GetName().Name,
            ContentRootPath = AppContext.BaseDirectory
        });

        builder.WebHost.UseUrls(BaseUrl);
        builder.Logging.ClearProviders();

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            if (!IsAllowedOrigin(context))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            await next(context);
        });

        // Serve only the bundled communication adapter from the application.
        // Renderer HTML, CSS and progress JS live in web-theme, never in the app's
        // static file root. This also prevents stale Debug output shadowing edits.
        app.UseWebSockets(new WebSocketOptions
        {
            KeepAliveInterval = TimeSpan.FromSeconds(20)
        });

        app.MapGet("/js/fluentflyout-api.js", () =>
            Results.File(_browserApiPath, "text/javascript; charset=utf-8"));

        app.MapGet("/", (HttpContext context) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var html = _themeManager.ReadTheme(_selectedThemeFileName());
                return Results.Content(html, "text/html; charset=utf-8");
            }
            catch (Exception ex)
            {
                NLog.LogManager.GetCurrentClassLogger().Error(ex, "Failed to load selected WebSocket HTML theme");
                return Results.Problem("The selected WebSocket theme could not be loaded.");
            }
        });

        var themeAssetContentTypes = new FileExtensionContentTypeProvider();
        app.MapGet("/theme-assets/{**assetPath}", (HttpContext context, string assetPath) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var assetPathOnDisk = _themeManager.ResolveThemeAssetPath(
                    assetPath,
                    _selectedThemeFileName());

                if (!themeAssetContentTypes.TryGetContentType(assetPathOnDisk, out var contentType))
                    contentType = "application/octet-stream";

                return Results.File(assetPathOnDisk, contentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound();
            }
            catch (InvalidOperationException)
            {
                return Results.BadRequest();
            }
        });

        // HTML copied by previous builds uses these absolute renderer URLs.
        // Keep the old URLs working, but resolve their bytes from external
        // web-theme/fluent rather than bundling another renderer in the MSIX.
        app.MapGet("/css/fluent.css", (HttpContext context) =>
            ServeLegacyRendererAsset(context, "css/fluent.css", "text/css; charset=utf-8"));
        app.MapGet("/js/app.js", (HttpContext context) =>
            ServeLegacyRendererAsset(context, "js/app.js", "text/javascript; charset=utf-8"));
        app.MapGet("/js/progress-utils.js", (HttpContext context) =>
            ServeLegacyRendererAsset(context, "js/progress-utils.js", "text/javascript; charset=utf-8"));

        app.MapGet("/api/health", () => Results.Json(new
        {
            status = "ok",
            service = "FluentFlyout WebSocket",
            protocol = "1.0",
            clients = _hub.ClientCount
        }));

        // The page obtains its per-process token from this same-origin endpoint.
        app.MapGet("/api/config", () => Results.Json(new
        {
            token = _token,
            protocol = "1.0",
            websocketPath = "/ws"
        }));

        app.MapGet("/api/now-playing", (HttpContext context) =>
        {
            if (!HasValidToken(context))
                return Results.Unauthorized();

            return Results.Json(CreateEnvelope("state.snapshot", _stateStore.Current), _jsonOptions);
        });

        app.MapGet("/api/covers/{coverId}", (HttpContext context, string coverId) =>
        {
            if (!HasValidToken(context))
                return Results.Unauthorized();

            if (!_coverArtStore.TryGet(coverId, out var imageBytes) || imageBytes is null)
                return Results.NotFound();

            return Results.File(imageBytes, "image/png");
        });

        app.Map("/ws", HandleWebSocketAsync);

        _stateStore.Changed += OnMediaStateChanged;

        try
        {
            await app.StartAsync(cancellationToken).ConfigureAwait(false);
            _app = app;
            _started = true;
            _tempoStop = new CancellationTokenSource();
            _tempoWorker = MonitorTempoAsync(_tempoStop.Token);
            NLog.LogManager.GetCurrentClassLogger().Info(
                "WebSocket server started at {0}", BaseUrl);
        }
        catch
        {
            _stateStore.Changed -= OnMediaStateChanged;
            await app.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private IResult ServeLegacyRendererAsset(HttpContext context, string relativePath, string contentType)
    {
        context.Response.Headers.CacheControl = "no-store";
        try
        {
            var assetPath = _themeManager.ResolveThemeAssetPath(
                relativePath, _themeManager.DefaultThemeFolderName);
            return Results.File(assetPath, contentType);
        }
        catch (FileNotFoundException)
        {
            return Results.NotFound();
        }
        catch (InvalidOperationException)
        {
            return Results.BadRequest();
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        if (_app is null)
            return;

        var app = _app;
        _app = null;
        _started = false;
        _stateStore.Changed -= OnMediaStateChanged;

        _tempoStop?.Cancel();
        if (_tempoWorker != null) await _tempoWorker.ConfigureAwait(false);
        _tempoStop?.Dispose();
        _tempoStop = null;
        _tempoWorker = null;

        CancellationTokenSource? pendingFlush;
        lock (_mediaPushSync)
        {
            pendingFlush = _mediaPushCts;
            _mediaPushCts = null;
            _pendingMediaState = null;
            _mediaPushScheduled = false;
        }
        try
        {
            pendingFlush?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The coalescing task may have completed between detaching and cancelling.
        }

        // Close active Browser Source sockets before stopping Kestrel so no
        // per-client sender can remain blocked after the listener is gone.
        _hub.AbortAll();

        try
        {
            await app.StopAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // Dispose even when StopAsync throws; otherwise the old host can
            // retain listeners and make a later restart fail.
            await app.DisposeAsync().ConfigureAwait(false);
        }

        NLog.LogManager.GetCurrentClassLogger().Info("OBS Now Playing server stopped");
    }

    /// <summary>Notifies connected Browser Sources to reload the selected HTML theme.</summary>
    public Task NotifyThemeChangedAsync()
    {
        var message = JsonSerializer.Serialize(new
        {
            protocol = "1.0",
            type = "theme.changed"
        }, _jsonOptions);

        return _hub.BroadcastAsync(message);
    }

    private async Task MonitorTempoAsync(CancellationToken token)
    {
        FluentFlyoutWPF.Classes.Audio.BpmCaptureSession? session = null;
        long generation = -1;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
        try
        {
            while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
            {
                var context = _stateStore.ReadTempoContext();
                bool active = ConnectedClients > 0 && context.State.IsAvailable &&
                    context.State.PlaybackStatus == NowPlayingPlaybackStatus.Playing;
                if (session != null && (!active || generation != context.Generation))
                {
                    await session.DisposeAsync().ConfigureAwait(false);
                    session = null;
                }
                generation = context.Generation;
                if (active) session ??= new FluentFlyoutWPF.Classes.Audio.BpmCaptureSession();
                var reading = session?.Current;
                _stateStore.SetTempo(generation, reading.HasValue ? Math.Round(reading.Value.Bpm) : null);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            if (session != null) await session.DisposeAsync().ConfigureAwait(false);
            _stateStore.SetTempo(generation, null);
        }
    }

    private void OnMediaStateChanged(NowPlayingInfo state)
    {
        // Timeline callbacks can arrive in bursts. Keep only the newest state
        // during the short coalescing window so OBS never receives a backlog
        // of obsolete positions.
        CancellationTokenSource? flushCts = null;
        lock (_mediaPushSync)
        {
            _pendingMediaState = _stateStore.Current;
            if (!_mediaPushScheduled)
            {
                _mediaPushScheduled = true;
                flushCts = new CancellationTokenSource();
                _mediaPushCts = flushCts;
            }
        }

        if (flushCts is not null)
            _ = FlushPendingMediaStateAsync(flushCts);
    }

    private async Task FlushPendingMediaStateAsync(CancellationTokenSource flushCts)
    {
        try
        {
            await Task.Delay(MediaPushInterval, flushCts.Token).ConfigureAwait(false);

            NowPlayingInfo? latestState;
            lock (_mediaPushSync)
            {
                if (!ReferenceEquals(_mediaPushCts, flushCts))
                    return;

                latestState = _pendingMediaState;
                _pendingMediaState = null;
                _mediaPushScheduled = false;
                _mediaPushCts = null;
            }

            if (latestState is null || !_started)
                return;

            var message = JsonSerializer.Serialize(
                CreateEnvelope("media.changed", latestState),
                _jsonOptions);

            _hub.BroadcastLatestMedia(message);
        }
        catch (OperationCanceledException)
        {
            // Expected when the server stops or is reconfigured.
        }
        catch (Exception ex)
        {
            NLog.LogManager.GetCurrentClassLogger()
                .Error(ex, "Failed to publish coalesced OBS media state");
        }
        finally
        {
            lock (_mediaPushSync)
            {
                if (ReferenceEquals(_mediaPushCts, flushCts))
                {
                    _mediaPushCts = null;
                    _pendingMediaState = null;
                    _mediaPushScheduled = false;
                }
            }
            flushCts.Dispose();
        }
    }

    private object CreateEnvelope(string type, NowPlayingInfo state)
    {
        return new
        {
            protocol = "1.0",
            type,
            sequence = state.Sequence,
            timestamp = state.UpdatedAt,
            data = state
        };
    }

    private bool IsAllowedOrigin(HttpContext context)
    {
        var origin = context.Request.Headers["Origin"].ToString();
        if (string.IsNullOrWhiteSpace(origin))
            return true; // Non-browser local clients still require the token on data routes.

        return Uri.TryCreate(origin, UriKind.Absolute, out var uri)
            && (uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            && uri.Port == Port
            && uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase);
    }

    private bool HasValidToken(HttpContext context)
    {
        var supplied = context.Request.Query["token"].ToString();
        if (string.IsNullOrEmpty(supplied))
            supplied = context.Request.Headers["Authorization"].ToString()
                .Replace("Bearer ", "", StringComparison.OrdinalIgnoreCase);

        return !string.IsNullOrEmpty(supplied)
            && CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(supplied),
                System.Text.Encoding.UTF8.GetBytes(_token));
    }

    private async Task HandleWebSocketAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        if (!HasValidToken(context))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = _hub.Add(socket);

        try
        {
            // Send a complete snapshot immediately so a newly loaded OBS source
            // does not have to wait for the next SMTC event.
            var snapshot = JsonSerializer.Serialize(
                CreateEnvelope("state.snapshot", _stateStore.Current),
                _jsonOptions);
            _hub.SendLatestMedia(clientId, snapshot);

            var buffer = new byte[1024];
            while (socket.State == WebSocketState.Open &&
                   !context.RequestAborted.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(
                    new ArraySegment<byte>(buffer),
                    context.RequestAborted);

                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                // This endpoint is intentionally read-only in MVP. Ignore all
                // client text/binary messages; playback commands are not exposed.
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when OBS closes or reloads its Browser Source.
        }
        catch (WebSocketException)
        {
            // Expected for abrupt browser disconnects.
        }
        finally
        {
            _hub.Remove(clientId);
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await socket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "Browser Source disconnected",
                        CancellationToken.None);
                }
                catch
                {
                    socket.Abort();
                }
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
    }
}
