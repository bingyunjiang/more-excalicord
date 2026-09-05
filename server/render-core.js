"use strict";

const path = require("path");

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWebcamShape(value) {
  return ["circle", "rounded", "pill"].includes(value) ? value : "rounded";
}

function safeRelativePath(value) {
  const text = typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
  if (!text || text.startsWith("/") || /^[A-Za-z]:\//.test(text) || text.includes("\0")) return "";
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
}

function resolveProjectPath(root, relativePath) {
  const safe = safeRelativePath(relativePath);
  if (!safe) throw new Error("项目文件路径无效");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safe);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("项目文件越过项目根目录");
  }
  return resolved;
}

function isProjectRecordingAssetPath(value) {
  const safe = safeRelativePath(value);
  if (!safe) return false;
  if (safe.startsWith("recordings/")) return true;
  return !safe.includes("/") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.(?:mp4|mov|m4a|m4v|webm|wav)$/i.test(safe);
}

function normalizeTimeMap(timeMap, durationMs) {
  const raw = timeMap && Array.isArray(timeMap.segments) ? timeMap.segments : [];
  const segments = raw.map((segment) => ({
    sourceStartMs: Math.max(0, finite(segment.sourceStartMs, 0)),
    sourceEndMs: Math.max(0, finite(segment.sourceEndMs, 0)),
    outputStartMs: Math.max(0, finite(segment.outputStartMs, 0)),
    outputEndMs: Math.max(0, finite(segment.outputEndMs, 0)),
    rate: clamp(finite(segment.rate, 1), 0.1, 16),
    deleted: Boolean(segment.deleted),
  })).filter((segment) => segment.sourceEndMs > segment.sourceStartMs)
    .sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  if (!segments.length) {
    const duration = Math.max(0, finite(durationMs, 0));
    return {
      sourceDurationMs: duration,
      outputDurationMs: duration,
      segments: duration ? [{
        sourceStartMs: 0,
        sourceEndMs: duration,
        outputStartMs: 0,
        outputEndMs: duration,
        rate: 1,
        deleted: false,
      }] : [],
    };
  }
  return {
    sourceDurationMs: Math.max(finite(timeMap && timeMap.sourceDurationMs, 0), segments[segments.length - 1].sourceEndMs),
    outputDurationMs: Math.max(finite(timeMap && timeMap.outputDurationMs, 0), ...segments.map((item) => item.outputEndMs)),
    segments,
  };
}

function sourceToOutput(timeMap, sourceTimeMs) {
  const source = Math.max(0, finite(sourceTimeMs, 0));
  for (let index = 0; index < timeMap.segments.length; index += 1) {
    const segment = timeMap.segments[index];
    const last = index === timeMap.segments.length - 1;
    if (source >= segment.sourceStartMs && (source < segment.sourceEndMs || (last && source <= segment.sourceEndMs))) {
      if (segment.deleted) return { timeMs: segment.outputStartMs, deleted: true, segmentIndex: index };
      return {
        timeMs: segment.outputStartMs + (source - segment.sourceStartMs) / segment.rate,
        deleted: false,
        segmentIndex: index,
      };
    }
  }
  return { timeMs: timeMap.outputDurationMs, deleted: false, segmentIndex: -1 };
}

function mapSourceRange(timeMap, startMs, endMs) {
  const start = Math.max(0, finite(startMs, 0));
  const end = Math.max(start, finite(endMs, start));
  const output = [];
  timeMap.segments.forEach((segment) => {
    if (segment.deleted) return;
    const sourceStartMs = Math.max(start, segment.sourceStartMs);
    const sourceEndMs = Math.min(end, segment.sourceEndMs);
    if (sourceEndMs <= sourceStartMs) return;
    output.push({
      sourceStartMs,
      sourceEndMs,
      outputStartMs: segment.outputStartMs + (sourceStartMs - segment.sourceStartMs) / segment.rate,
      outputEndMs: segment.outputStartMs + (sourceEndMs - segment.sourceStartMs) / segment.rate,
      rate: segment.rate,
    });
  });
  return output;
}

function mapSubtitles(subtitles, timeMap) {
  const output = [];
  (Array.isArray(subtitles) ? subtitles : []).forEach((subtitle, index) => {
    const startMs = Math.max(0, finite(subtitle.startMs, finite(subtitle.start, 0) * 1000));
    const endMs = Math.max(0, finite(subtitle.endMs, finite(subtitle.end, 0) * 1000));
    const text = typeof subtitle.text === "string" ? subtitle.text.replace(/\r/g, "").trim() : "";
    if (!text || endMs <= startMs) return;
    mapSourceRange(timeMap, startMs, endMs).forEach((fragment, fragmentIndex) => {
      output.push({
        id: String(subtitle.id || `subtitle-${index + 1}`) + (fragmentIndex ? `-${fragmentIndex + 1}` : ""),
        startMs: fragment.outputStartMs,
        endMs: fragment.outputEndMs,
        text,
        style: subtitle.style || "default",
      });
    });
  });
  return output.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function mapCameraTrack(camera, timeMap) {
  if (!camera || camera.enabled === false) return [];
  const motionMode = camera.motionMode === "3d" ? "3d" : "2d";
  const maximumTilt = ({ gentle: 3.2, medium: 5.2, strong: 7.5 })[camera.strength] || 3.2;
  const output = [];
  (Array.isArray(camera.keyframes) ? camera.keyframes : []).forEach((frame, index) => {
    const sourceMs = Math.max(0, finite(frame.timeMs, finite(frame.t, 0) * 1000));
    const mapped = sourceToOutput(timeMap, sourceMs);
    if (mapped.deleted) return;
    const x = clamp(finite(frame.x, 0.5), 0, 1);
    const y = clamp(finite(frame.y, 0.5), 0, 1);
    const scale = clamp(finite(frame.scale, 1), 1, 4);
    const focusAmount = clamp((scale - 1) / 0.58, 0, 1);
    output.push({
      id: frame.id || `camera-${index + 1}`,
      timeMs: mapped.timeMs,
      x,
      y,
      scale,
      tiltX: motionMode === "3d" ? clamp((0.5 - y) * maximumTilt * 2 * focusAmount, -maximumTilt, maximumTilt) : 0,
      tiltY: motionMode === "3d" ? clamp((x - 0.5) * maximumTilt * 2 * focusAmount, -maximumTilt, maximumTilt) : 0,
      transitionMs: clamp(finite(frame.transitionMs, 420), 0, 3000),
    });
  });
  output.sort((a, b) => a.timeMs - b.timeMs);
  const deduped = [];
  output.forEach((frame) => {
    if (deduped.length && Math.abs(deduped[deduped.length - 1].timeMs - frame.timeMs) < 1) deduped[deduped.length - 1] = frame;
    else deduped.push(frame);
  });
  if (!deduped.length || deduped[0].timeMs > 1) {
    deduped.unshift({ id: "camera-start", timeMs: 0, x: 0.5, y: 0.5, scale: 1, tiltX: 0, tiltY: 0, transitionMs: 0 });
  }
  if (deduped.length <= 160) return deduped;
  const step = (deduped.length - 1) / 159;
  return Array.from({ length: 160 }, (_, index) => deduped[Math.round(index * step)]);
}

function eventSourceTimeMs(event) {
  if (!event || typeof event !== "object") return 0;
  if (Number.isFinite(Number(event.timeMs))) return Math.max(0, Number(event.timeMs));
  if (Number.isFinite(Number(event.tMs))) return Math.max(0, Number(event.tMs));
  return Math.max(0, finite(event.t, 0) * 1000);
}

function mapCursorTrack(cursor, recording, timeMap) {
  const settings = cursor && typeof cursor === "object" ? cursor : {};
  const color = /^#[0-9a-f]{6}$/i.test(settings.color || "") ? settings.color : "#ef4444";
  const sourceEvents = recording && Array.isArray(recording.embeddedEvents)
    ? recording.embeddedEvents
    : recording && recording.embeddedSession && Array.isArray(recording.embeddedSession.events)
      ? recording.embeddedSession.events
      : [];
  if (settings.visible === false || !sourceEvents.length) {
    return { visible: false, size: 1, color, smoothing: 0.55, clickEffect: true, events: [], clicks: [] };
  }
  const smoothing = clamp(finite(settings.smoothing, 0.55), 0, 1);
  const mapped = [];
  const clicks = [];
  sourceEvents.forEach((event) => {
    if (!event || !["pointer", "click"].includes(event.type) || event.insideCanvas === false) return;
    const sourceMs = eventSourceTimeMs(event);
    const output = sourceToOutput(timeMap, sourceMs);
    if (output.deleted) return;
    const point = {
      timeMs: output.timeMs,
      x: clamp(finite(event.x, 0.5), 0, 1),
      y: clamp(finite(event.y, 0.5), 0, 1),
      type: event.type,
    };
    if (event.type === "click") clicks.push(point);
    const previous = mapped[mapped.length - 1];
    if (previous && event.type !== "click" && point.timeMs - previous.timeMs < 45) {
      mapped[mapped.length - 1] = point;
    } else {
      mapped.push(point);
    }
  });
  if (mapped.length > 120) {
    const step = (mapped.length - 1) / 119;
    const sampled = Array.from({ length: 120 }, (_, index) => mapped[Math.round(index * step)]);
    mapped.length = 0;
    sampled.forEach((point) => mapped.push(point));
  }
  mapped.forEach((point, index) => {
    const previous = mapped[Math.max(0, index - 1)];
    point.transitionMs = index ? Math.min(180, Math.max(0, (point.timeMs - previous.timeMs) * smoothing)) : 0;
  });
  return {
    visible: mapped.length > 0,
    size: clamp(finite(settings.size, 1), 0.5, 2.5),
    color,
    smoothing,
    clickEffect: settings.clickEffect !== false,
    events: mapped,
    clicks: clicks.slice(0, 80),
  };
}

function normalizeWebcamTrack(webcam, recording) {
  const settings = webcam && typeof webcam === "object" ? webcam : {};
  const asset = recording && recording.assets && recording.assets.webcam;
  const assetPath = safeRelativePath(asset && asset.path);
  const position = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(settings.position)
    ? settings.position
    : "bottom-right";
  return {
    visible: settings.visible !== false && Boolean(assetPath) && !(recording && recording.legacyComposite),
    path: assetPath,
    position,
    scale: clamp(finite(settings.scale, 0.2), 0.08, 0.45),
    mirror: settings.mirror !== false,
    shape: normalizeWebcamShape(settings.shape),
  };
}

function webcamShapeGeometry(outputWidth, webcam) {
  const shape = normalizeWebcamShape(webcam && webcam.shape);
  const width = even(outputWidth * clamp(finite(webcam && webcam.scale, 0.2), 0.08, 0.45));
  const height = shape === "circle" ? width : even(width * 0.72);
  const radius = shape === "circle"
    ? Math.floor(Math.min(width, height) / 2)
    : (shape === "pill" ? Math.floor(height / 2) : Math.max(2, Math.round(Math.min(width, height) * 0.16)));
  return { shape, width, height, radius };
}

function roundedAlphaExpression(radius) {
  const r = Math.max(1, Math.round(radius));
  return "if(gt(lte(abs(X-W/2),W/2-" + r + ")+lte(abs(Y-H/2),H/2-" + r + "),0),255,if(lte(hypot(abs(X-W/2)-(W/2-" + r + "),abs(Y-H/2)-(H/2-" + r + "))," + r + "),255,0))";
}

function piecewiseExpression(frames, field, timeVariable) {
  if (frames.length > 36) {
    const step = (frames.length - 1) / 35;
    frames = Array.from({ length: 36 }, (_, index) => frames[Math.round(index * step)]);
  }
  if (!frames.length) return field === "scale" ? "1" : "0.5";
  if (frames.length === 1) return String(finite(frames[0][field], field === "scale" ? 1 : 0.5));
  const t = timeVariable || "on/30";
  function segmentExpression(index) {
    if (index >= frames.length - 1) return String(finite(frames[frames.length - 1][field], 0));
    const before = frames[index];
    const after = frames[index + 1];
    const beforeValue = finite(before[field], 0);
    const afterValue = finite(after[field], beforeValue);
    const end = after.timeMs / 1000;
    const transitionStart = Math.max(before.timeMs, after.timeMs - after.transitionMs) / 1000;
    const rest = segmentExpression(index + 1);
    if (end <= transitionStart + 0.0001) {
      return `if(lt(${t},${end.toFixed(6)}),${afterValue.toFixed(6)},${rest})`;
    }
    const lerp = `(${beforeValue.toFixed(6)}+(${afterValue.toFixed(6)}-${beforeValue.toFixed(6)})*(${t}-${transitionStart.toFixed(6)})/${(end - transitionStart).toFixed(6)})`;
    return `if(lt(${t},${transitionStart.toFixed(6)}),${beforeValue.toFixed(6)},if(lt(${t},${end.toFixed(6)}),${lerp},${rest}))`;
  }
  return segmentExpression(0);
}

function atempoFilters(rate) {
  let remaining = clamp(finite(rate, 1), 0.1, 16);
  const filters = [];
  while (remaining < 0.5 - 1e-6) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2 + 1e-6) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-6) {
    if (Math.abs(remaining - 2) < 1e-6) filters.push("atempo=2");
    else if (Math.abs(remaining - 0.5) < 1e-6) filters.push("atempo=0.5");
    else filters.push(`atempo=${remaining.toFixed(8)}`);
  }
  return filters;
}

function even(value) {
  const number = Math.max(2, Math.round(finite(value, 2)));
  return number % 2 ? number - 1 : number;
}

function parseRatio(value, fallback) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;
  const right = Number(match[2]);
  return right ? Number(match[1]) / right : fallback;
}

function createRenderPlan(manifest, probe) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.source || !manifest.tracks) {
    throw new Error("成片配置无效或版本不受支持");
  }
  const sourceAsset = manifest.source.assets && manifest.source.assets.screen;
  const sourcePath = safeRelativePath(sourceAsset && sourceAsset.path);
  if (!isProjectRecordingAssetPath(sourcePath)) throw new Error("成片配置缺少项目内原始录制");
  const sourceDurationMs = Math.max(0, finite(manifest.source.durationMs, finite(probe && probe.durationMs, 0)));
  const timeMap = normalizeTimeMap(manifest.timeMap, sourceDurationMs);
  const retained = timeMap.segments.filter((segment) => !segment.deleted && segment.sourceEndMs > segment.sourceStartMs);
  if (!retained.length || timeMap.outputDurationMs <= 0) throw new Error("剪辑结果为空，无法导出成片");
  const probeWidth = even(probe && probe.width || 1920);
  const probeHeight = even(probe && probe.height || 1080);
  const ratio = parseRatio(manifest.source.ratio, probeWidth / probeHeight);
  let width = probeWidth;
  let height = even(width / ratio);
  if (height > probeHeight * 1.5) {
    height = probeHeight;
    width = even(height * ratio);
  }
  const appearance = manifest.appearance || {};
  return {
    projectId: manifest.projectId,
    editId: manifest.editId,
    sourcePath,
    outputPath: "exports/final.mp4",
    width,
    height,
    fps: clamp(finite(probe && probe.fps, 30), 15, 60),
    hasAudio: Boolean(probe && probe.hasAudio),
    timeMap,
    retained,
    outputDurationMs: timeMap.outputDurationMs,
    subtitles: mapSubtitles(manifest.tracks.subtitles && manifest.tracks.subtitles.segments, timeMap).slice(0, 500),
    camera: mapCameraTrack(manifest.tracks.camera, timeMap),
    cameraMotionMode: manifest.tracks.camera && manifest.tracks.camera.motionMode === "3d" ? "3d" : "2d",
    cursor: mapCursorTrack(manifest.tracks.cursor, manifest.source, timeMap),
    webcam: normalizeWebcamTrack(manifest.tracks.webcam, manifest.source),
    audio: manifest.tracks.audio || {},
    appearance: {
      background: /^#[0-9a-f]{6}$/i.test(appearance.background || "") ? appearance.background : "#17191d",
      padding: clamp(finite(appearance.padding, 0), 0, Math.min(width, height) / 4),
      cornerRadius: clamp(finite(appearance.cornerRadius, 0), 0, 100),
      shadow: appearance.shadow !== false,
    },
  };
}

function normalizeFilterInputs(value) {
  if (typeof value === "number") return { captionInputStartIndex: value };
  const input = value && typeof value === "object" ? value : {};
  return {
    captionInputStartIndex: Math.max(1, finite(input.captionInputStartIndex, 1)),
    cursorInputIndex: Number.isInteger(input.cursorInputIndex) ? input.cursorInputIndex : null,
    clickInputIndex: Number.isInteger(input.clickInputIndex) ? input.clickInputIndex : null,
    webcamInputIndex: Number.isInteger(input.webcamInputIndex) ? input.webcamInputIndex : null,
  };
}

function buildFilterGraph(plan, inputOptions) {
  const inputs = normalizeFilterInputs(inputOptions);
  const filters = [];
  const videoLabels = [];
  const audioLabels = [];
  plan.retained.forEach((segment, index) => {
    const start = (segment.sourceStartMs / 1000).toFixed(6);
    const end = (segment.sourceEndMs / 1000).toFixed(6);
    const rate = finite(segment.rate, 1);
    filters.push(`[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${rate.toFixed(8)}[v${index}]`);
    videoLabels.push(`[v${index}]`);
    if (plan.hasAudio) {
      const tempo = atempoFilters(rate);
      filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo.length ? `,${tempo.join(",")}` : ""}[a${index}]`);
      audioLabels.push(`[a${index}]`);
    }
  });
  if (plan.retained.length === 1) {
    filters.push(`[v0]null[vcat]`);
    if (plan.hasAudio) filters.push(`[a0]anull[acat]`);
  } else {
    const concatInputs = plan.retained.map((segment, index) => {
      return `[v${index}]${plan.hasAudio ? `[a${index}]` : ""}`;
    }).join("");
    filters.push(`${concatInputs}concat=n=${plan.retained.length}:v=1:a=${plan.hasAudio ? 1 : 0}[vcat]${plan.hasAudio ? "[acat]" : ""}`);
  }

  const width = plan.width;
  const height = plan.height;
  let videoLabel = "vcat";
  filters.push(`[${videoLabel}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[vfit]`);
  videoLabel = "vfit";
  if (plan.camera.length && plan.camera.some((frame) => frame.scale > 1.0001)) {
    const z = piecewiseExpression(plan.camera, "scale", `on/${plan.fps.toFixed(6)}`);
    const x = piecewiseExpression(plan.camera, "x", `on/${plan.fps.toFixed(6)}`);
    const y = piecewiseExpression(plan.camera, "y", `on/${plan.fps.toFixed(6)}`);
    filters.push(`[${videoLabel}]zoompan=z='${z}':x='max(0,min(iw-iw/zoom,iw*(${x})-iw/(2*zoom)))':y='max(0,min(ih-ih/zoom,ih*(${y})-ih/(2*zoom)))':d=1:s=${width}x${height}:fps=${plan.fps.toFixed(6)}[vcamera]`);
    videoLabel = "vcamera";
  }
  if (plan.cameraMotionMode === "3d" && plan.camera.some((frame) => Math.abs(frame.tiltX) > 0.001 || Math.abs(frame.tiltY) > 0.001)) {
    const pitch = `((${piecewiseExpression(plan.camera, "tiltX", `on/${plan.fps.toFixed(6)}`)})/12)`;
    const yaw = `((${piecewiseExpression(plan.camera, "tiltY", `on/${plan.fps.toFixed(6)}`)})/12)`;
    const overscanWidth = even(width * 1.14);
    const overscanHeight = even(height * 1.14);
    const x0 = `W*(0.005+max(0,${yaw})*0.025+max(0,${pitch})*0.018)`;
    const y0 = `H*(0.005+max(0,${yaw})*0.020+max(0,${pitch})*0.018)`;
    const x1 = `W*(0.995-max(0,-(${yaw}))*0.025-max(0,${pitch})*0.018)`;
    const y1 = `H*(0.005+max(0,-(${yaw}))*0.020+max(0,${pitch})*0.018)`;
    const x2 = `W*(0.005+max(0,${yaw})*0.025+max(0,-(${pitch}))*0.018)`;
    const y2 = `H*(0.995-max(0,${yaw})*0.020-max(0,-(${pitch}))*0.018)`;
    const x3 = `W*(0.995-max(0,-(${yaw}))*0.025-max(0,-(${pitch}))*0.018)`;
    const y3 = `H*(0.995-max(0,-(${yaw}))*0.020-max(0,-(${pitch}))*0.018)`;
    filters.push(`[${videoLabel}]scale=${overscanWidth}:${overscanHeight},perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':sense=destination:eval=frame:interpolation=cubic,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2[v3dcamera]`);
    videoLabel = "v3dcamera";
  }
  const padding = even(plan.appearance.padding);
  const radius = Math.round(plan.appearance.cornerRadius);
  if ((padding > 0 || radius > 0 || plan.appearance.shadow) && width - padding * 2 >= 2 && height - padding * 2 >= 2) {
    const innerWidth = even(width - padding * 2);
    const innerHeight = even(height - padding * 2);
    filters.push(`[${videoLabel}]scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=decrease,pad=${innerWidth}:${innerHeight}:(ow-iw)/2:(oh-ih)/2:color=black[vcontent]`);
    let contentLabel = "vcontent";
    if (radius > 0) {
      const safeRadius = Math.min(radius, Math.floor(Math.min(innerWidth, innerHeight) / 2));
      const alpha = `if(gt(lte(abs(X-W/2),W/2-${safeRadius})+lte(abs(Y-H/2),H/2-${safeRadius}),0),255,if(lte(hypot(abs(X-W/2)-(W/2-${safeRadius}),abs(Y-H/2)-(H/2-${safeRadius})),${safeRadius}),255,0))`;
      filters.push(`[${contentLabel}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[vrounded]`);
      contentLabel = "vrounded";
    } else {
      filters.push(`[${contentLabel}]format=rgba[vopaque]`);
      contentLabel = "vopaque";
    }
    filters.push(`color=c=${plan.appearance.background}:s=${width}x${height}:r=${plan.fps.toFixed(6)}:d=${(plan.outputDurationMs / 1000).toFixed(6)}[vbackground]`);
    if (plan.appearance.shadow) {
      filters.push(`[${contentLabel}]split=2[vforeground][vshadowbase]`);
      filters.push(`[vshadowbase]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.42,gblur=sigma=12[vshadow]`);
      filters.push(`[vbackground][vshadow]overlay=x=${padding + 6}:y=${padding + 8}:eof_action=pass:shortest=0[vwithshadow]`);
      filters.push(`[vwithshadow][vforeground]overlay=x=${padding}:y=${padding}:eof_action=pass:shortest=0[vstyled]`);
    } else {
      filters.push(`[vbackground][${contentLabel}]overlay=x=${padding}:y=${padding}:eof_action=pass:shortest=0[vstyled]`);
    }
    videoLabel = "vstyled";
  }

  if (plan.webcam.visible && inputs.webcamInputIndex !== null) {
    const webcamSegments = [];
    plan.retained.forEach((segment, index) => {
      const start = (segment.sourceStartMs / 1000).toFixed(6);
      const end = (segment.sourceEndMs / 1000).toFixed(6);
      const rate = finite(segment.rate, 1);
      filters.push(`[${inputs.webcamInputIndex}:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${rate.toFixed(8)}[w${index}]`);
      webcamSegments.push(`[w${index}]`);
    });
    if (webcamSegments.length === 1) filters.push(`[w0]null[wcat]`);
    else filters.push(`${webcamSegments.join("")}concat=n=${webcamSegments.length}:v=1:a=0[wcat]`);
    const webcamShape = webcamShapeGeometry(width, plan.webcam);
    filters.push(`[wcat]scale=${webcamShape.width}:${webcamShape.height}:force_original_aspect_ratio=increase,crop=${webcamShape.width}:${webcamShape.height},setsar=1${plan.webcam.mirror ? ",hflip" : ""}[wbox]`);
    filters.push(`[wbox]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedAlphaExpression(webcamShape.radius)}'[wready]`);
    const margin = Math.max(18, Math.round(width * 0.018));
    const webcamX = plan.webcam.position.endsWith("right") ? `main_w-overlay_w-${margin}` : String(margin);
    const webcamY = plan.webcam.position.startsWith("bottom") ? `main_h-overlay_h-${margin}` : String(margin);
    filters.push(`[${videoLabel}][wready]overlay=x=${webcamX}:y=${webcamY}:eof_action=pass:shortest=0[vwebcam]`);
    videoLabel = "vwebcam";
  }

  if (plan.cursor.visible && plan.cursor.events.length && inputs.cursorInputIndex !== null) {
    const x = piecewiseExpression(plan.cursor.events, "x", "t");
    const y = piecewiseExpression(plan.cursor.events, "y", "t");
    const start = (plan.cursor.events[0].timeMs / 1000).toFixed(6);
    const end = (plan.outputDurationMs / 1000).toFixed(6);
    filters.push(`[${inputs.cursorInputIndex}:v]format=rgba[cursorasset]`);
    filters.push(`[${videoLabel}][cursorasset]overlay=x='max(0,min(main_w-overlay_w,main_w*(${x})-4))':y='max(0,min(main_h-overlay_h,main_h*(${y})-4))':eval=frame:eof_action=repeat:shortest=0:enable='between(t,${start},${end})'[vcursor]`);
    videoLabel = "vcursor";
  }

  if (plan.cursor.clickEffect && plan.cursor.clicks.length && inputs.clickInputIndex !== null) {
    const clicks = plan.cursor.clicks;
    if (clicks.length === 1) filters.push(`[${inputs.clickInputIndex}:v]format=rgba[click0]`);
    else {
      const splitLabels = clicks.map((click, index) => `[click${index}]`).join("");
      filters.push(`[${inputs.clickInputIndex}:v]format=rgba,split=${clicks.length}${splitLabels}`);
    }
    clicks.forEach((click, index) => {
      const outputLabel = `vclick${index}`;
      const start = (click.timeMs / 1000).toFixed(6);
      const end = ((click.timeMs + 360) / 1000).toFixed(6);
      const x = `(main_w*${click.x.toFixed(6)}-overlay_w/2)`;
      const y = `(main_h*${click.y.toFixed(6)}-overlay_h/2)`;
      filters.push(`[${videoLabel}][click${index}]overlay=x='${x}':y='${y}':eof_action=repeat:shortest=0:enable='between(t,${start},${end})'[${outputLabel}]`);
      videoLabel = outputLabel;
    });
  }
  plan.subtitles.forEach((subtitle, index) => {
    const inputIndex = inputs.captionInputStartIndex + index;
    const outputLabel = `vsubtitle${index}`;
    const start = (subtitle.startMs / 1000).toFixed(6);
    const end = (subtitle.endMs / 1000).toFixed(6);
    filters.push(`[${videoLabel}][${inputIndex}:v]overlay=0:0:eof_action=repeat:shortest=0:enable='between(t,${start},${end})'[${outputLabel}]`);
    videoLabel = outputLabel;
  });
  filters.push(`[${videoLabel}]format=yuv420p[vout]`);

  let audioLabel = null;
  if (plan.hasAudio) {
    const audioFilters = [];
    const volume = plan.audio.muted ? 0 : clamp(finite(plan.audio.volume, 1), 0, 2);
    if (Math.abs(volume - 1) > 1e-6) audioFilters.push(`volume=${volume.toFixed(4)}`);
    const fadeIn = clamp(finite(plan.audio.fadeInMs, 0), 0, plan.outputDurationMs) / 1000;
    const fadeOut = clamp(finite(plan.audio.fadeOutMs, 0), 0, plan.outputDurationMs) / 1000;
    if (fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(4)}`);
    if (fadeOut > 0) {
      const start = Math.max(0, plan.outputDurationMs / 1000 - fadeOut);
      audioFilters.push(`afade=t=out:st=${start.toFixed(4)}:d=${fadeOut.toFixed(4)}`);
    }
    if (audioFilters.length) filters.push(`[acat]${audioFilters.join(",")}[aout]`);
    else filters.push(`[acat]anull[aout]`);
    audioLabel = "aout";
  }
  return { graph: filters.join(";"), videoLabel: "vout", audioLabel };
}

function videoEncoderArgs(encoder) {
  const selected = encoder || "h264_videotoolbox";
  if (selected === "libx264") {
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
  }
  if (selected === "h264_videotoolbox") {
    return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "8000k"];
  }
  return ["-c:v", selected, "-b:v", "8000k"];
}

function buildFfmpegArgs(plan, sourceAbsolutePath, captionPaths, outputTemporaryPath, overlayAssets, options) {
  const args = ["-hide_banner", "-loglevel", "warning", "-i", sourceAbsolutePath];
  let nextInputIndex = 1;
  const captionInputStartIndex = nextInputIndex;
  (captionPaths || []).forEach((captionPath) => {
    args.push("-loop", "1", "-i", captionPath);
    nextInputIndex += 1;
  });
  const assets = overlayAssets && typeof overlayAssets === "object" ? overlayAssets : {};
  let cursorInputIndex = null;
  let clickInputIndex = null;
  let webcamInputIndex = null;
  if (assets.cursorPath) {
    cursorInputIndex = nextInputIndex;
    args.push("-loop", "1", "-i", assets.cursorPath);
    nextInputIndex += 1;
  }
  if (assets.clickPath) {
    clickInputIndex = nextInputIndex;
    args.push("-loop", "1", "-i", assets.clickPath);
    nextInputIndex += 1;
  }
  if (assets.webcamPath) {
    webcamInputIndex = nextInputIndex;
    args.push("-i", assets.webcamPath);
    nextInputIndex += 1;
  }
  const graph = buildFilterGraph(plan, { captionInputStartIndex, cursorInputIndex, clickInputIndex, webcamInputIndex });
  args.push("-filter_complex", graph.graph, "-map", `[${graph.videoLabel}]`);
  if (graph.audioLabel) args.push("-map", `[${graph.audioLabel}]`, "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push(
    "-t", (plan.outputDurationMs / 1000).toFixed(6),
    "-r", plan.fps.toFixed(6),
    ...videoEncoderArgs(options && options.videoEncoder),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    outputTemporaryPath,
  );
  return args;
}

module.exports = {
  safeRelativePath,
  isProjectRecordingAssetPath,
  resolveProjectPath,
  normalizeTimeMap,
  sourceToOutput,
  mapSourceRange,
  mapSubtitles,
  mapCameraTrack,
  mapCursorTrack,
  normalizeWebcamTrack,
  normalizeWebcamShape,
  webcamShapeGeometry,
  piecewiseExpression,
  atempoFilters,
  createRenderPlan,
  buildFilterGraph,
  videoEncoderArgs,
  buildFfmpegArgs,
};
