// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyoutWPF.Classes.OBS.Models;
using FluentFlyoutWPF.Classes.OBS.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
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

    private readonly MediaStateStore _stateStore;
    private readonly CoverArtStore _coverArtStore;
    private readonly WebThemeManager _themeManager;
    private readonly Func<string> _selectedThemeFileName;
    private readonly WebSocketHub _hub = new();
    private readonly string _webRoot;
    private readonly string _token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() }
    };

    private WebApplication? _app;
    private bool _started;

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
        _webRoot = Path.Combine(AppContext.BaseDirectory, "Web");
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

        if (!Directory.Exists(_webRoot))
            throw new DirectoryNotFoundException($"OBS web assets were not found: {_webRoot}");

        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            ApplicationName = typeof(ObsWebServer).Assembly.GetName().Name,
            ContentRootPath = AppContext.BaseDirectory,
            WebRootPath = _webRoot
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

            app.UseStaticFiles();
        app.UseWebSockets(new WebSocketOptions
        {
            KeepAliveInterval = TimeSpan.FromSeconds(20)
        });

        app.MapGet("/", () =>
        {
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

        app.MapGet("/api/health", () => Results.Json(new
        {
            status = "ok",
            service = "FluentFlyout OBS Now Playing",
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
            NLog.LogManager.GetCurrentClassLogger().Info(
                "OBS Now Playing server started at {0}", BaseUrl);
        }
        catch
        {
            _stateStore.Changed -= OnMediaStateChanged;
            await app.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        if (_app is null)
            return;

        _stateStore.Changed -= OnMediaStateChanged;
        var app = _app;
        _app = null;
        _started = false;

        await app.StopAsync(cancellationToken).ConfigureAwait(false);
        await app.DisposeAsync().ConfigureAwait(false);

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

    private void OnMediaStateChanged(NowPlayingInfo state)
    {
        var message = JsonSerializer.Serialize(
            CreateEnvelope("media.changed", state),
            _jsonOptions);

        // WebSocketHub serializes writes; failures are handled per client.
        _ = _hub.BroadcastAsync(message);
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
            await _hub.SendAsync(socket, snapshot, context.RequestAborted);

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
