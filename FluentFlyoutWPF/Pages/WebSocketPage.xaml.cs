// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyout.Classes.Settings;
using FluentFlyout.Classes.Utils;
using FluentFlyoutWPF.Classes.OBS.Services;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace FluentFlyoutWPF.Pages;

public partial class WebSocketPage : Page
{
    private readonly WebThemeManager _themeManager = new();
    private bool _updatingMediaSources;
    private bool _updatingThemes;

    public WebSocketPage()
    {
        InitializeComponent();
        DataContext = SettingsManager.Current;
        PopulateMediaSources();
        RefreshThemeList();
        ThemeFolderText.Text = _themeManager.ThemeDirectory;
    }

    private void PopulateMediaSources()
    {
        if (Application.Current.MainWindow is not MainWindow mainWindow)
            return;

        _updatingMediaSources = true;
        try
        {
            MediaSourceComboBox.Items.Clear();
            MediaSourceComboBox.Items.Add(new ComboBoxItem
            {
                Content = "Automatic (follow FluentFlyout)",
                Tag = string.Empty
            });

            foreach (var session in mainWindow.GetSwitchableSessions())
            {
                var sessionId = session.Id ?? string.Empty;
                if (string.IsNullOrWhiteSpace(sessionId))
                    continue;

                var appName = MediaPlayerData.GetAndCacheMediaPlayerData(sessionId).Item1 ?? sessionId;
                MediaSourceComboBox.Items.Add(new ComboBoxItem
                {
                    Content = appName,
                    Tag = sessionId,
                    ToolTip = sessionId
                });
            }

            var selectedId = SettingsManager.Current.ObsPinnedSessionId;
            MediaSourceComboBox.SelectedItem = MediaSourceComboBox.Items
                .OfType<ComboBoxItem>()
                .FirstOrDefault(item => string.Equals(
                    item.Tag as string,
                    selectedId,
                    StringComparison.Ordinal));
            if (MediaSourceComboBox.SelectedIndex < 0)
                MediaSourceComboBox.SelectedIndex = 0;
        }
        finally
        {
            _updatingMediaSources = false;
        }
    }

    private void MediaSourceComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_updatingMediaSources ||
            MediaSourceComboBox.SelectedItem is not ComboBoxItem item ||
            item.Tag is not string sessionId)
            return;

        SettingsManager.Current.ObsPinnedSessionId = sessionId;
        if (Application.Current.MainWindow is MainWindow mainWindow)
            mainWindow.RefreshObsMediaSource();
    }

    private void RefreshThemeList(string? preferredSelection = null)
    {
        _updatingThemes = true;
        try
        {
            var selected = preferredSelection ?? SettingsManager.Current.WebSocketThemeFileName;
            var themes = _themeManager.GetAvailableThemes();

            ThemeComboBox.Items.Clear();
            foreach (var themeFolderName in themes)
            {
                ThemeComboBox.Items.Add(new ComboBoxItem
                {
                    // A folder is the theme; keep the selector label concise.
                    Content = themeFolderName,
                    Tag = themeFolderName,
                    ToolTip = Path.Combine(_themeManager.ThemeDirectory, themeFolderName)
                });
            }

            ThemeComboBox.SelectedItem = ThemeComboBox.Items
                .OfType<ComboBoxItem>()
                .FirstOrDefault(item => string.Equals(
                    item.Tag as string,
                    string.Equals(selected, "default.html", StringComparison.OrdinalIgnoreCase) ? "default" : selected,
                    StringComparison.OrdinalIgnoreCase));

            if (ThemeComboBox.SelectedIndex < 0 && ThemeComboBox.Items.Count > 0)
            {
                ThemeComboBox.SelectedItem = ThemeComboBox.Items
                    .OfType<ComboBoxItem>()
                    .FirstOrDefault(item => string.Equals(
                        item.Tag as string,
                        "default",
                        StringComparison.OrdinalIgnoreCase))
                    ?? ThemeComboBox.Items[0];

                // Normalize selections saved by the previous file-based theme picker.
                SettingsManager.Current.WebSocketThemeFileName =
                    (ThemeComboBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "default";
            }
        }
        finally
        {
            _updatingThemes = false;
        }
    }

    private void ThemeComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_updatingThemes ||
            ThemeComboBox.SelectedItem is not ComboBoxItem item ||
            item.Tag is not string themeFolderName)
            return;

        SettingsManager.Current.WebSocketThemeFileName = themeFolderName;
        if (Application.Current.MainWindow is MainWindow mainWindow)
            mainWindow.RefreshWebSocketTheme();
    }

    private void RefreshThemes_Click(object sender, RoutedEventArgs e)
    {
        RefreshThemeList();
    }

    private void OpenThemeFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            _themeManager.OpenThemeDirectory();
        }
        catch (Exception ex)
        {
            Wpf.Ui.Controls.MessageBox messageBox = new()
            {
                Title = "WebSocket themes",
                Content = $"Unable to open the theme folder: {ex.Message}",
                CloseButtonText = "OK"
            };
            _ = messageBox.ShowDialogAsync();
        }
    }

    private void CopyUrl_Click(object sender, RoutedEventArgs e)
    {
        Clipboard.SetText($"http://127.0.0.1:{SettingsManager.Current.ObsNowPlayingPort}/");
    }
}
