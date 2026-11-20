// Pure progress helpers shared by the built-in Browser Source renderer.
// The playhead is extrapolated from the SMTC timeline timestamp, matching the
// original FluentFlyout seek-bar model. UpdatedAt is a fallback anchor for
// providers that omit or leave LastUpdatedTime at its sentinel value.

export function getReportedPosition(media, fallback = 0) {
  const rawPosition = media?.position;
  if (rawPosition === null || rawPosition === undefined || rawPosition === "")
    return Math.max(0, Number(fallback) || 0);

  const position = Number(rawPosition);
  return Number.isFinite(position) && position >= 0
    ? position
    : Math.max(0, Number(fallback) || 0);
}

function parseAnchorTimestamp(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1))
    return null;
  if (timestamp - now > 1000)
    return null;
  return timestamp;
}

export function clampPosition(position, duration = 0) {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  const safeDuration = Number(duration);
  return Number.isFinite(safeDuration) && safeDuration > 0
    ? Math.min(safeDuration, safePosition)
    : safePosition;
}

export function getTimelinePosition(media, now = Date.now()) {
  const reportedPosition = getReportedPosition(media);
  const timestamp = parseAnchorTimestamp(media?.timelineLastUpdatedTime, now)
    ?? parseAnchorTimestamp(media?.updatedAt, now);

  if (timestamp === null)
    return clampPosition(reportedPosition, media?.duration);

  const elapsedSeconds = Math.max(0, now - timestamp) / 1000;
  return clampPosition(reportedPosition + elapsedSeconds, media?.duration);
}

export function smoothPosition(current, target, deltaMs, timeConstantMs) {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : safeCurrent;
  const elapsed = Math.max(0, Number(deltaMs) || 0);
  const timeConstant = Math.max(1, Number(timeConstantMs) || 1);
  const alpha = 1 - Math.exp(-elapsed / timeConstant);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}
