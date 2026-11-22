import {
  createStartupProgressGuard,
  getReportedPosition,
  getTimelinePosition,
  hasValidTimelineTimestamp,
  smoothPosition
} from "./progress-utils.js";

// REQUIRED INTERFACE: keep the FluentFlyout API import contract and the
// progress-utils exports above. The rest of this file is presentation logic
// and may be customized as long as the data contract remains intact.
const el = Object.fromEntries([
  "dashboard", "cover", "coverPlaceholder", "coverState", "trackTitle",
  "trackArtist", "trackAlbum", "playerName", "playbackPill", "playbackLabel",
  "connectionPill", "connectionLabel", "progressTrack", "progressFill",
  "progressPercent", "position", "duration", "progressAdaptation",
  "progressDetail", "availabilityValue", "availabilityDetail",
  "efficiencyValue", "efficiencyDetail", "adaptationValue", "adaptationDetail",
  "sequenceValue", "updatedValue", "sessionId", "sourceName", "sourceStatus",
  "sourceAvailable", "sourceTitle", "sourceArtist", "sourceAlbum",
  "reportedPosition", "reportedDuration", "timestampSource", "timelineUpdated",
  "progressMethod", "reportedPercent", "sampleAge", "coverStatus", "coverId",
  "coverEndpoint", "sequenceDetail", "updatedAt", "snapshotReceived", "wsState",
  "renderState", "sleepReason", "animationState", "visibilityState",
  "protocolVersion", "footerState", "visualStability"
].map(key => [key, document.getElementById(({
  trackTitle:"track-title", trackArtist:"track-artist", trackAlbum:"track-album",
  playerName:"player-name", playbackPill:"playback-pill", playbackLabel:"playback-label",
  connectionPill:"connection-pill", connectionLabel:"connection-label",
  progressTrack:"progress-track", progressFill:"progress-fill",
  progressPercent:"progress-percent", progressAdaptation:"progress-adaptation",
  progressDetail:"progress-detail", availabilityValue:"availability-value",
  availabilityDetail:"availability-detail", efficiencyValue:"efficiency-value",
  efficiencyDetail:"efficiency-detail", adaptationValue:"adaptation-value",
  adaptationDetail:"adaptation-detail", sequenceValue:"sequence-value",
  updatedValue:"updated-value", sessionId:"session-id", sourceName:"source-name",
  sourceStatus:"source-status", sourceAvailable:"source-available",
  sourceTitle:"source-title", sourceArtist:"source-artist", sourceAlbum:"source-album",
  reportedPosition:"reported-position", reportedDuration:"reported-duration",
  timestampSource:"timestamp-source", timelineUpdated:"timeline-updated",
  progressMethod:"progress-method", reportedPercent:"reported-percent",
  sampleAge:"sample-age", coverStatus:"cover-status", coverId:"cover-id",
  coverEndpoint:"cover-endpoint", sequenceDetail:"sequence-detail",
  updatedAt:"updated-at", snapshotReceived:"snapshot-received",
  wsState:"ws-state", renderState:"render-state", sleepReason:"sleep-reason",
  animationState:"animation-state", visibilityState:"visibility-state",
  protocolVersion:"protocol-version", footerState:"footer-state",
  coverPlaceholder:"cover-placeholder", coverState:"cover-state",
  visualStability:"visual-stability"
}[key] || key))]));

const CONFIG = Object.freeze({
  // CUSTOMIZABLE: pause delay before the renderer enters low-activity mode.
  pauseSleepMs: 5 * 60 * 1000,
  // CUSTOMIZABLE: visual smoothing only; this does not change SMTC data.
  normalSmoothingMs: 150,
  recoverySmoothingMs: 500,
  backwardSeekThresholdSeconds: 0.8,
  forwardSnapThresholdSeconds: 8,
  // CUSTOMIZABLE: maximum time to protect the first visual timeline anchor.
  startupGuardMaxMs: 4200,
  startupAdvancingSamples: 2,
  startupMinPositionStepSeconds: 0.05,
  startupCatchUpToleranceSeconds: 0.15,
  textUpdateIntervalMs: 200
});

const startupGuard = createStartupProgressGuard({
  maxDurationMs: CONFIG.startupGuardMaxMs,
  minAdvancingSamples: CONFIG.startupAdvancingSamples,
  minPositionStepSeconds: CONFIG.startupMinPositionStepSeconds,
  catchUpToleranceSeconds: CONFIG.startupCatchUpToleranceSeconds
});

const MODE = Object.freeze({ EFFICIENCY: "efficiency", RUNNING: "running", PAUSED: "paused" });
let mediaState = null;
let mode = MODE.EFFICIENCY;
let sleepReason = "尚未收到媒体快照";
let animationFrame = 0;
let pauseTimer = 0;
let pauseDeadline = null;
let currentTrackKey = null;
let currentCoverUrl = null;
let pendingCover = null;
let logicalAnchor = 0;
let logicalAnchorAt = performance.now();
let visualPosition = 0;
let lastFrameAt = 0;
let lastTextAt = 0;
let lastReportedPosition = null;
let resumedAt = null;
let lastSnapshotAt = null;
let connected = false;
let awaitingSnapshot = false;

function text(node, value) {
  if (node) node.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
}
function fmtTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  const s = Math.floor(n), h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`
    : `${m}:${String(r).padStart(2,"0")}`;
}
function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function fmtAge(value) {
  if (!value) return "—";
  const age = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(age)) return "—";
  return age < 0 ? "时钟超前" : age < 1000 ? `${age} ms` : `${(age/1000).toFixed(1)} s`;
}
function trackKey(media) {
  return [media?.sessionId || "", media?.title || "", media?.artist || ""].join("\u001f");
}
function durationSeconds() {
  const d = Number(mediaState?.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
}
function clampPosition(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.max(0,n) : 0;
  const duration = durationSeconds();
  return duration ? Math.min(duration,safe) : safe;
}
function logicalPosition(now = performance.now()) {
  const elapsed = mode === MODE.RUNNING && mediaState?.playbackStatus === "Playing"
    ? Math.max(0,now-logicalAnchorAt)/1000 : 0;
  return clampPosition(logicalAnchor+elapsed);
}
function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  text(el.animationState,"已挂起");
}
function startAnimation() {
  if (!connected || awaitingSnapshot || animationFrame || mode !== MODE.RUNNING || document.hidden) return;
  lastFrameAt = performance.now();
  animationFrame = requestAnimationFrame(updateProgress);
  text(el.animationState,"运行中");
}
function clearPauseTimer() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = 0;
}
function setAnchor(position, now = performance.now(), syncVisual = false) {
  logicalAnchor = clampPosition(position);
  logicalAnchorAt = now;
  if (syncVisual) visualPosition = logicalAnchor;
}
function setStartupGuardUi(active, reason = null) {
  el.dashboard.classList.toggle("is-startup-hold",Boolean(active));
  if (!el.visualStability) return;
  el.visualStability.className = "visual-state-tag" + (active ? " is-holding" : "");
  text(el.visualStability,active ? "启动保护" :
    reason === "stable" ? "数据已稳定" :
    reason === "seek" ? "Seek 已确认" : "平滑渲染");
}
function beginStartupGuard(media, now = performance.now()) {
  if (hasValidTimelineTimestamp(media,Date.now())) {
    startupGuard.start(getReportedPosition(media),now);
    setStartupGuardUi(true);
  } else {
    startupGuard.cancel();
    setStartupGuardUi(false);
  }
}
function renderProgress(position, force = false) {
  const duration = durationSeconds();
  const current = clampPosition(position);
  const pct = duration ? Math.max(0,Math.min(100,current/duration*100)) : null;
  el.progressFill.style.transform = `scaleX(${pct === null ? 0 : pct/100})`;
  el.progressTrack.setAttribute("aria-valuenow",pct === null ? "0" : pct.toFixed(1));
  text(el.position,fmtTime(current));
  text(el.duration,duration ? fmtTime(duration) : "时长未知");
  if (force || performance.now()-lastTextAt >= CONFIG.textUpdateIntervalMs) {
    text(el.progressPercent,pct === null ? "不可计算" : `${pct.toFixed(1)}%`);
    text(el.reportedPercent,pct === null ? "不可计算（Duration 缺失）" : `${pct.toFixed(2)}%`);
    lastTextAt = performance.now();
  }
}
function getProgressSource(media) {
  const now = Date.now();
  if (hasValidTimelineTimestamp(media,now))
    return { label:"SMTC 时间线", method:"Position + TimelineLastUpdatedTime", detail:"使用 SMTC 时间戳外推", grade:"优" };
  const updated = Date.parse(media?.updatedAt || "");
  if (Number.isFinite(updated) && updated >= Date.UTC(2000,0,1) && updated-now <= 1000)
    return { label:"UpdatedAt 回退", method:"Position + UpdatedAt 初始锚点", detail:"缺少有效 SMTC 时间戳，使用服务更新时间回退", grade:"回退" };
  return { label:"Position 直读", method:"报告值 + 本地单调时钟", detail:"缺少可用时间戳；仅依赖 Position 跳变修正", grade:"有限" };
}
function renderProgressDiagnostics(media) {
  const source = getProgressSource(media);
  const hasDuration = durationSeconds() > 0;
  const hasPosition = Number.isFinite(Number(media.position));
  const grade = !hasDuration ? "不完整" : hasPosition ? source.grade : "无数据";
  text(el.progressAdaptation,!hasDuration ? "时长缺失 · 无法计算百分比" : source.label);
  text(el.progressDetail,!hasDuration ? "音源未提供有效 Duration" : source.detail);
  text(el.timestampSource,source.label);
  text(el.progressMethod,source.method);
  text(el.adaptationValue,grade);
  text(el.adaptationDetail,!hasDuration ? "需音源提供有效 Duration" : source.detail);
  text(el.sampleAge,fmtAge(media.timelineLastUpdatedTime || media.updatedAt));
}
function renderMetadata(media) {
  const status = media.playbackStatus || "Unknown";
  text(el.trackTitle,media.title || "未知曲目");
  text(el.trackArtist,media.artist || "未知艺术家");
  text(el.trackAlbum,media.album || "专辑信息缺失");
  text(el.playerName,media.playerName || "未识别音源");
  text(el.sourceName,media.playerName);
  text(el.sourceStatus,status);
  text(el.sourceAvailable,media.isAvailable ? "是" : "否");
  text(el.sourceTitle,media.title);
  text(el.sourceArtist,media.artist);
  text(el.sourceAlbum,media.album);
  text(el.sessionId,media.sessionId);
  text(el.reportedPosition,fmtTime(media.position));
  text(el.reportedDuration,media.duration > 0 ? fmtTime(media.duration) : "未知 / 0");
  text(el.timelineUpdated,fmtDate(media.timelineLastUpdatedTime));
  text(el.sequenceValue,media.sequence);
  text(el.sequenceDetail,media.sequence);
  text(el.updatedAt,fmtDate(media.updatedAt));
  text(el.updatedValue,`更新时间：${fmtDate(media.updatedAt)}`);
  text(el.snapshotReceived,lastSnapshotAt ? new Date(lastSnapshotAt).toLocaleTimeString() : "—");
  text(el.availabilityValue,media.isAvailable ? "可用" : "不可用");
  text(el.availabilityDetail,media.isAvailable ? "已接收到活动媒体会话" : "没有可用的 SMTC 媒体会话");
  text(el.protocolVersion,window.FluentFlyout?.protocolVersion || "未知");
  text(el.footerState,`会话序列 ${media.sequence ?? "—"} · ${status}`);
  renderProgressDiagnostics(media);
}
function releaseCover() {
  if (pendingCover) {
    pendingCover.onload = pendingCover.onerror = null;
    pendingCover.src = "";
    pendingCover = null;
  }
  el.cover.removeAttribute("src");
  el.cover.hidden = true;
  el.coverPlaceholder.hidden = false;
  currentCoverUrl = null;
}
function setCover(url) {
  if (url === currentCoverUrl) return;
  if (pendingCover) {
    pendingCover.onload = pendingCover.onerror = null;
    pendingCover.src = "";
    pendingCover = null;
  }
  currentCoverUrl = url || null;
  if (!currentCoverUrl) {
    el.cover.removeAttribute("src");
    el.cover.hidden = true;
    el.coverPlaceholder.hidden = false;
    text(el.coverState,"无封面");
    text(el.coverStatus,"未提供");
    text(el.coverId,null);
    text(el.coverEndpoint,"未提供");
    return;
  }
  text(el.coverState,"封面加载中");
  text(el.coverStatus,"加载中");
  text(el.coverId,mediaState?.coverId);
  // Do not display the full URL: it contains the process-local access token.
  text(el.coverEndpoint,"本地受保护接口 /api/covers/");
  const image = new Image();
  pendingCover = image;
  image.onload = () => {
    if (pendingCover !== image || currentCoverUrl !== url) return;
    pendingCover = null;
    el.cover.src = url;
    el.cover.hidden = false;
    el.coverPlaceholder.hidden = true;
    text(el.coverState,"封面已加载");
    text(el.coverStatus,"已加载");
  };
  image.onerror = () => {
    if (pendingCover !== image || currentCoverUrl !== url) return;
    pendingCover = null;
    currentCoverUrl = null;
    el.cover.hidden = true;
    el.coverPlaceholder.hidden = false;
    text(el.coverState,"封面不可用");
    text(el.coverStatus,"加载失败");
  };
  image.src = url;
}
function setEfficiency(reason) {
  startupGuard.cancel();
  setStartupGuardUi(false);
  mode = MODE.EFFICIENCY;
  sleepReason = reason;
  stopAnimation();
  clearPauseTimer();
  el.dashboard.classList.add("is-efficiency");
  text(el.efficiencyValue,"效率模式");
  text(el.efficiencyDetail,"动画帧与高频视觉更新已挂起");
  text(el.renderState,"休眠 / 效率模式");
  text(el.sleepReason,reason);
  text(el.footerState,`效率模式 · ${reason}`);
}
function wake(reason = "正在播放") {
  mode = MODE.RUNNING;
  sleepReason = "";
  el.dashboard.classList.remove("is-efficiency");
  text(el.efficiencyValue,"活动模式");
  text(el.efficiencyDetail,"播放进度实时渲染");
  text(el.renderState,"活动 / 实时渲染");
  text(el.sleepReason,reason);
}
function schedulePausedSleep() {
  if (pauseTimer || pauseDeadline === null) return;
  pauseTimer = window.setTimeout(() => {
    pauseTimer = 0;
    if (mediaState?.playbackStatus === "Paused") setEfficiency("暂停超过 5 分钟");
  }, Math.max(0, pauseDeadline - Date.now()));
}
function showTempo(value, status) {
  text(document.getElementById("tempo-value"), value);
  text(document.getElementById("tempo-status"), status);
}

function renderTempo(media) {
  if (!media?.isAvailable) return showTempo("—", "无媒体会话");
  if (media.playbackStatus !== "Playing") return showTempo("—", media.playbackStatus === "Paused" ? "播放已暂停" : "播放已停止");
  if (!Object.hasOwn(media, "bpm")) return showTempo("—", "快照未包含 BPM");
  if (media.bpm === null) return showTempo("—", "暂无可信估算");
  if (!Number.isFinite(media.bpm) || media.bpm <= 0) return showTempo("—", "BPM 数据无效");
  showTempo(String(media.bpm), "已收到节奏估算");
}

function render(media) {
  if (!connected || !media) return;
  const resync = awaitingSnapshot;
  awaitingSnapshot = false;
  if (connected) renderTempo(media);
  lastSnapshotAt = Date.now();
  const previousStatus = mediaState?.playbackStatus;
  mediaState = media;
  if (!media.isAvailable || media.playbackStatus !== "Paused") {
    pauseDeadline = null;
  } else if (pauseDeadline === null || trackKey(media) !== currentTrackKey) {
    clearPauseTimer();
    pauseDeadline = Date.now() + CONFIG.pauseSleepMs;
  } else if (Date.now() >= pauseDeadline) {
    if (mode !== MODE.EFFICIENCY) setEfficiency("暂停超过 5 分钟");
    return;
  }
  renderMetadata(media);
  setCover(media.coverUrl || null);
  const key = trackKey(media);
  const changed = key !== currentTrackKey;
  const status = media.playbackStatus;
  if (changed || !media.isAvailable || status !== "Playing") resumedAt = null;
  text(el.playbackLabel,status === "Playing" ? "正在播放" : status === "Paused" ? "已暂停" : status || "未知状态");
  el.playbackPill.className = "pill " + (status === "Playing" ? "pill-live" : status === "Paused" ? "pill-paused" : "pill-muted");

  if (!media.isAvailable) {
    currentTrackKey = key;
    setEfficiency("无可用媒体会话");
    releaseCover();
    text(el.availabilityValue,"不可用");
    text(el.coverStatus,"无媒体封面");
    return;
  }
  if (status === "Stopped" || status === "Closed") {
    currentTrackKey = key;
    setEfficiency(status === "Closed" ? "媒体会话已关闭" : "播放已停止");
    return;
  }
  if (status === "Paused") {
    currentTrackKey = key;
    stopAnimation();
    mode = MODE.PAUSED;
    const now = performance.now();
    const pausedPosition = getReportedPosition(media, changed ? 0 : visualPosition);
    startupGuard.cancel();
    setStartupGuardUi(false);
    setAnchor(pausedPosition,now,true);
    lastReportedPosition = pausedPosition;
    renderProgress(visualPosition,true);
    el.dashboard.classList.remove("is-efficiency");
    text(el.efficiencyValue,"静态暂停");
    text(el.efficiencyDetail,"无动画帧；等待恢复或进入效率模式");
    text(el.renderState,"暂停 / 静态渲染");
    text(el.sleepReason,"暂停计时中");
    schedulePausedSleep();
    return;
  }
  if (status !== "Playing") {
    setEfficiency("等待可识别的播放状态");
    return;
  }

  clearPauseTimer();
  if (resync || changed || mode !== MODE.RUNNING) {
    const resetForNewPlayback = resync || changed ||
      ["无可用媒体会话","播放已停止","媒体会话已关闭"].includes(sleepReason);
    currentTrackKey = key;
    wake();
    const now = performance.now();
    const staleResumeTimeline = resync && resumedAt !== null &&
        !(Date.parse(media.timelineLastUpdatedTime) >= resumedAt);
    const resumed = !changed && (previousStatus === "Paused" || staleResumeTimeline);
    const reported = getReportedPosition(media,resumed ? visualPosition : 0);
    if (resumed) {
      // A Playing snapshot may still carry the SMTC timestamp from before pause.
      const publishedAt = Date.parse(media.updatedAt);
      resumedAt = Number.isFinite(publishedAt) ? publishedAt : Date.now();
      startupGuard.cancel();
      setStartupGuardUi(false);
      setAnchor(reported,now,true);
    } else if (resetForNewPlayback) {
      const initial = getTimelinePosition(media,Date.now());
      setAnchor(initial,now,true);
      beginStartupGuard(media,now);
    } else {
      startupGuard.cancel();
      setStartupGuardUi(false);
      setAnchor(Math.max(getTimelinePosition(media,Date.now()),visualPosition),now,false);
    }
    lastReportedPosition = reported;
    renderProgress(visualPosition,true);
    startAnimation();
    return;
  }

  const now = performance.now();
  const reported = getReportedPosition(media, resumedAt === null ? 0 : lastReportedPosition);
  const current = logicalPosition(now);
  const wallNow = Date.now();
  const timelineValid = hasValidTimelineTimestamp(media,wallNow) &&
    (resumedAt === null || Date.parse(media.timelineLastUpdatedTime) >= resumedAt);
  const incoming = timelineValid ? getTimelinePosition(media,wallNow) : reported;
  const backwardSeek = lastReportedPosition !== null &&
    reported < lastReportedPosition-CONFIG.backwardSeekThresholdSeconds;
  const forwardSeek = incoming-current > CONFIG.forwardSnapThresholdSeconds;
  let handledByStartupGuard = false;

  if (startupGuard.isActive && !timelineValid) {
    startupGuard.cancel();
    setStartupGuardUi(false);
  }

  if (startupGuard.isActive && timelineValid) {
    handledByStartupGuard = true;
    const guard = startupGuard.observe({
      reportedPosition:reported,
      incomingPosition:incoming,
      visualPosition,
      now,
      explicitSeek:backwardSeek || forwardSeek
    });

    if (guard.released) {
      setStartupGuardUi(false,guard.reason);
      if (guard.reason === "seek") {
        setAnchor(incoming,now,true);
        renderProgress(visualPosition,true);
      } else {
        // Resume from whichever is further ahead: the new anchor or the
        // position already shown to the user. Never animate a false rollback.
        setAnchor(Math.max(incoming,visualPosition),now,false);
      }
    } else {
      // Keep the logical anchor current during startup, but let the visual
      // playhead hold its last displayed value if this sample moves backward.
      setAnchor(incoming,now,false);
    }
  }

  if (!handledByStartupGuard) {
    if (!timelineValid) {
      if (backwardSeek) {
        setAnchor(reported,now,true);
        renderProgress(visualPosition,true);
      } else if (reported-current > CONFIG.forwardSnapThresholdSeconds) {
        setAnchor(reported,now,true);
        renderProgress(visualPosition,true);
      } else if (reported-current > .6) {
        setAnchor(reported,now,false);
      }
    } else {
      const difference = incoming-current;
      // A timestamp-only backward correction is not a seek. Some providers
      // refresh the timeline timestamp while Position remains at zero during
      // startup; only a raw Position discontinuity authorizes a backward snap.
      if (backwardSeek || forwardSeek) {
        setAnchor(incoming,now,true);
        renderProgress(visualPosition,true);
      } else {
        setAnchor(difference < 0 ? current : incoming,now,false);
      }
    }
  }
  lastReportedPosition = reported;
  startAnimation();
}
function updateProgress() {
  animationFrame = 0;
  if (mode !== MODE.RUNNING || document.hidden || !mediaState) {
    text(el.animationState,"已挂起");
    return;
  }
  const now = performance.now();
  visualPosition = clampPosition(visualPosition);
  const target = Math.max(visualPosition,logicalPosition(now));
  const gap = target-visualPosition;
  if (gap > 0.001) {
    const smoothing = gap > .6 ? CONFIG.recoverySmoothingMs : CONFIG.normalSmoothingMs;
    visualPosition = clampPosition(
      smoothPosition(visualPosition,target,Math.max(0,now-lastFrameAt),smoothing)
    );
  }
  lastFrameAt = now;
  renderProgress(visualPosition);
  startAnimation();
}
function onVisibilityChange() {
  text(el.visibilityState,document.hidden ? "后台 / 不可见" : "前台 / 可见");
  if (document.hidden) {
    if (mode === MODE.RUNNING) setAnchor(logicalPosition(),performance.now(),false);
    stopAnimation();
  } else if (mode === MODE.RUNNING) {
    startAnimation();
  }
}
function onConnectionChange(value) {
  if (connected && !value) {
    awaitingSnapshot = true;
    stopAnimation();
    clearPauseTimer();
  }
  connected = Boolean(value);
  showTempo("—", connected ? "等待媒体快照" : "连接断开");
  el.connectionPill.className = "pill " + (connected ? "pill-online" : "pill-offline");
  text(el.connectionLabel,connected ? "服务已连接" : "连接断开");
  text(el.wsState,connected ? "已连接" : "未连接");
}
document.addEventListener("visibilitychange",onVisibilityChange);
window.addEventListener("pagehide",() => { stopAnimation(); clearPauseTimer(); releaseCover(); });
window.addEventListener("pageshow",() => {
  if (mediaState?.playbackStatus === "Playing" && mode === MODE.RUNNING) startAnimation();
  if (mediaState?.playbackStatus === "Paused" && mode === MODE.PAUSED) schedulePausedSleep();
});
text(el.visibilityState,document.hidden ? "后台 / 不可见" : "前台 / 可见");
text(el.protocolVersion,window.FluentFlyout?.protocolVersion || "未加载");

// REQUIRED INTERFACE: these subscriptions are supplied by fluentflyout-api.js.
// Keep the method names and callback semantics; presentation code is customizable.
if (window.FluentFlyout?.onMediaChanged) {
  window.FluentFlyout.onConnectionChanged?.(onConnectionChange);
  window.FluentFlyout.onMediaChanged(render);
} else {
  showTempo("—", "通信接口未加载");
  console.error("FluentFlyout API missing. Keep /js/fluentflyout-api.js in index.html.");
  text(el.footerState,"通信接口未加载：请检查 fluentflyout-api.js");
}
