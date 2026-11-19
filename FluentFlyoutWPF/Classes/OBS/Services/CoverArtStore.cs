// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Collections.Concurrent;
using System.IO;
using System.Windows.Media.Imaging;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Small bounded in-memory PNG cache for album artwork exposed to local
/// Browser Sources. Images are encoded once per SMTC thumbnail cache key.
/// </summary>
public sealed class CoverArtStore
{
    private const int MaximumEntries = 16;
    private readonly ConcurrentDictionary<string, byte[]> _covers = new();
    private readonly ConcurrentQueue<string> _insertionOrder = new();

    public string? Store(string cacheKey, BitmapSource? image)
    {
        if (string.IsNullOrWhiteSpace(cacheKey) || image is null)
            return null;

        if (_covers.ContainsKey(cacheKey))
            return cacheKey;

        try
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));

            using var stream = new MemoryStream();
            encoder.Save(stream);

            if (stream.Length == 0)
                return null;

            _covers[cacheKey] = stream.ToArray();
            _insertionOrder.Enqueue(cacheKey);

            while (_covers.Count > MaximumEntries && _insertionOrder.TryDequeue(out var oldest))
                _covers.TryRemove(oldest, out _);

            return cacheKey;
        }
        catch (Exception ex)
        {
            NLog.LogManager.GetCurrentClassLogger()
                .Warn(ex, "Failed to encode SMTC album artwork for OBS");
            return null;
        }
    }

    public bool TryGet(string coverId, out byte[]? imageBytes)
    {
        if (string.IsNullOrWhiteSpace(coverId))
        {
            imageBytes = null;
            return false;
        }

        return _covers.TryGetValue(coverId, out imageBytes);
    }
}
