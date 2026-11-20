// Small, pure helpers shared by the built-in Browser Source and its tests.

export function getReportedPosition(media, fallback = 0) {
  const raw = media?.position;
  if (raw === null || raw === undefined || raw === "")
    return Math.max(0, Number(fallback) || 0);

  const position = Number(raw);
  return Number.isFinite(position) && position >= 0
    ? position
    : Math.max(0, Number(fallback) || 0);
}

export function getEstimatedPosition(media, now = Date.now(), maxAgeMs = 2000) {
  const position = getReportedPosition(media);
  const timestamp = Date.parse(media?.timelineLastUpdatedTime || "");

  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1))
    return position;

  const age = Math.max(0, Math.min(maxAgeMs, now - timestamp));
  return position + age / 1000;
}

export function shouldStartProgress(position, duration, minimumRatio = 0.02) {
  if (!Number.isFinite(position) || position <= 0)
    return false;
  if (!Number.isFinite(duration) || duration <= 0)
    return true;
  return position / duration >= minimumRatio;
}
