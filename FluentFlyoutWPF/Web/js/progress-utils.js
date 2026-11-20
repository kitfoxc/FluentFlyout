// Pure helpers for the built-in Browser Source progress state machine.
// Kept independent of the DOM so edge cases can be tested with Node's built-in runner.

export function getReportedPosition(media, fallback = 0) {
  const rawPosition = media?.position;
  if (rawPosition === null || rawPosition === undefined || rawPosition === "")
    return Math.max(0, Number(fallback) || 0);

  const position = Number(rawPosition);
  return Number.isFinite(position) && position >= 0
    ? position
    : Math.max(0, Number(fallback) || 0);
}

export function isTimelineFresh(media, now = Date.now(), staleMs = 4500) {
  const timestamp = Date.parse(media?.timelineLastUpdatedTime || "");
  // SMTC providers may leave LastUpdatedTime at DateTimeOffset.MinValue. Older
  // protocol-compatible sources may omit the field entirely; both use event
  // arrival timing as the available freshness signal.
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1))
    return true;

  const age = now - timestamp;
  return age >= -1000 && age <= staleMs;
}

export function pruneRecentSamples(samples, now, windowMs) {
  return samples.filter(sample => {
    const age = now - sample.at;
    return Number.isFinite(sample.at) && age >= 0 && age <= windowMs;
  });
}

export function hasForwardProgress(samples, minSamples, minSpanMs, minAdvance) {
  if (!Array.isArray(samples) || samples.length < minSamples)
    return false;

  const first = samples[0];
  const latest = samples[samples.length - 1];
  return Number.isFinite(first?.at)
    && Number.isFinite(latest?.at)
    && Number.isFinite(first?.position)
    && Number.isFinite(latest?.position)
    && latest.at - first.at >= minSpanMs
    && latest.position - first.position >= minAdvance;
}
