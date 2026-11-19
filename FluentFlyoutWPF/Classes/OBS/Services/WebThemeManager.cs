// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.IO;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Discovers HTML themes in the user's Roaming profile. Each immediate
/// subfolder is a theme category and may contain one or more HTML templates.
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

    /// <summary>
    /// Returns paths relative to ThemeDirectory, using forward slashes so the
    /// persisted selection is portable and independent of the current OS.
    /// </summary>
    public IReadOnlyList<string> GetAvailableThemes()
    {
        EnsureDefaultTheme();

        return Directory.EnumerateFiles(ThemeDirectory, "*.html", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(ThemeDirectory, path).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public string ResolveThemePath(string? relativeFileName)
    {
        EnsureDefaultTheme();

        var candidate = ResolveSafePath(relativeFileName);
        if (!candidate.EndsWith(".html", StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate))
            return Path.Combine(ThemeDirectory, DefaultThemeFileName);

        return candidate;
    }

    /// <summary>Returns the folder containing the selected HTML file.</summary>
    public string ResolveThemeAssetPath(string? relativeAssetPath, string? selectedThemeFileName)
    {
        var themePath = ResolveThemePath(selectedThemeFileName);
        var themeFolder = Path.GetDirectoryName(themePath) ?? ThemeDirectory;
        var normalizedAssetPath = (relativeAssetPath ?? string.Empty)
            .Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);

        var candidate = Path.GetFullPath(Path.Combine(themeFolder, normalizedAssetPath));
        var folderPrefix = Path.GetFullPath(themeFolder) + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(folderPrefix, StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(candidate))
            throw new FileNotFoundException("The requested theme asset was not found.");

        return candidate;
    }

    public string ReadTheme(string? relativeFileName)
    {
        var themePath = ResolveThemePath(relativeFileName);
        var html = File.ReadAllText(themePath);

        // Resolve relative CSS, JS and image references against the selected
        // theme's folder, served through the guarded /theme-assets/ endpoint.
        const string baseTag = "<base href=\"/theme-assets/\">";
        if (html.Contains("<head", StringComparison.OrdinalIgnoreCase))
        {
            var headEnd = html.IndexOf('>', html.IndexOf("<head", StringComparison.OrdinalIgnoreCase));
            if (headEnd >= 0)
                return html.Insert(headEnd + 1, baseTag);
        }

        return baseTag + html;
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

    private string ResolveSafePath(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
            relativePath = DefaultThemeFileName;

        var normalized = relativePath.Trim()
            .Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);

        if (Path.IsPathRooted(normalized))
            throw new InvalidOperationException("The selected WebSocket theme path is invalid.");

        var root = Path.GetFullPath(ThemeDirectory);
        var candidate = Path.GetFullPath(Path.Combine(root, normalized));
        var prefix = root + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The selected WebSocket theme path is invalid.");

        return candidate;
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
