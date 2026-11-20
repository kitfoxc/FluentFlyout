// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

using FluentFlyout.Classes.Settings;
using FluentFlyoutWPF.Classes.OBS.Services;
using System.IO;
using System.Windows;
using System.Windows.Controls;

namespace FluentFlyoutWPF.Pages;

public partial class WebSocketPage : Page
{
    private readonly WebThemeManager _themeManager = new();
    private bool _updatingThemes;

    public WebSocketPage()
    {
        InitializeComponent();
        DataContext = SettingsManager.Current;
        ThemeFolderText.Text = _themeManager.ThemeDirectory;
        RefreshThemeList();
    }

    private void RefreshThemeList()
    {
        _updatingThemes = true;
        try
        {
            var selected = SettingsManager.Current.WebSocketThemeFileName;
            var themes = _themeManager.GetAvailableThemes();

            ThemeComboBox.Items.Clear();
            foreach (var theme in themes)
            {
                ThemeComboBox.Items.Add(new ComboBoxItem
                {
                    Content = theme,
                    Tag = theme,
                    ToolTip = Path.Combine(_themeManager.ThemeDirectory, theme)
                });
            }

            ThemeComboBox.SelectedItem = ThemeComboBox.Items
                .OfType<ComboBoxItem>()
                .FirstOrDefault(item => string.Equals(
                    item.Tag as string,
                    selected,
                    StringComparison.OrdinalIgnoreCase));

            if (ThemeComboBox.SelectedIndex < 0 && ThemeComboBox.Items.Count > 0)
            {
                ThemeComboBox.SelectedItem = ThemeComboBox.Items
                    .OfType<ComboBoxItem>()
                    .FirstOrDefault(item => string.Equals(
                        item.Tag as string,
                        _themeManager.DefaultThemeFolderName,
                        StringComparison.OrdinalIgnoreCase))
                    ?? ThemeComboBox.Items[0];

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
            var messageBox = new Wpf.Ui.Controls.MessageBox
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
