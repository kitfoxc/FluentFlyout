// Browser-only rendering helpers. SMTC calibration belongs to SmtcTimelineClock,
// not to a second browser-side playback state machine.
export function clampPosition(position, duration = 0) {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return safeDuration > 0 ? Math.min(safePosition, safeDuration) : safePosition;
}

export function getReportedPosition(media, fallback = 0) {
  if (media?.position === null || media?.position === undefined || media?.position === "")
    return Math.max(0, Number(fallback) || 0);
  const value = Number(media.position);
  return Number.isFinite(value) && value >= 0 ? value : Math.max(0, Number(fallback) || 0);
}

export function getProjectionBudget(media, limitMs = 5000) {
  if (media?.playbackStatus !== "Playing") return 0;
  const value = Number(media?.positionProjectionMs);
  // The additive field is present on the refactored server. Older servers
  // without the field get a bounded best-effort fallback.
  if (media?.positionProjectionMs === null || media?.positionProjectionMs === undefined)
    return limitMs;
  return Number.isFinite(value) ? Math.max(0, Math.min(limitMs, value)) : 0;
}

export function projectBoundedPosition(anchor, now) {
  if (!anchor) return 0;
  const ageMs = Math.min(anchor.budgetMs, Math.max(0, now - anchor.at));
  return clampPosition(anchor.position + ageMs / 1000, anchor.duration);
}

// Server-side correction is authoritative. Ignore only sub-150ms arrival
// jitter, rather than starting another interpolation or calibration machine.
export function reconcilePosition(predicted, reported, duration, deadband = 0.15) {
  const target = clampPosition(reported, duration);
  if (!Number.isFinite(predicted)) return target;
  return Math.abs(target - predicted) < deadband
    ? clampPosition(predicted, duration)
    : target;
}

// The first 2% of a song can be noisy while a source is buffering. A minor
// backwards update there is not a seek; a larger jump still remains visible.
export function filterStartupJitter(predicted, reported, duration) {
  if (duration > 0 && reported / duration < 0.02 &&
      predicted - reported > 0 && predicted - reported < 0.5)
    return predicted;
  return reported;
}
