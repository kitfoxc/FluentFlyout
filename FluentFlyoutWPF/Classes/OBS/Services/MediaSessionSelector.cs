// Copyright (c) 2024-2026 The FluentFlyout Authors
// SPDX-License-Identifier: GPL-3.0-or-later

namespace FluentFlyoutWPF.Classes.OBS.Services;

/// <summary>
/// Selects a media session without depending on the SMTC implementation.
/// The caller supplies the existing FluentFlyout filtering rules and the
/// focused session, allowing the selector to be unit-tested independently.
/// </summary>
public sealed class MediaSessionSelector
{
    public TSession? Select<TSession>(
        IEnumerable<TSession> sessions,
        TSession? focusedSession,
        string? pinnedSessionId,
        Func<TSession, string?> getSessionId,
        Func<TSession, bool>? isAllowed = null)
        where TSession : class
    {
        ArgumentNullException.ThrowIfNull(sessions);
        ArgumentNullException.ThrowIfNull(getSessionId);

        var validSessions = sessions
            .Where(session => session is not null)
            .Where(session => isAllowed?.Invoke(session) ?? true)
            .ToList();

        if (validSessions.Count == 0)
            return null;

        if (!string.IsNullOrWhiteSpace(pinnedSessionId))
        {
            var pinned = validSessions.FirstOrDefault(session =>
                string.Equals(
                    getSessionId(session),
                    pinnedSessionId,
                    StringComparison.Ordinal));

            if (pinned is not null)
                return pinned;
        }

        if (focusedSession is not null &&
            validSessions.Any(session => ReferenceEquals(session, focusedSession)))
        {
            return focusedSession;
        }

        // Preserve FluentFlyout's current fallback behavior.
        return validSessions[0];
    }
}