// REQUIRED PROGRESS HELPERS.
// The SMTC timestamp is the primary anchor. UpdatedAt is used only for the
// first anchor when LastUpdatedTime is missing/sentinel; later snapshots
// without a valid SMTC timestamp must not repeatedly re-anchor the playhead.

export function getReportedPosition(media, fallback = 0) {
  const raw = media?.position;
  if (raw === null || raw === undefined || raw === "") {
    const safeFallback = Number(fallback);
    return Number.isFinite(safeFallback) ? Math.max(0, safeFallback) : 0;
  }

  const position = Number(raw);
  return Number.isFinite(position) && position >= 0
    ? position
    : Math.max(0, Number(fallback) || 0);
}

export function parseAnchorTimestamp(value, now = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1))
    return null;
  if (timestamp - now > 1000)
    return null;
  return timestamp;
}

export function hasValidTimelineTimestamp(media, now = Date.now()) {
  return parseAnchorTimestamp(media?.timelineLastUpdatedTime, now) !== null;
}

export function clampPosition(position, duration = 0) {
  const safePosition = Number.isFinite(Number(position))
    ? Math.max(0, Number(position))
    : 0;
  const safeDuration = Number(duration);
  return Number.isFinite(safeDuration) && safeDuration > 0
    ? Math.min(safeDuration, safePosition)
    : safePosition;
}

export function getTimelinePosition(
  media,
  now = Date.now(),
  { allowUpdatedAtFallback = false, fallback = 0 } = {}
) {
  const reported = getReportedPosition(media, fallback);
  const timestamp =
    parseAnchorTimestamp(media?.timelineLastUpdatedTime, now) ??
    (allowUpdatedAtFallback
      ? parseAnchorTimestamp(media?.updatedAt, now)
      : null);

  if (timestamp === null)
    return clampPosition(reported, media?.duration);

  const elapsedSeconds = Math.max(0, now - timestamp) / 1000;
  return clampPosition(reported + elapsedSeconds, media?.duration);
}

export function smoothPosition(current, target, deltaMs, timeConstantMs) {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : safeCurrent;
  const elapsed = Math.max(0, Number(deltaMs) || 0);
  const timeConstant = Math.max(1, Number(timeConstantMs) || 1);
  const alpha = 1 - Math.exp(-elapsed / timeConstant);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}

/*
 * Startup visual guard:
 * - It does not calculate playback time.
 * - It holds a visual rollback while the first timeline samples settle.
 * - It releases after two advancing samples catch up, on a confirmed seek,
 *   or after a bounded timeout.
 */
export function createStartupProgressGuard({
  maxDurationMs = 4200,
  minAdvancingSamples = 2,
  minPositionStepSeconds = 0.05,
  catchUpToleranceSeconds = 0.15
} = {}) {
  let active = false;
  let startedAt = 0;
  let lastReportedPosition = null;
  let advancingSamples = 0;

  const finitePosition = value => {
    const number = Number(value);
    return value !== null && value !== undefined && value !== "" &&
      Number.isFinite(number) && number >= 0 ? number : null;
  };

  const result = (released, reason = null, incomingPosition = null, visualPosition = null) => ({
    active,
    released,
    reason,
    hold: active && incomingPosition !== null && visualPosition !== null &&
      incomingPosition < visualPosition - catchUpToleranceSeconds,
    advancingSamples
  });

  return {
    start(initialReportedPosition, now = 0) {
      active = true;
      startedAt = Number.isFinite(now) ? now : 0;
      lastReportedPosition = finitePosition(initialReportedPosition);
      advancingSamples = 0;
      return result(false);
    },

    cancel() {
      active = false;
      advancingSamples = 0;
      return result(false);
    },

    observe({
      reportedPosition,
      incomingPosition,
      visualPosition,
      now = 0,
      explicitSeek = false
    } = {}) {
      if (!active) return result(false);

      if (explicitSeek) {
        active = false;
        return result(true, "seek");
      }

      const reported = finitePosition(reportedPosition);
      if (reported !== null) {
        if (lastReportedPosition !== null) {
          const delta = reported - lastReportedPosition;
          advancingSamples = delta >= minPositionStepSeconds
            ? advancingSamples + 1
            : 0;
        }
        lastReportedPosition = reported;
      }

      const incoming = finitePosition(incomingPosition);
      const visual = finitePosition(visualPosition);
      const caughtUp = incoming !== null && visual !== null &&
        incoming >= visual - catchUpToleranceSeconds;

      if (advancingSamples >= minAdvancingSamples && caughtUp) {
        active = false;
        return result(true, "stable");
      }

      if (Number.isFinite(now) && now - startedAt >= maxDurationMs) {
        active = false;
        return result(true, "timeout");
      }

      return result(false, null, incoming, visual);
    },

    get isActive() {
      return active;
    }
  };
}
