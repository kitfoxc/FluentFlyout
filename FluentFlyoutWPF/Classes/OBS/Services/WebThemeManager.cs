// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.IO;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Discovers user-authored HTML templates in the current user's Roaming profile.
/// Templates are intentionally self-contained HTML files in the first iteration.
/// </summary>
public sealed class WebThemeManager
{
    private readonly string _webRoot;

    public WebThemeManager(string? webRoot = null)
    {
        _webRoot = webRoot ?? Path.Combine(AppContext.BaseDirectory, "Web");
        ThemeDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FluentFlyout",
            "web-theme");

        Directory.CreateDirectory(ThemeDirectory);
        EnsureDefaultTheme();
    }

    public string ThemeDirectory { get; }

    public string DefaultThemeFileName => "default.html";

    public IReadOnlyList<string> GetAvailableThemes()
    {
        EnsureDefaultTheme();

        return Directory.EnumerateFiles(ThemeDirectory, "*.html", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Cast<string>()
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public string ResolveThemePath(string? fileName)
    {
        EnsureDefaultTheme();

        var safeFileName = NormalizeFileName(fileName);
        var candidate = Path.GetFullPath(Path.Combine(ThemeDirectory, safeFileName));
        var root = Path.GetFullPath(ThemeDirectory) + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The selected WebSocket theme path is invalid.");

        if (!File.Exists(candidate))
            candidate = Path.Combine(ThemeDirectory, DefaultThemeFileName);

        return candidate;
    }

    public string ReadTheme(string? fileName)
    {
        var path = ResolveThemePath(fileName);
        return File.ReadAllText(path);
    }

    public void OpenThemeDirectory()
    {
        Directory.CreateDirectory(ThemeDirectory);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = ThemeDirectory,
            UseShellExecute = true
        });
    }

    private static string NormalizeFileName(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
            return "default.html";

        var name = Path.GetFileName(fileName.Trim());
        if (!string.Equals(name, fileName.Trim(), StringComparison.Ordinal) ||
            !name.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
            return "default.html";

        return name;
    }

    private void EnsureDefaultTheme()
    {
        var destination = Path.Combine(ThemeDirectory, DefaultThemeFileName);
        if (File.Exists(destination))
            return;

        var source = Path.Combine(_webRoot, "index.html");
        if (!File.Exists(source))
            throw new FileNotFoundException("The built-in WebSocket HTML template was not found.", source);

        File.Copy(source, destination);
    }
}
