// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using System.IO;

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Treats each immediate child directory of web-theme as one selectable theme.
/// A theme folder contains one entry HTML file (index.html preferred) and any
/// supporting assets. Nested folders are not scanned.
/// </summary>
public sealed class WebThemeManager
{
    // Optional fixture source for tests. Production defaults are embedded at build time
    // and expanded once into the user's writable web-theme/fluent directory.
    private readonly string? _sourceWebRoot;

    private static readonly (string FilePath, string ResourceName)[] DefaultRendererFiles =
    [
        ("index.html", "FluentFlyoutWPF.Web.Renderer.index.html"),
        ("css/fluent.css", "FluentFlyoutWPF.Web.Renderer.css.fluent.css"),
        ("js/app.js", "FluentFlyoutWPF.Web.Renderer.js.app.js"),
        ("js/progress-utils.js", "FluentFlyoutWPF.Web.Renderer.js.progress-utils.js")
    ];

    public WebThemeManager(string? webRoot = null, string? themeDirectory = null)
    {
        _sourceWebRoot = webRoot;
        ThemeDirectory = themeDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FluentFlyout",
            "web-theme");

        Directory.CreateDirectory(ThemeDirectory);
        ThrowIfReparsePoint(ThemeDirectory);
        EnsureDefaultTheme();
    }

    public string ThemeDirectory { get; }

    public const string DefaultThemeFolderName = "fluent";

    internal static bool IsLegacyDefaultTheme(string? name) =>
        string.Equals(name?.Trim(), "default", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name?.Trim(), "default.html", StringComparison.OrdinalIgnoreCase);

    /// <summary>Returns only immediate, ordinary theme directories.</summary>
    public IReadOnlyList<string> GetAvailableThemes()
    {
        EnsureDefaultTheme();

        return Directory.EnumerateDirectories(ThemeDirectory, "*", SearchOption.TopDirectoryOnly)
            .Where(directory => !IsReparsePoint(directory))
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrWhiteSpace(name) && !IsLegacyDefaultTheme(name))
            .Cast<string>()
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    /// <summary>Resolves the selected folder's entry HTML file.</summary>
    public string ResolveThemePath(string? themeFolderName)
    {
        var folder = ResolveThemeFolder(themeFolderName);
        var indexPath = Path.Combine(folder, "index.html");
        if (File.Exists(indexPath))
        {
            EnsureNoReparsePoints(folder, indexPath);
            return indexPath;
        }

        var defaultPath = Path.Combine(folder, "default.html");
        if (File.Exists(defaultPath))
        {
            EnsureNoReparsePoints(folder, defaultPath);
            return defaultPath;
        }

        // Keep the MVP simple: only inspect HTML files directly in this folder.
        var firstHtml = Directory.EnumerateFiles(folder, "*.html", SearchOption.TopDirectoryOnly)
            .OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();

        if (firstHtml is not null)
        {
            EnsureNoReparsePoints(folder, firstHtml);
            return firstHtml;
        }

        return Path.Combine(ResolveThemeFolder(DefaultThemeFolderName), "index.html");
    }

    /// <summary>Resolves an asset strictly within the selected theme folder.</summary>
    public string ResolveThemeAssetPath(string? relativeAssetPath, string? themeFolderName)
    {
        var themeFolder = ResolveThemeFolder(themeFolderName);
        var normalizedAssetPath = (relativeAssetPath ?? string.Empty)
            .Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);

        if (Path.IsPathRooted(normalizedAssetPath))
            throw new InvalidOperationException("The requested theme asset path is invalid.");

        var candidate = Path.GetFullPath(Path.Combine(themeFolder, normalizedAssetPath));
        var folderPrefix = Path.GetFullPath(themeFolder) + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(folderPrefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The requested theme asset path is invalid.");

        EnsureNoReparsePoints(themeFolder, candidate);

        if (!File.Exists(candidate))
            throw new FileNotFoundException("The requested theme asset was not found.");

        return candidate;
    }

    public string ReadTheme(string? themeFolderName)
    {
        var themePath = ResolveThemePath(themeFolderName);
        var html = File.ReadAllText(themePath);

        // Resolve relative CSS, JS and image references from the selected theme folder.
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
        ThrowIfReparsePoint(ThemeDirectory);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = ThemeDirectory,
            UseShellExecute = true
        });
    }

    private string ResolveThemeFolder(string? folderName)
    {
        EnsureDefaultTheme();

        // Resolve saved names from both generations of the default theme.
        if (IsLegacyDefaultTheme(folderName) ||
            string.IsNullOrWhiteSpace(folderName))
            folderName = DefaultThemeFolderName;

        var name = folderName.Trim();
        if (name is "." or ".." ||
            name.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar, ':']) >= 0)
            throw new InvalidOperationException("The selected WebSocket theme folder is invalid.");

        var root = Path.GetFullPath(ThemeDirectory);
        ThrowIfReparsePoint(root);
        var candidate = Path.GetFullPath(Path.Combine(root, name));
        var prefix = root + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            !Directory.Exists(candidate))
            candidate = Path.Combine(root, DefaultThemeFolderName);

        ThrowIfReparsePoint(candidate);
        return candidate;
    }

    private void EnsureDefaultTheme()
    {
        Directory.CreateDirectory(ThemeDirectory);
        ThrowIfReparsePoint(ThemeDirectory);

        var defaultFolder = Path.Combine(ThemeDirectory, DefaultThemeFolderName);
        Directory.CreateDirectory(defaultFolder);
        ThrowIfReparsePoint(defaultFolder);

        foreach (var (relativePath, resourceName) in DefaultRendererFiles)
        {
            var destination = Path.Combine(defaultFolder,
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            var parent = Path.GetDirectoryName(destination)!;
            Directory.CreateDirectory(parent);
            EnsureNoReparsePoints(defaultFolder, parent);

            if (File.Exists(destination))
            {
                EnsureNoReparsePoints(defaultFolder, destination);
                continue;
            }

            // Never overwrite user changes. Official defaults are a first-run
            // seed, not a synchronized or automatically upgraded resource set.
            var source = _sourceWebRoot is null
                ? null
                : Path.Combine(_sourceWebRoot,
                    relativePath.Replace('/', Path.DirectorySeparatorChar));

            if (source is not null && File.Exists(source))
            {
                File.Copy(source, destination);
                continue;
            }

            using var embedded = typeof(WebThemeManager).Assembly
                .GetManifestResourceStream(resourceName)
                ?? throw new FileNotFoundException(
                    $"Built-in OBS renderer resource was not found: {resourceName}");
            using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write);
            embedded.CopyTo(output);
        }
    }

    private static bool IsReparsePoint(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (FileNotFoundException)
        {
            return false;
        }
        catch (DirectoryNotFoundException)
        {
            return false;
        }
    }

    private static void ThrowIfReparsePoint(string path)
    {
        if (IsReparsePoint(path))
            throw new InvalidOperationException("WebSocket theme paths cannot contain symbolic links or junctions.");
    }

    /// <summary>
    /// Checks every existing component between the trusted theme root and a
    /// requested file. A lexical GetFullPath prefix check alone does not stop
    /// NTFS junctions or symbolic links from redirecting access outside the root.
    /// </summary>
    private static void EnsureNoReparsePoints(string root, string target)
    {
        ThrowIfReparsePoint(root);

        var relative = Path.GetRelativePath(root, target);
        var current = root;
        foreach (var segment in relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            if (!File.Exists(current) && !Directory.Exists(current))
                break;

            ThrowIfReparsePoint(current);
        }
    }
}
