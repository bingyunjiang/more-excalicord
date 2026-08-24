(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExcalicordEditorCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PROJECT_SCHEMA_VERSION = 2;
  var DEFAULT_SCENE_PATH = "scene.excalidraw";
  var DEFAULT_SCRIPT_PATH = "text/script.md";

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /* Keep a focused 16:9 slide inside the editor controls while making it fill
     the same safe area on every window size. The ratios match the visible
     canvas area in the desktop layout: menu/tool controls on the left/top and
     the Excalicord slide rail on the right remain outside the slide. */
  function calculateFrameFocusViewport(frameInput, viewportInput, optionsInput) {
    var frame = isObject(frameInput) ? frameInput : {};
    var viewport = isObject(viewportInput) ? viewportInput : {};
    var options = isObject(optionsInput) ? optionsInput : {};
    var safeArea = isObject(options.safeArea) ? options.safeArea : {};
    var viewportW = Math.max(400, finite(viewport.w, finite(viewport.width, 1280)));
    var viewportH = Math.max(300, finite(viewport.h, finite(viewport.height, 720)));
    var leftRatio = clamp(finite(safeArea.left, 0.14), 0, 0.4);
    var rightRatio = clamp(finite(safeArea.right, 0.11), 0, 0.4);
    var topRatio = clamp(finite(safeArea.top, 0.13), 0, 0.4);
    var bottomRatio = clamp(finite(safeArea.bottom, 0.08), 0, 0.4);
    var safeLeft = viewportW * leftRatio;
    var safeRight = viewportW * rightRatio;
    var safeTop = viewportH * topRatio;
    var safeBottom = viewportH * bottomRatio;
    var usableW = Math.max(1, viewportW - safeLeft - safeRight);
    var usableH = Math.max(1, viewportH - safeTop - safeBottom);
    var frameW = Math.max(1, finite(frame.width, 1600));
    var frameH = Math.max(1, finite(frame.height, 900));
    var minZoom = clamp(finite(options.minZoom, 0.12), 0.01, 1);
    var maxZoom = Math.max(minZoom, finite(options.maxZoom, 1));
    var zoom = clamp(Math.min(usableW / frameW, usableH / frameH), minZoom, maxZoom);
    var screenCenterX = safeLeft + usableW / 2;
    var screenCenterY = safeTop + usableH / 2;
    var frameCenterX = finite(frame.x, 0) + frameW / 2;
    var frameCenterY = finite(frame.y, 0) + frameH / 2;
    return {
      scrollX: screenCenterX / zoom - frameCenterX,
      scrollY: screenCenterY / zoom - frameCenterY,
      zoom: { value: zoom },
      selectedElementIds: {},
      selectedGroupIds: {},
      editingElement: null,
      showWelcomeScreen: false,
    };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    return String(prefix || "item") + "-" + Date.now().toString(36) + "-"
      + Math.random().toString(36).slice(2, 9);
  }

  function cleanId(value, prefix) {
    var text = typeof value === "string" ? value.trim() : "";
    if (text && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(text)) return text;
    return makeId(prefix);
  }

  function safeRelativePath(value, fallback) {
    var text = typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
    if (!text) return fallback || "";
    if (text.indexOf("\0") !== -1 || text.charAt(0) === "/" || /^[A-Za-z]:\//.test(text)) {
      return fallback || "";
    }
    var parts = text.split("/");
    var safe = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") return fallback || "";
      safe.push(part);
    }
    return safe.join("/") || (fallback || "");
  }

  function normalizeText(raw) {
    var source = isObject(raw) ? raw : {};
    var script = isObject(source.script) ? source.script : {};
    var transcript = isObject(source.transcript) ? source.transcript : {};
    var subtitles = isObject(source.subtitles) ? source.subtitles : {};
    return {
      script: {
        path: safeRelativePath(script.path, DEFAULT_SCRIPT_PATH),
        sourceText: typeof script.sourceText === "string" ? script.sourceText : "",
        updatedAt: typeof script.updatedAt === "string" ? script.updatedAt : "",
      },
      transcript: {
        raw: Array.isArray(transcript.raw) ? clone(transcript.raw) : [],
        corrected: Array.isArray(transcript.corrected) ? clone(transcript.corrected) : [],
        corrections: Array.isArray(transcript.corrections) ? clone(transcript.corrections) : [],
      },
      subtitles: {
        segments: Array.isArray(subtitles.segments) ? clone(subtitles.segments) : [],
      },
      dictionary: Array.isArray(source.dictionary) ? clone(source.dictionary) : [],
    };
  }

  function createProject(options) {
    var source = isObject(options) ? options : {};
    var createdAt = typeof source.createdAt === "string" ? source.createdAt : nowIso();
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      appVersion: typeof source.appVersion === "string" ? source.appVersion : "0.1.1",
      projectId: cleanId(source.projectId, "project"),
      createdAt: createdAt,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : createdAt,
      scene: {
        path: safeRelativePath(source.scenePath, DEFAULT_SCENE_PATH),
      },
      text: normalizeText(source.text),
      recordings: [],
      edits: [],
      activeRecordingId: "",
      activeEditId: "",
    };
  }

  function normalizeAsset(raw, fallbackKind) {
    if (!isObject(raw)) return null;
    var path = safeRelativePath(raw.path, "");
    if (!path) return null;
    return {
      path: path,
      kind: typeof raw.kind === "string" ? raw.kind : (fallbackKind || "media"),
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType
        : (typeof raw.type === "string" ? raw.type : "application/octet-stream"),
      durationMs: Math.max(0, finite(raw.durationMs, finite(raw.duration, 0) * 1000)),
      bytes: Math.max(0, finite(raw.bytes, 0)),
      baked: !!raw.baked,
    };
  }

  function createRecording(options) {
    var source = isObject(options) ? options : {};
    var assets = isObject(source.assets) ? source.assets : {};
    var createdAt = typeof source.createdAt === "string" ? source.createdAt : nowIso();
    return {
      id: cleanId(source.id, "recording"),
      createdAt: createdAt,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : createdAt,
      state: typeof source.state === "string" ? source.state : "ready",
      scope: typeof source.scope === "string" ? source.scope : "screen",
      ratio: typeof source.ratio === "string" ? source.ratio : "16:9",
      durationMs: Math.max(0, finite(source.durationMs, finite(source.duration, 0) * 1000)),
      assets: {
        screen: normalizeAsset(assets.screen, "screen"),
        webcam: normalizeAsset(assets.webcam, "webcam"),
        microphone: normalizeAsset(assets.microphone, "microphone"),
        systemAudio: normalizeAsset(assets.systemAudio, "system-audio"),
      },
      telemetry: {
        eventsPath: safeRelativePath(source.telemetry && source.telemetry.eventsPath, ""),
        sessionPath: safeRelativePath(source.telemetry && source.telemetry.sessionPath, ""),
      },
      legacyComposite: !!source.legacyComposite,
      embeddedSession: isObject(source.embeddedSession) ? clone(source.embeddedSession) : null,
      embeddedEvents: Array.isArray(source.embeddedEvents) ? clone(source.embeddedEvents) : [],
    };
  }

  function normalizeCuts(cuts, durationMs) {
    var max = Math.max(0, finite(durationMs, 0));
    var normalized = [];
    (Array.isArray(cuts) ? cuts : []).forEach(function (raw) {
      if (!isObject(raw) || raw.enabled === false) return;
      var start = clamp(finite(raw.startMs, finite(raw.start, 0) * 1000), 0, max);
      var end = clamp(finite(raw.endMs, finite(raw.end, 0) * 1000), 0, max);
      if (end <= start) return;
      normalized.push({
        id: cleanId(raw.id, "cut"),
        startMs: start,
        endMs: end,
        enabled: true,
        reason: typeof raw.reason === "string" ? raw.reason : "",
        origin: typeof raw.origin === "string" ? raw.origin : "manual",
        suggestionId: typeof raw.suggestionId === "string" ? raw.suggestionId : "",
      });
    });
    normalized.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    var merged = [];
    normalized.forEach(function (cut) {
      var previous = merged[merged.length - 1];
      if (previous && cut.startMs <= previous.endMs) {
        previous.endMs = Math.max(previous.endMs, cut.endMs);
        if (!previous.reason && cut.reason) previous.reason = cut.reason;
        return;
      }
      merged.push(cut);
    });
    return merged;
  }

  function normalizeSpeedRegions(regions, durationMs) {
    var max = Math.max(0, finite(durationMs, 0));
    var normalized = [];
    (Array.isArray(regions) ? regions : []).forEach(function (raw) {
      if (!isObject(raw) || raw.enabled === false) return;
      var start = clamp(finite(raw.startMs, finite(raw.start, 0) * 1000), 0, max);
      var end = clamp(finite(raw.endMs, finite(raw.end, 0) * 1000), 0, max);
      var rate = clamp(finite(raw.rate, 1), 0.1, 16);
      if (end <= start || Math.abs(rate - 1) < 0.000001) return;
      normalized.push({
        id: cleanId(raw.id, "speed"),
        startMs: start,
        endMs: end,
        rate: rate,
        enabled: true,
      });
    });
    normalized.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    var disjoint = [];
    normalized.forEach(function (region) {
      var previous = disjoint[disjoint.length - 1];
      if (previous && region.startMs < previous.endMs) region.startMs = previous.endMs;
      if (region.endMs > region.startMs) disjoint.push(region);
    });
    return disjoint;
  }

  function normalizeTimeline(raw, durationMs) {
    var source = isObject(raw) ? raw : {};
    var duration = Math.max(0, finite(durationMs, finite(source.durationMs, 0)));
    return {
      durationMs: duration,
      cuts: normalizeCuts(source.cuts, duration),
      speedRegions: normalizeSpeedRegions(source.speedRegions, duration),
    };
  }

  function normalizeSubtitleSegments(segments, durationMs) {
    var max = Math.max(0, finite(durationMs, 0));
    var output = [];
    (Array.isArray(segments) ? segments : []).forEach(function (raw, index) {
      if (!isObject(raw)) return;
      var startMs = Math.max(0, finite(raw.startMs, finite(raw.start, 0) * 1000));
      var endMs = Math.max(0, finite(raw.endMs, finite(raw.end, 0) * 1000));
      if (max) {
        startMs = clamp(startMs, 0, max);
        endMs = clamp(endMs, 0, max);
      }
      var text = typeof raw.text === "string" ? raw.text.replace(/\r/g, "").trim() : "";
      if (!text || endMs <= startMs) return;
      output.push({
        id: cleanId(raw.id, "subtitle"),
        startMs: startMs,
        endMs: endMs,
        text: text.slice(0, 4000),
        style: typeof raw.style === "string" ? raw.style : "default",
        source: typeof raw.source === "string" ? raw.source : "manual",
        index: Number.isFinite(Number(raw.index)) ? Number(raw.index) : index,
      });
    });
    output.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    return output;
  }

  function createEdit(options) {
    var source = isObject(options) ? options : {};
    var createdAt = typeof source.createdAt === "string" ? source.createdAt : nowIso();
    var durationMs = Math.max(0, finite(source.durationMs, 0));
    var transcript = isObject(source.transcript) ? source.transcript : {};
    var subtitles = isObject(source.subtitles) ? source.subtitles : {};
    var camera = isObject(source.camera) ? source.camera : {};
    var cursor = isObject(source.cursor) ? source.cursor : {};
    var webcam = isObject(source.webcam) ? source.webcam : {};
    return {
      id: cleanId(source.id, "edit"),
      recordingId: typeof source.recordingId === "string" ? source.recordingId : "",
      createdAt: createdAt,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : createdAt,
      timeline: normalizeTimeline(source.timeline, durationMs),
      transcript: {
        rawPath: safeRelativePath(transcript.rawPath, ""),
        correctedPath: safeRelativePath(transcript.correctedPath, ""),
        correctionsPath: safeRelativePath(transcript.correctionsPath, ""),
        status: typeof transcript.status === "string" ? transcript.status : "empty",
        embedded: isObject(transcript.embedded) ? clone(transcript.embedded) : null,
        embeddedCorrected: isObject(transcript.embeddedCorrected) ? clone(transcript.embeddedCorrected) : null,
        corrections: Array.isArray(transcript.corrections) ? clone(transcript.corrections) : [],
      },
      subtitles: {
        path: safeRelativePath(subtitles.path, ""),
        segments: normalizeSubtitleSegments(subtitles.segments, durationMs),
        style: isObject(subtitles.style) ? clone(subtitles.style) : {},
      },
      camera: {
        enabled: camera.enabled !== false,
        slideFocus: camera.slideFocus !== false,
        mouseFocus: camera.mouseFocus !== false,
        clickFocus: camera.clickFocus !== false,
        typingFocus: camera.typingFocus !== false,
        motionMode: camera.motionMode === "3d" ? "3d" : "2d",
        speed: typeof camera.speed === "string" ? camera.speed : "standard",
        strength: typeof camera.strength === "string" ? camera.strength : "gentle",
        keyframes: Array.isArray(camera.keyframes) ? clone(camera.keyframes) : [],
      },
      cursor: {
        visible: cursor.visible !== false,
        size: clamp(finite(cursor.size, 1), 0.25, 4),
        color: /^#[0-9a-f]{6}$/i.test(cursor.color || "") ? cursor.color : "#ef4444",
        smoothing: clamp(finite(cursor.smoothing, 0.55), 0, 1),
        clickEffect: cursor.clickEffect !== false,
        highlightStyle: typeof cursor.highlightStyle === "string" ? cursor.highlightStyle : "halo",
        pointerShape: typeof cursor.pointerShape === "string" ? cursor.pointerShape : "system",
        sound: typeof cursor.sound === "string" ? cursor.sound : "off",
        hiddenRanges: Array.isArray(cursor.hiddenRanges) ? clone(cursor.hiddenRanges) : [],
      },
      webcam: {
        visible: webcam.visible !== false,
        position: typeof webcam.position === "string" ? webcam.position : "bottom-right",
        x: clamp(finite(webcam.x, 0.82), 0, 1),
        y: clamp(finite(webcam.y, 0.82), 0, 1),
        scale: clamp(finite(webcam.scale, 0.2), 0.05, 1),
        shape: typeof webcam.shape === "string" ? webcam.shape : "rounded",
        mirror: webcam.mirror !== false,
        screenLightEnabled: webcam.screenLightEnabled === true,
        screenLightIntensity: clamp(finite(webcam.screenLightIntensity, 0.85), 0, 1),
      },
      annotations: Array.isArray(source.annotations) ? clone(source.annotations) : [],
      audio: isObject(source.audio) ? clone(source.audio) : {},
      appearance: isObject(source.appearance) ? clone(source.appearance) : {},
      exportPresets: isObject(source.exportPresets) ? clone(source.exportPresets) : {},
      suggestions: Array.isArray(source.suggestions) ? clone(source.suggestions) : [],
    };
  }

  function migrateV1(raw) {
    var project = createProject({
      projectId: raw.projectId,
      updatedAt: raw.updatedAt,
      text: raw.text,
    });
    var recordingState = isObject(raw.recording) ? raw.recording : {};
    var media = Array.isArray(recordingState.media) ? recordingState.media : [];
    media.forEach(function (item, index) {
      if (!isObject(item)) return;
      var path = safeRelativePath(item.path, "");
      if (!path) return;
      var durationMs = Math.max(0, finite(item.duration, 0) * 1000);
      var webcamPath = safeRelativePath(item.webcamPath, "");
      var hasWebcam = Boolean(webcamPath);
      var webcamCompositeBaked = item.webcamCompositeBaked === true;
      var recording = createRecording({
        id: "legacy-recording-" + String(index + 1),
        createdAt: item.recordedAt,
        scope: recordingState.scope,
        ratio: recordingState.ratio,
        durationMs: durationMs,
        legacyComposite: !hasWebcam || webcamCompositeBaked,
        assets: {
          screen: {
            path: path,
            kind: hasWebcam && !webcamCompositeBaked ? "screen" : "composite",
            type: item.type,
            durationMs: durationMs,
            baked: !hasWebcam || webcamCompositeBaked,
          },
          webcam: hasWebcam ? {
            path: webcamPath,
            kind: "webcam",
            type: item.webcamType || "video/webm",
            durationMs: Math.max(0, finite(item.webcamDuration, finite(item.duration, 0)) * 1000),
            baked: false,
          } : null,
        },
        embeddedSession: index === media.length - 1 ? raw.session : null,
        embeddedEvents: index === media.length - 1 ? raw.events : [],
      });
      project.recordings.push(recording);
    });
    if (!project.recordings.length && (isObject(raw.session)
      || (Array.isArray(raw.events) && raw.events.length > 0))) {
      project.recordings.push(createRecording({
        id: "legacy-recording-metadata",
        state: "metadata-only",
        scope: recordingState.scope,
        ratio: recordingState.ratio,
        durationMs: Math.max(0, finite(recordingState.duration, 0) * 1000),
        legacyComposite: true,
        embeddedSession: raw.session,
        embeddedEvents: raw.events,
      }));
    }
    if (project.recordings.length) {
      var activeRecording = project.recordings[project.recordings.length - 1];
      project.activeRecordingId = activeRecording.id;
      var legacyEdits = isObject(raw.edits) ? raw.edits : {};
      var legacyText = normalizeText(raw.text);
      var edit = createEdit({
        id: "legacy-edit-1",
        recordingId: activeRecording.id,
        durationMs: activeRecording.durationMs,
        timeline: { cuts: legacyEdits.cuts || [], speedRegions: legacyEdits.speedRegions || [] },
        subtitles: { segments: legacyText.subtitles.segments },
        camera: legacyEdits.camera,
        cursor: legacyEdits.cursor,
        webcam: legacyEdits.webcam,
        annotations: legacyEdits.annotations,
        audio: legacyEdits.audio,
        appearance: legacyEdits.appearance,
      });
      project.edits.push(edit);
      project.activeEditId = edit.id;
    }
    return project;
  }

  function normalizeProject(raw) {
    if (!isObject(raw)) return createProject();
    if (raw.schemaVersion === 1 || raw.schemaVersion == null) return migrateV1(raw);
    if (raw.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      throw new Error("Unsupported project schema: " + String(raw.schemaVersion));
    }
    var project = createProject({
      appVersion: raw.appVersion,
      projectId: raw.projectId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      scenePath: raw.scene && raw.scene.path,
      text: raw.text,
    });
    project.recordings = (Array.isArray(raw.recordings) ? raw.recordings : []).map(function (item) {
      return createRecording(item);
    });
    var recordingById = {};
    project.recordings.forEach(function (item) { recordingById[item.id] = item; });
    project.edits = (Array.isArray(raw.edits) ? raw.edits : []).map(function (item) {
      var recording = recordingById[item && item.recordingId];
      return createEdit(Object.assign({}, item, {
        durationMs: recording ? recording.durationMs : finite(item && item.timeline && item.timeline.durationMs, 0),
      }));
    }).filter(function (item) { return !!recordingById[item.recordingId]; });
    project.activeRecordingId = recordingById[raw.activeRecordingId]
      ? raw.activeRecordingId
      : (project.recordings.length ? project.recordings[project.recordings.length - 1].id : "");
    var editById = {};
    project.edits.forEach(function (item) { editById[item.id] = item; });
    project.activeEditId = editById[raw.activeEditId]
      ? raw.activeEditId
      : (project.edits.length ? project.edits[project.edits.length - 1].id : "");
    return project;
  }

  function buildTimeMap(timeline) {
    var normalized = normalizeTimeline(timeline, timeline && timeline.durationMs);
    var boundaries = [0, normalized.durationMs];
    normalized.cuts.forEach(function (item) { boundaries.push(item.startMs, item.endMs); });
    normalized.speedRegions.forEach(function (item) { boundaries.push(item.startMs, item.endMs); });
    boundaries.sort(function (a, b) { return a - b; });
    boundaries = boundaries.filter(function (value, index) {
      return index === 0 || Math.abs(value - boundaries[index - 1]) > 0.0001;
    });
    var outputCursor = 0;
    var segments = [];
    for (var i = 0; i < boundaries.length - 1; i += 1) {
      var start = boundaries[i];
      var end = boundaries[i + 1];
      if (end <= start) continue;
      var middle = start + (end - start) / 2;
      var deleted = normalized.cuts.some(function (cut) {
        return middle >= cut.startMs && middle < cut.endMs;
      });
      var rate = 1;
      normalized.speedRegions.some(function (region) {
        if (middle >= region.startMs && middle < region.endMs) {
          rate = region.rate;
          return true;
        }
        return false;
      });
      var outputDuration = deleted ? 0 : (end - start) / rate;
      segments.push({
        sourceStartMs: start,
        sourceEndMs: end,
        outputStartMs: outputCursor,
        outputEndMs: outputCursor + outputDuration,
        rate: rate,
        deleted: deleted,
      });
      outputCursor += outputDuration;
    }
    return {
      sourceDurationMs: normalized.durationMs,
      outputDurationMs: outputCursor,
      segments: segments,
    };
  }

  function sourceToOutput(timeMap, sourceTimeMs) {
    var map = timeMap && Array.isArray(timeMap.segments) ? timeMap : { segments: [] };
    var source = clamp(finite(sourceTimeMs, 0), 0, Math.max(0, finite(map.sourceDurationMs, 0)));
    for (var i = 0; i < map.segments.length; i += 1) {
      var segment = map.segments[i];
      var isLast = i === map.segments.length - 1;
      if (source >= segment.sourceStartMs && (source < segment.sourceEndMs || (isLast && source <= segment.sourceEndMs))) {
        if (segment.deleted) {
          return { timeMs: segment.outputStartMs, deleted: true, segmentIndex: i };
        }
        return {
          timeMs: segment.outputStartMs + (source - segment.sourceStartMs) / segment.rate,
          deleted: false,
          segmentIndex: i,
        };
      }
    }
    return { timeMs: Math.max(0, finite(map.outputDurationMs, 0)), deleted: false, segmentIndex: -1 };
  }

  function outputToSource(timeMap, outputTimeMs) {
    var map = timeMap && Array.isArray(timeMap.segments) ? timeMap : { segments: [] };
    var output = clamp(finite(outputTimeMs, 0), 0, Math.max(0, finite(map.outputDurationMs, 0)));
    var retained = map.segments.filter(function (segment) { return !segment.deleted; });
    for (var i = 0; i < retained.length; i += 1) {
      var segment = retained[i];
      var isLast = i === retained.length - 1;
      if (output >= segment.outputStartMs && (output < segment.outputEndMs || (isLast && output <= segment.outputEndMs))) {
        return {
          timeMs: segment.sourceStartMs + (output - segment.outputStartMs) * segment.rate,
          segment: segment,
        };
      }
    }
    return { timeMs: Math.max(0, finite(map.sourceDurationMs, 0)), segment: null };
  }

  function mapSourceRange(timeMap, startMs, endMs) {
    var start = Math.max(0, finite(startMs, 0));
    var end = Math.max(start, finite(endMs, start));
    var mapped = [];
    (timeMap && Array.isArray(timeMap.segments) ? timeMap.segments : []).forEach(function (segment) {
      if (segment.deleted) return;
      var sourceStart = Math.max(start, segment.sourceStartMs);
      var sourceEnd = Math.min(end, segment.sourceEndMs);
      if (sourceEnd <= sourceStart) return;
      mapped.push({
        sourceStartMs: sourceStart,
        sourceEndMs: sourceEnd,
        outputStartMs: segment.outputStartMs + (sourceStart - segment.sourceStartMs) / segment.rate,
        outputEndMs: segment.outputStartMs + (sourceEnd - segment.sourceStartMs) / segment.rate,
        rate: segment.rate,
      });
    });
    return mapped;
  }

  function addCut(timeline, startMs, endMs, metadata) {
    var source = normalizeTimeline(timeline, timeline && timeline.durationMs);
    var extra = isObject(metadata) ? metadata : {};
    source.cuts.push({
      id: cleanId(extra.id, "cut"),
      startMs: startMs,
      endMs: endMs,
      enabled: true,
      reason: typeof extra.reason === "string" ? extra.reason : "",
      origin: typeof extra.origin === "string" ? extra.origin : "manual",
      suggestionId: typeof extra.suggestionId === "string" ? extra.suggestionId : "",
    });
    source.cuts = normalizeCuts(source.cuts, source.durationMs);
    return source;
  }

  function removeCut(timeline, cutId) {
    var source = normalizeTimeline(timeline, timeline && timeline.durationMs);
    source.cuts = source.cuts.filter(function (item) { return item.id !== cutId; });
    return source;
  }

  function validateProject(raw) {
    var errors = [];
    var warnings = [];
    var project;
    try {
      project = normalizeProject(raw);
    } catch (error) {
      errors.push(error.message || String(error));
      return { valid: false, errors: errors, warnings: warnings, project: null };
    }
    var seen = {};
    project.recordings.forEach(function (recording) {
      if (seen[recording.id]) errors.push("Duplicate recording id: " + recording.id);
      seen[recording.id] = true;
      if (!recording.assets.screen) warnings.push("Recording has no screen asset: " + recording.id);
    });
    project.edits.forEach(function (edit) {
      if (!seen[edit.recordingId]) errors.push("Edit references missing recording: " + edit.id);
    });
    return { valid: errors.length === 0, errors: errors, warnings: warnings, project: project };
  }

  function projectV2ToLegacyRuntime(projectInput) {
    var project = normalizeProject(projectInput);
    var recording = project.recordings.find(function (item) {
      return item.id === project.activeRecordingId;
    }) || (project.recordings.length ? project.recordings[project.recordings.length - 1] : null);
    var edit = project.edits.find(function (item) {
      return item.id === project.activeEditId;
    }) || (project.edits.length ? project.edits[project.edits.length - 1] : null);
    var legacyText = clone(project.text);
    if (edit) {
      legacyText.subtitles.segments = edit.subtitles.segments.map(function (segment) {
        return Object.assign({}, clone(segment), {
          start: segment.startMs / 1000,
          end: segment.endMs / 1000,
        });
      });
    }
    return {
      schemaVersion: 1,
      projectId: project.projectId,
      updatedAt: project.updatedAt,
      recording: {
        scope: recording ? recording.scope : "screen",
        ratio: recording ? recording.ratio : "16:9",
        duration: recording ? recording.durationMs / 1000 : 0,
        media: project.recordings.map(function (item) {
          var asset = item.assets.screen;
          var webcam = item.assets.webcam;
          if (!asset) return null;
          var media = {
            path: asset.path,
            type: asset.mimeType,
            recordedAt: item.createdAt,
            duration: item.durationMs / 1000,
          };
          if (webcam && webcam.path) {
            media.webcamPath = webcam.path;
            media.webcamType = webcam.mimeType;
            media.webcamDuration = (webcam.durationMs || item.durationMs) / 1000;
            media.webcamCompositeBaked = item.legacyComposite === true;
          }
          return media;
        }).filter(Boolean),
      },
      session: recording ? clone(recording.embeddedSession) : null,
      events: recording ? clone(recording.embeddedEvents) : [],
      text: legacyText,
      edits: {
        cuts: edit ? edit.timeline.cuts.map(function (cut) {
          return Object.assign({}, clone(cut), { start: cut.startMs / 1000, end: cut.endMs / 1000 });
        }) : [],
        speedRegions: edit ? edit.timeline.speedRegions.map(function (region) {
          return Object.assign({}, clone(region), { start: region.startMs / 1000, end: region.endMs / 1000 });
        }) : [],
        camera: edit ? clone(edit.camera) : { enabled: false, slideFocus: true, mouseFocus: true, clickFocus: true, typingFocus: true, motionMode: "2d", strength: "gentle", keyframes: [] },
        cursor: edit ? Object.assign({ highlight: edit.cursor.visible !== false }, clone(edit.cursor)) : { highlight: true },
        webcam: edit ? clone(edit.webcam) : {},
        annotations: edit ? clone(edit.annotations) : [],
        audio: edit ? clone(edit.audio) : {},
        appearance: edit ? clone(edit.appearance) : {},
      },
    };
  }

  function mergeLegacyRuntimeIntoProjectV2(projectInput, legacyInput) {
    var legacy = isObject(legacyInput) ? legacyInput : {};
    var project;
    try {
      project = normalizeProject(projectInput);
    } catch (error) {
      project = normalizeProject(legacy);
    }
    var legacyText = normalizeText(legacy.text);
    project.text = legacyText;
    var recordingState = isObject(legacy.recording) ? legacy.recording : {};
    var legacyMedia = Array.isArray(recordingState.media) ? recordingState.media : [];
    var lastLegacyRecording = null;
    legacyMedia.forEach(function (media, index) {
      if (!isObject(media)) return;
      var path = safeRelativePath(media.path, "");
      if (!path) return;
      var existing = project.recordings.find(function (item) {
        return item.assets.screen && item.assets.screen.path === path;
      });
      var durationMs = Math.max(0, finite(media.duration, 0) * 1000);
      var mediaScope = typeof media.scope === "string" ? media.scope : recordingState.scope;
      var mediaRatio = typeof media.ratio === "string" ? media.ratio : recordingState.ratio;
      if (!existing) {
        var webcamPath = safeRelativePath(media.webcamPath, "");
        var hasWebcam = Boolean(webcamPath);
        var webcamCompositeBaked = media.webcamCompositeBaked === true;
        existing = createRecording({
          id: "recording-" + String(project.recordings.length + index + 1),
          createdAt: media.recordedAt,
          scope: mediaScope,
          ratio: mediaRatio,
          durationMs: durationMs,
          legacyComposite: !hasWebcam || webcamCompositeBaked,
          assets: {
            screen: {
              path: path,
              kind: hasWebcam && !webcamCompositeBaked ? "screen" : "composite",
              type: media.type,
              durationMs: durationMs,
              baked: !hasWebcam || webcamCompositeBaked,
            },
            webcam: hasWebcam ? {
              path: webcamPath,
              kind: "webcam",
              type: media.webcamType || "video/webm",
              durationMs: Math.max(0, finite(media.webcamDuration, finite(media.duration, 0)) * 1000),
              baked: false,
            } : null,
          },
        });
        project.recordings.push(existing);
      } else {
        existing.scope = typeof mediaScope === "string" ? mediaScope : existing.scope;
        existing.ratio = typeof mediaRatio === "string" ? mediaRatio : existing.ratio;
        if (durationMs) existing.durationMs = durationMs;
        var existingWebcamPath = safeRelativePath(media.webcamPath, "");
        if (existingWebcamPath) {
          existing.assets.webcam = {
            path: existingWebcamPath,
            kind: "webcam",
            type: media.webcamType || "video/webm",
            durationMs: Math.max(0, finite(media.webcamDuration, finite(media.duration, 0)) * 1000),
            baked: false,
          };
          if (media.webcamCompositeBaked === true) {
            existing.legacyComposite = true;
            if (existing.assets.screen) {
              existing.assets.screen.kind = "composite";
              existing.assets.screen.baked = true;
            }
          }
        }
      }
      lastLegacyRecording = existing;
    });

    /* The recorder's media list is chronological and its final entry is the
     * session that just finished. Prefer it over a stale active id from a
     * metadata-only autosave made while recording was still in progress. */
    if (lastLegacyRecording) {
      var currentSessionId = isObject(legacy.session) && typeof legacy.session.id === "string"
        ? legacy.session.id
        : "";
      var removedRecordingIds = {};
      project.recordings = project.recordings.filter(function (item) {
        if (item === lastLegacyRecording || item.state !== "metadata-only" || (item.assets && item.assets.screen)) {
          return true;
        }
        var embeddedId = item.embeddedSession && typeof item.embeddedSession.id === "string"
          ? item.embeddedSession.id
          : "";
        var isCurrentPlaceholder = item.id === "legacy-recording-metadata"
          || (currentSessionId && embeddedId === currentSessionId);
        if (isCurrentPlaceholder) removedRecordingIds[item.id] = true;
        return !isCurrentPlaceholder;
      });
      if (Object.keys(removedRecordingIds).length) {
        project.edits = project.edits.filter(function (item) {
          return !removedRecordingIds[item.recordingId];
        });
      }
    }

    var activeRecording = lastLegacyRecording || project.recordings.find(function (item) {
      return item.id === project.activeRecordingId;
    }) || (project.recordings.length ? project.recordings[project.recordings.length - 1] : null);
    if (activeRecording) {
      activeRecording.embeddedSession = isObject(legacy.session) ? clone(legacy.session) : activeRecording.embeddedSession;
      activeRecording.embeddedEvents = Array.isArray(legacy.events) ? clone(legacy.events) : activeRecording.embeddedEvents;
      activeRecording.updatedAt = nowIso();
      project.activeRecordingId = activeRecording.id;
      var activeEdit = project.edits.find(function (item) {
        return item.recordingId === activeRecording.id && item.id === project.activeEditId;
      }) || project.edits.find(function (item) { return item.recordingId === activeRecording.id; });
      var legacyEdits = isObject(legacy.edits) ? legacy.edits : {};
      if (!activeEdit) {
        activeEdit = createEdit({
          id: "edit-" + String(project.edits.length + 1),
          recordingId: activeRecording.id,
          durationMs: activeRecording.durationMs,
        });
        project.edits.push(activeEdit);
      }
      activeEdit.timeline = normalizeTimeline({
        durationMs: activeRecording.durationMs,
        cuts: Array.isArray(legacyEdits.cuts) ? legacyEdits.cuts : activeEdit.timeline.cuts,
        speedRegions: Array.isArray(legacyEdits.speedRegions) ? legacyEdits.speedRegions : activeEdit.timeline.speedRegions,
      }, activeRecording.durationMs);
      if (isObject(legacyEdits.camera)) {
        activeEdit.camera = {
          enabled: legacyEdits.camera.enabled !== false,
          slideFocus: legacyEdits.camera.slideFocus !== false,
          mouseFocus: legacyEdits.camera.mouseFocus !== false,
          clickFocus: legacyEdits.camera.clickFocus !== false,
          typingFocus: legacyEdits.camera.typingFocus !== false,
          motionMode: legacyEdits.camera.motionMode === "3d" ? "3d" : "2d",
          speed: typeof legacyEdits.camera.speed === "string"
            ? legacyEdits.camera.speed
            : activeEdit.camera.speed,
          strength: typeof legacyEdits.camera.strength === "string"
            ? legacyEdits.camera.strength
            : activeEdit.camera.strength,
          keyframes: Array.isArray(legacyEdits.camera.keyframes) ? clone(legacyEdits.camera.keyframes) : [],
        };
      }
      if (isObject(legacyEdits.cursor)) {
        activeEdit.cursor = Object.assign({}, activeEdit.cursor, clone(legacyEdits.cursor));
      }
      if (isObject(legacyEdits.webcam)) {
        activeEdit.webcam = Object.assign({}, activeEdit.webcam, clone(legacyEdits.webcam));
      }
      activeEdit.annotations = Array.isArray(legacyEdits.annotations) ? clone(legacyEdits.annotations) : activeEdit.annotations;
      activeEdit.audio = isObject(legacyEdits.audio) ? clone(legacyEdits.audio) : activeEdit.audio;
      activeEdit.appearance = isObject(legacyEdits.appearance) ? clone(legacyEdits.appearance) : activeEdit.appearance;
      activeEdit.subtitles.segments = normalizeSubtitleSegments(
        legacyText.subtitles.segments,
        activeRecording.durationMs
      );
      activeEdit.updatedAt = nowIso();
      project.activeEditId = activeEdit.id;
    }
    project.updatedAt = nowIso();
    return normalizeProject(project);
  }

  function createCompositionManifest(projectInput, editId) {
    var project = normalizeProject(projectInput);
    var targetEditId = editId || project.activeEditId;
    var edit = project.edits.find(function (item) { return item.id === targetEditId; });
    if (!edit) throw new Error("Edit not found: " + String(targetEditId || "none"));
    var recording = project.recordings.find(function (item) { return item.id === edit.recordingId; });
    if (!recording) throw new Error("Recording not found for edit: " + edit.id);
    return {
      schemaVersion: 1,
      projectId: project.projectId,
      editId: edit.id,
      recordingId: recording.id,
      source: clone(recording),
      timeline: clone(edit.timeline),
      timeMap: buildTimeMap(edit.timeline),
      tracks: {
        transcript: clone(edit.transcript),
        subtitles: clone(edit.subtitles),
        camera: clone(edit.camera),
        cursor: clone(edit.cursor),
        webcam: clone(edit.webcam),
        annotations: clone(edit.annotations),
        audio: clone(edit.audio),
      },
      appearance: clone(edit.appearance),
      exportPresets: clone(edit.exportPresets),
    };
  }

  function projectRootFingerprint(folder) {
    if (!isObject(folder)) return "";
    var mode = folder.mode === "native" ? "native" : folder.mode === "browser" ? "browser" : "";
    if (!mode) return "";
    var identity = mode === "native" ? folder.path : (folder.identity || folder.name);
    identity = String(identity || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!identity) return "";
    var input = mode + ":" + identity.normalize("NFC");
    var hash = 2166136261;
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return mode + ":" + (hash >>> 0).toString(16).padStart(8, "0");
  }

  function createBoundProjectCache(projectInput, rootFingerprint) {
    var fingerprint = String(rootFingerprint || "");
    if (!fingerprint) throw new Error("Project cache requires a root fingerprint");
    return {
      cacheVersion: 1,
      rootFingerprint: fingerprint,
      project: normalizeProject(projectInput),
    };
  }

  function readBoundProjectCache(cacheInput, rootFingerprint) {
    if (!isObject(cacheInput) || cacheInput.cacheVersion !== 1) return null;
    if (!rootFingerprint || cacheInput.rootFingerprint !== rootFingerprint) return null;
    if (!isObject(cacheInput.project)) return null;
    return normalizeProject(cacheInput.project);
  }

  function activeRecordingAssetPath(projectInput) {
    var project = normalizeProject(projectInput);
    var edit = project.edits.find(function (item) { return item.id === project.activeEditId; });
    if (!edit) return "";
    var recording = project.recordings.find(function (item) { return item.id === edit.recordingId; });
    var screen = recording && recording.assets && recording.assets.screen;
    return screen && screen.path ? safeRelativePath(screen.path, "") : "";
  }

  function canOpenEditorProject(projectInput, verifiedPaths, hasMemoryBlob) {
    if (hasMemoryBlob) return true;
    var path = activeRecordingAssetPath(projectInput);
    return !!(path && isObject(verifiedPaths) && verifiedPaths[path] === true);
  }

  return {
    PROJECT_SCHEMA_VERSION: PROJECT_SCHEMA_VERSION,
    DEFAULT_SCENE_PATH: DEFAULT_SCENE_PATH,
    DEFAULT_SCRIPT_PATH: DEFAULT_SCRIPT_PATH,
    calculateFrameFocusViewport: calculateFrameFocusViewport,
    safeRelativePath: safeRelativePath,
    createProject: createProject,
    createRecording: createRecording,
    createEdit: createEdit,
    migrateV1: migrateV1,
    normalizeProject: normalizeProject,
    normalizeTimeline: normalizeTimeline,
    normalizeSubtitleSegments: normalizeSubtitleSegments,
    buildTimeMap: buildTimeMap,
    sourceToOutput: sourceToOutput,
    outputToSource: outputToSource,
    mapSourceRange: mapSourceRange,
    addCut: addCut,
    removeCut: removeCut,
    validateProject: validateProject,
    projectV2ToLegacyRuntime: projectV2ToLegacyRuntime,
    mergeLegacyRuntimeIntoProjectV2: mergeLegacyRuntimeIntoProjectV2,
    createCompositionManifest: createCompositionManifest,
    projectRootFingerprint: projectRootFingerprint,
    createBoundProjectCache: createBoundProjectCache,
    readBoundProjectCache: readBoundProjectCache,
    activeRecordingAssetPath: activeRecordingAssetPath,
    canOpenEditorProject: canOpenEditorProject,
  };
});
