/* Excalicord-local: whiteboard recorder studio for local Excalidraw (localhost:5001)
 * Implements the core excalicord.com feature set:
 *   - draggable/resizable camera bubble (circle / rounded / pill, mirror, size)
 *   - beauty filters (smoothing, whitening) applied via canvas
 *   - record controls (start / pause / resume / stop, timer)
 *   - export WebM / MP4 via MediaRecorder (screen + optional composited camera)
 *   - teleprompter (draggable panel, auto-scroll, speed/font/opacity, Space toggle)
 *   - aspect-ratio presets, background color, slide hinting
 * Pure vanilla JS + Shadow DOM. No dependency on the React app internals.
 */
(function () {
  "use strict";
  /* Patch: force preserveDrawingBuffer on WebGL contexts so drawImage can read back content */
  (function patchWebGL() {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, attrs) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
        attrs = attrs || {};
        attrs.preserveDrawingBuffer = true;
      }
      return origGetContext.call(this, type, attrs);
    };
  })();

  if (window.__excalicordLocalLoaded) {
    return;
  }
  window.__excalicordLocalLoaded = true;

  var clamp = function (v, min, max) {
    return Math.min(max, Math.max(min, v));
  };
  var pad2 = function (n) {
    return String(n).padStart(2, "0");
  };
  var fmtTime = function (s) {
    return pad2(Math.floor(s / 60)) + ":" + pad2(Math.floor(s % 60));
  };

  var state = {
    camera: {
      enabled: false,
      stream: null,
      video: null,
      deviceId: "",
      shape: "circle",
      size: 150,
      mirrored: true,
      smoothing: 0.35,
      whitening: 0.15,
      slim: 0,
      skinWarm: 0,
      skinSat: 0,
      lightEnabled: false,
      lightIntensity: 0.35,
      screenLightEnabled: false,
      screenLightIntensity: 0.55,
      compositePosition: "bottom-right",
      raf: null,
    },
    rec: {
      active: false,
      paused: false,
      seconds: 0,
      timer: null,
      displayStream: null,
      recorder: null,
      chunks: [],
      lastBlob: null,
      lastExt: "webm",
      lastMime: "video/webm",
      lastFileName: "",
      lastSavedPath: "",
      lastSavedFileName: "",
      lastSavedViaNative: false,
      lastSavedToBrowserFolder: false,
      lastPreviewUrl: "",
      composeCanvas: null,
      composeCtx: null,
      composeVideo: null,
      composeRaf: null,
      selectedDisplaySurface: "",
      usingDirectDisplay: false,
      nativeActive: false,
      nativeAvailable: false,
      nativeOutputPath: "",
      nativeRecordingReady: false,
      sessionId: "",
      recordingReadyDispatched: false,
      restoreCameraAfterNative: false,
      projectFolder: {
        mode: "none",
        path: "",
        name: "",
        handle: null,
        loadedOnce: false,
      },
      projectSceneFiles: {},
    },
    tele: {
      open: false,
      text: "",
      speed: 6,
      fontSize: 22,
      opacity: 0.85,
      width: 420,
      height: 260,
      scrolling: false,
      hideWhileRecording: false,
      scrollTimer: null,
      scrollCarry: 0,
    },
    settings: {
      ratio: "youtube",
      format: "auto",
      scope: "screen",
      background: "#f4f1ea",
      backgroundStyle: "warm-gradient",
      customWidth: 1280,
      customHeight: 720,
      hideBubbleWhileRecording: false,
    },
    mic: {
      deviceId: "",
      stream: null,
      audioContext: null,
      analyser: null,
      dataArray: null,
      level: 0,
      muted: false,
      timer: null,
    },
    cursor: {
      highlight: true,
      highlightStyle: "halo",
      pointerShape: "system",
      sound: "off",
      soundContext: null,
      soundDestination: null,
      soundNodes: [],
      x: 0,
      y: 0,
    },
    smartCamera: {
      enabled: false,
      slideFocus: true,
      mouseFocus: true,
      clickFocus: true,
      speed: "standard",
      strength: "gentle",
      targetX: 0.5,
      targetY: 0.5,
      currentX: 0.5,
      currentY: 0.5,
      targetScale: 1,
      currentScale: 1,
      keyframes: [],
      pointerInsideCanvas: false,
      lastPointerAt: 0,
      lastFrameId: "",
      lastFrameAt: 0,
      renderedCrop: null,
    },
    v011: {
      projectSchemaVersion: 1,
      projectV2: null,
      projectId: "",
      session: null,
      recordingScope: "screen",
      recordingRatio: "youtube",
      recordingCustomWidth: 1280,
      recordingCustomHeight: 720,
      sessionDirty: false,
      media: [],
      saveTimer: null,
      text: {
        script: { sourceText: "" },
        transcript: { raw: [], corrected: [], corrections: [] },
        subtitles: { segments: [] },
        dictionary: [],
      },
    },
    countdown: {
      active: false,
      value: 0,
    },
  };

  /* ============ v0.1.1 project/session foundation ============
   * The recording itself remains the source media.  This small local model
   * stores only editable metadata and telemetry, so zoom/cursor/text features
   * can be added without rewriting the original recording.  It deliberately
   * keeps raw transcript and corrected transcript separate.
   */
  var V011_PROJECT_KEY = "excalicord-v011-project";
  var V011_PROJECT_SCHEMA = 1;
  var PROJECT_FILE_SCHEMA = 2;

  function editorCoreApi() {
    return window.ExcalicordEditorCore || null;
  }

  function requireEditorCore() {
    var core = editorCoreApi();
    if (!core || typeof core.normalizeProject !== "function"
      || typeof core.migrateV1 !== "function"
      || typeof core.projectV2ToLegacyRuntime !== "function"
      || typeof core.mergeLegacyRuntimeIntoProjectV2 !== "function") {
      throw new Error("项目文件需要 EditorCore v2；请刷新页面或检查模块加载顺序");
    }
    return core;
  }

  function v011Id(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function v011DefaultProject() {
    return {
      schemaVersion: V011_PROJECT_SCHEMA,
      projectId: v011Id("project"),
      updatedAt: new Date().toISOString(),
      recording: {
        scope: "screen",
        ratio: "youtube",
        duration: 0,
        media: [],
      },
      session: null,
      events: [],
      text: {
        script: { sourceText: "" },
        transcript: { raw: [], corrected: [], corrections: [] },
        subtitles: { segments: [] },
        dictionary: [],
      },
      edits: {
        cuts: [],
        camera: {
          enabled: false,
          slideFocus: true,
          mouseFocus: true,
          clickFocus: true,
          speed: "standard",
          strength: "gentle",
          keyframes: [],
        },
        cursor: {
          highlight: true,
          highlightStyle: "halo",
          pointerShape: "system",
          sound: "off",
        },
        webcam: {
          screenLightEnabled: false,
          screenLightIntensity: 0.55,
        },
        annotations: [],
        audio: { microphoneDeviceId: "" },
        appearance: { background: "#f4f1ea", backgroundStyle: "warm-gradient" },
      },
    };
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function v011NormalizeProject(raw, strict) {
    if (!isPlainObject(raw)) {
      if (strict) throw new Error("项目清单不是有效对象");
      return v011DefaultProject();
    }
    if (strict && raw.schemaVersion !== V011_PROJECT_SCHEMA) {
      throw new Error("不支持的项目版本：" + String(raw.schemaVersion == null ? "未知" : raw.schemaVersion));
    }
    if (strict && (typeof raw.projectId !== "string" || !raw.projectId.trim() || raw.projectId.length > 200)) {
      throw new Error("项目清单缺少有效的 projectId");
    }

    var project = v011DefaultProject();
    project.projectId = typeof raw.projectId === "string" && raw.projectId.trim()
      ? raw.projectId.slice(0, 200)
      : project.projectId;
    project.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : project.updatedAt;
    if (isPlainObject(raw.recording)) {
      project.recording.scope = typeof raw.recording.scope === "string" ? raw.recording.scope : project.recording.scope;
      project.recording.ratio = typeof raw.recording.ratio === "string" ? raw.recording.ratio : project.recording.ratio;
      project.recording.duration = Number(raw.recording.duration || 0);
      project.recording.media = Array.isArray(raw.recording.media)
        ? raw.recording.media.filter(function (item) {
          return isPlainObject(item) && typeof item.path === "string"
            && /^recordings\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,119}\/)?[^/]+$/.test(item.path);
        }).slice(-100).map(function (item) {
          return {
            path: item.path,
            type: typeof item.type === "string" ? item.type : "video/mp4",
            recordedAt: typeof item.recordedAt === "string" ? item.recordedAt : "",
            duration: Number(item.duration || 0),
          };
        })
        : [];
    }
    project.session = isPlainObject(raw.session) ? raw.session : null;
    project.events = Array.isArray(raw.events) ? raw.events.slice(-30000) : [];

    var rawText = isPlainObject(raw.text) ? raw.text : {};
    var rawScript = isPlainObject(rawText.script) ? rawText.script : {};
    var rawTranscript = isPlainObject(rawText.transcript) ? rawText.transcript : {};
    var rawSubtitles = isPlainObject(rawText.subtitles) ? rawText.subtitles : {};
    project.text.script.sourceText = typeof rawScript.sourceText === "string" ? rawScript.sourceText : "";
    project.text.transcript.raw = Array.isArray(rawTranscript.raw) ? rawTranscript.raw : [];
    project.text.transcript.corrected = Array.isArray(rawTranscript.corrected) ? rawTranscript.corrected : [];
    project.text.transcript.corrections = Array.isArray(rawTranscript.corrections) ? rawTranscript.corrections : [];
    project.text.subtitles.segments = Array.isArray(rawSubtitles.segments) ? rawSubtitles.segments : [];
    project.text.dictionary = Array.isArray(rawText.dictionary) ? rawText.dictionary : [];

    var rawEdits = isPlainObject(raw.edits) ? raw.edits : {};
    project.edits.cuts = Array.isArray(rawEdits.cuts) ? rawEdits.cuts : [];
    project.edits.annotations = Array.isArray(rawEdits.annotations) ? rawEdits.annotations : [];
    project.edits.audio = isPlainObject(rawEdits.audio) ? rawEdits.audio : {};
    project.edits.appearance = isPlainObject(rawEdits.appearance) ? rawEdits.appearance : {};
    var rawCamera = isPlainObject(rawEdits.camera) ? rawEdits.camera : {};
    project.edits.camera = {
      enabled: !!rawCamera.enabled,
      slideFocus: rawCamera.slideFocus !== false,
      mouseFocus: rawCamera.mouseFocus !== false,
      clickFocus: rawCamera.clickFocus !== false,
      speed: typeof rawCamera.speed === "string" ? rawCamera.speed : "standard",
      strength: typeof rawCamera.strength === "string" ? rawCamera.strength : "gentle",
      keyframes: Array.isArray(rawCamera.keyframes) ? rawCamera.keyframes : [],
    };
    var rawCursor = isPlainObject(rawEdits.cursor) ? rawEdits.cursor : {};
    project.edits.cursor = {
      highlight: rawCursor.highlight !== false,
      highlightStyle: typeof rawCursor.highlightStyle === "string" ? rawCursor.highlightStyle : "halo",
      pointerShape: typeof rawCursor.pointerShape === "string" ? rawCursor.pointerShape : "system",
      sound: typeof rawCursor.sound === "string" ? rawCursor.sound : "off",
    };
    return project;
  }

  function v011ApplyLegacyRuntime(project) {
    project = v011NormalizeProject(project, false);
    state.v011.projectSchemaVersion = V011_PROJECT_SCHEMA;
    state.v011.projectId = project.projectId || v011Id("project");
    state.v011.text = project.text;
    state.v011.session = project.session || null;
    state.v011.media = project.recording && Array.isArray(project.recording.media)
      ? project.recording.media.filter(function (item) {
        return item && typeof item.path === "string"
          && /^recordings\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,119}\/)?[^/]+$/.test(item.path);
      }).map(function (item) {
        return { path: item.path, type: item.type || "video/mp4", recordedAt: item.recordedAt || "", duration: Number(item.duration || 0) };
      })
      : [];
    state.v011.recordingScope = project.recording && project.recording.scope || "screen";
    state.v011.recordingRatio = project.recording && project.recording.ratio || "16:9";
    state.tele.text = project.text.script.sourceText || "";
    state.smartCamera.enabled = !!(project.edits && project.edits.camera && project.edits.camera.enabled);
    state.smartCamera.slideFocus = project.edits && project.edits.camera
      ? project.edits.camera.slideFocus !== false
      : true;
    state.smartCamera.mouseFocus = project.edits && project.edits.camera
      ? project.edits.camera.mouseFocus !== false
      : true;
    state.smartCamera.clickFocus = project.edits && project.edits.camera
      ? project.edits.camera.clickFocus !== false
      : true;
    state.smartCamera.speed = project.edits && project.edits.camera && typeof project.edits.camera.speed === "string"
      ? project.edits.camera.speed
      : "standard";
    state.smartCamera.strength = (project.edits && project.edits.camera && project.edits.camera.strength) || "gentle";
    state.smartCamera.keyframes = project.edits && project.edits.camera && Array.isArray(project.edits.camera.keyframes)
      ? project.edits.camera.keyframes.slice()
      : [];
    var projectCursor = project.edits && project.edits.cursor || {};
    state.cursor.highlight = projectCursor.highlight !== false;
    state.cursor.highlightStyle = typeof projectCursor.highlightStyle === "string" ? projectCursor.highlightStyle : "halo";
    state.cursor.pointerShape = typeof projectCursor.pointerShape === "string" ? projectCursor.pointerShape : "system";
    state.cursor.sound = typeof projectCursor.sound === "string" ? projectCursor.sound : "off";
    var projectWebcam = project.edits && project.edits.webcam || {};
    state.camera.screenLightEnabled = projectWebcam.screenLightEnabled === true;
    state.camera.screenLightIntensity = Number.isFinite(Number(projectWebcam.screenLightIntensity))
      ? clamp(Number(projectWebcam.screenLightIntensity), 0, 1)
      : 0.55;
    state.settings.background = project.edits && project.edits.appearance && typeof project.edits.appearance.background === "string"
      ? project.edits.appearance.background
      : state.settings.background;
    state.settings.backgroundStyle = project.edits && project.edits.appearance && typeof project.edits.appearance.backgroundStyle === "string"
      ? project.edits.appearance.backgroundStyle
      : state.settings.backgroundStyle;
    state.mic.deviceId = project.edits && project.edits.audio && typeof project.edits.audio.microphoneDeviceId === "string"
      ? project.edits.audio.microphoneDeviceId
      : "";
    return project;
  }

  function v011LoadProject() {
    var project = v011DefaultProject();
    try {
      var raw = JSON.parse(localStorage.getItem(V011_PROJECT_KEY) || "null");
      if (raw && typeof raw === "object") project = v011NormalizeProject(raw, false);
    } catch (err) {
      project = v011DefaultProject();
    }
    return v011ApplyLegacyRuntime(project);
  }

  function v011BeginProjectAtNewRoot() {
    /* Choosing a save root is not the same as opening a project. Keep the
     * current whiteboard in Excalidraw and the draft script, but detach every
     * project-relative asset from the previous root. Carrying recordings or
     * edit ids across roots would make the new manifest point at files that do
     * not exist below the newly selected folder. */
    var scriptText = state.tele.text || "";
    var recordingScope = typeof scopeSel !== "undefined" && scopeSel
      ? scopeSel.value
      : (state.v011.recordingScope || "screen");
    var recordingRatio = typeof recordingRatioValue === "function"
      ? recordingRatioValue()
      : (typeof ratioSel !== "undefined" && ratioSel ? ratioSel.value : (state.v011.recordingRatio || "16:9"));
    var fresh = v011DefaultProject();
    fresh.text.script.sourceText = scriptText;
    fresh.recording.scope = recordingScope;
    fresh.recording.ratio = recordingRatio;
    state.v011.projectV2 = null;
    v011ApplyLegacyRuntime(fresh);
    state.v011.sessionDirty = false;
    localStorage.setItem(V011_PROJECT_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function v011ProjectSnapshot() {
    var existing = v011DefaultProject();
    try {
      var raw = JSON.parse(localStorage.getItem(V011_PROJECT_KEY) || "null");
      if (raw && typeof raw === "object") existing = v011NormalizeProject(raw, false);
    } catch (err) {}
    existing.projectId = state.v011.projectId || existing.projectId;
    existing.schemaVersion = V011_PROJECT_SCHEMA;
    existing.updatedAt = new Date().toISOString();
    existing.session = state.v011.session;
    existing.events = state.v011.session ? state.v011.session.events.slice() : (existing.events || []);
    existing.text = state.v011.text;
    existing.text.script.sourceText = state.tele.text || existing.text.script.sourceText || "";
    existing.recording.scope = typeof scopeSel !== "undefined" && scopeSel ? scopeSel.value : existing.recording.scope;
    existing.recording.ratio = typeof recordingRatioValue === "function" ? recordingRatioValue() : (typeof ratioSel !== "undefined" && ratioSel ? ratioSel.value : existing.recording.ratio);
    existing.recording.duration = state.v011.session ? state.v011.session.duration || 0 : existing.recording.duration || 0;
    existing.recording.media = state.v011.media.slice();
    existing.edits.camera = {
      enabled: !!state.smartCamera.enabled,
      slideFocus: state.smartCamera.slideFocus !== false,
      mouseFocus: state.smartCamera.mouseFocus !== false,
      clickFocus: state.smartCamera.clickFocus !== false,
      speed: state.smartCamera.speed || "standard",
      strength: state.smartCamera.strength,
      keyframes: state.smartCamera.keyframes.slice(),
    };
    existing.edits.cursor = {
      highlight: !!state.cursor.highlight,
      highlightStyle: state.cursor.highlightStyle || "halo",
      pointerShape: state.cursor.pointerShape || "system",
      sound: state.cursor.sound || "off",
    };
    existing.edits.webcam = Object.assign({}, existing.edits.webcam, {
      screenLightEnabled: !!state.camera.screenLightEnabled,
      screenLightIntensity: Number.isFinite(Number(state.camera.screenLightIntensity))
        ? Number(state.camera.screenLightIntensity)
        : 0.55,
    });
    existing.edits.appearance = Object.assign({}, existing.edits.appearance, {
      background: bgInput && bgInput.value ? bgInput.value : state.settings.background,
      backgroundStyle: bgStyleSel && bgStyleSel.value ? bgStyleSel.value : state.settings.backgroundStyle,
    });
    existing.edits.audio = Object.assign({}, existing.edits.audio, {
      microphoneDeviceId: state.mic.deviceId || "",
    });
    return existing;
  }

  function projectFileSnapshot() {
    var core = requireEditorCore();
    var legacy = v011ProjectSnapshot();
    var base = state.v011.projectV2
      ? core.normalizeProject(state.v011.projectV2)
      : core.normalizeProject(legacy);
    if (state.v011.projectV2) {
      /* Preserve post-editor timeline/edit data while merging new runtime media. */
      var priorLegacy = core.projectV2ToLegacyRuntime(base);
      legacy.edits = priorLegacy.edits;
    }
    var project = core.mergeLegacyRuntimeIntoProjectV2(base, legacy);
    project.recordings = (project.recordings || []).map(function (recording) {
      if (!recording || !recording.assets) return recording;
      var screen = recording.assets.screen;
      /* The current recorder emits one mixed/composite asset only. Do not
       * claim that camera, microphone, or system audio were split out. */
      recording.assets.webcam = null;
      recording.assets.microphone = null;
      recording.assets.systemAudio = null;
      if (screen && screen.path) {
        var mediaPath = String(screen.path).replace(/\\/g, "/");
        var pathParts = mediaPath.split("/");
        if (pathParts.length === 3 && pathParts[0] === "recordings") {
          recording.telemetry = Object.assign({}, recording.telemetry, {
            sessionPath: "recordings/" + pathParts[1] + "/session.json",
            eventsPath: "recordings/" + pathParts[1] + "/events.json",
          });
        }
        recording.legacyComposite = true;
        recording.limitations = [
          "当前原始录制为混合媒体；摄像头、麦克风和系统音频没有独立资产",
        ];
      }
      return recording;
    });
    if (project.schemaVersion !== PROJECT_FILE_SCHEMA) {
      throw new Error("EditorCore 未生成合法的 schema v2 项目文件");
    }
    state.v011.projectV2 = project;
    return project;
  }

  function v011SaveProject(reason) {
    try {
      var project = v011ProjectSnapshot();
      localStorage.setItem(V011_PROJECT_KEY, JSON.stringify(project));
      state.v011.sessionDirty = false;
      window.dispatchEvent(new CustomEvent("excalicord:project-saved", {
        detail: { projectId: project.projectId, reason: reason || "manual" },
      }));
      return project;
    } catch (err) {
      state.v011.sessionDirty = true;
      return null;
    }
  }

  function v011RecordSavedMedia(fileName, mimeType, duration) {
    var rawPath = String(fileName || "").replace(/\\/g, "/");
    var name = rawPath.split("/").pop();
    if (!name || !/^[^./][^/]*$/.test(name)) return;
    var path = rawPath.indexOf("recordings/") === 0
      ? rawPath
      : "recordings/" + (state.rec.sessionId || "legacy") + "/" + name;
    if (!/^recordings\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\/(?:[^/]+)$/.test(path)
      && path !== "recordings/recording.mp4") return;
    var media = state.v011.media.filter(function (item) { return item && item.path !== path; });
    media.push({
      path: path,
      type: mimeType || "video/mp4",
      recordedAt: new Date().toISOString(),
      duration: Number(duration || state.rec.seconds || 0),
    });
    state.v011.media = media.slice(-100);
    state.v011.sessionDirty = true;
    var project = v011SaveProject("recording-saved");
    if (project) saveProjectAssets(project).catch(function (error) {
      updateV011ProjectStatus("原始录制已保存，但项目清单更新失败：" + (error.message || error));
    });
  }

  function projectSubtitleSrt() {
    var segments = state.v011.text.subtitles && state.v011.text.subtitles.segments || [];
    return segments.map(function (segment, index) {
      return String(index + 1) + "\n" + v011FormatSubtitleTime(segment.start, ",") + " --> "
        + v011FormatSubtitleTime(segment.end, ",") + "\n" + segment.text + "\n";
    }).join("\n");
  }

  function saveProjectAssetBrowser(path, content) {
    var root = state.rec.projectFolder.handle;
    if (!root) return Promise.reject(new Error("未选择项目文件夹"));
    var parts = path.split("/");
    var leaf = parts.pop();
    return Promise.resolve(root.requestPermission ? root.requestPermission({ mode: "readwrite" }) : "granted")
      .then(function (permission) {
        if (permission !== "granted") throw new Error("未获得项目文件夹写入权限");
        return parts.reduce(function (promise, part) {
          return promise.then(function (dir) { return dir.getDirectoryHandle(part, { create: true }); });
        }, Promise.resolve(root));
      })
      .then(function (dir) { return dir.getFileHandle(leaf, { create: true }); })
      .then(function (file) { return file.createWritable(); })
      .then(function (writable) { return writable.write(content).then(function () { return writable.close(); }); });
  }

  function deleteProjectAssetBrowser(path) {
    var root = state.rec.projectFolder.handle;
    if (!root) return Promise.reject(new Error("未选择项目文件夹"));
    var parts = path.split("/");
    var leaf = parts.pop();
    return Promise.resolve(root.requestPermission ? root.requestPermission({ mode: "readwrite" }) : "granted")
      .then(function (permission) {
        if (permission !== "granted") throw new Error("未获得项目文件夹写入权限");
        return parts.reduce(function (promise, part) {
          return promise.then(function (dir) { return dir.getDirectoryHandle(part, { create: false }); });
        }, Promise.resolve(root));
      })
      .then(function (dir) { return dir.removeEntry(leaf); })
      .catch(function (error) {
        if (error && error.name === "NotFoundError") return false;
        throw error;
      });
  }

  function ensureBrowserProjectStructure() {
    var root = state.rec.projectFolder.handle;
    if (!root) return Promise.reject(new Error("未选择项目文件夹"));
    return Promise.resolve(root.requestPermission ? root.requestPermission({ mode: "readwrite" }) : "granted")
      .then(function (permission) {
        if (permission !== "granted") throw new Error("未获得项目文件夹写入权限");
        return root.getDirectoryHandle("recordings", { create: true });
      });
  }

  function sanitizeProjectAppState(appState) {
    if (!isPlainObject(appState)) return {};
    var clean = {};
    function copyString(key, allowed) {
      var value = appState[key];
      if (typeof value !== "string") return;
      if (allowed && allowed.indexOf(value) === -1) return;
      clean[key] = value;
    }
    function copyBoolean(key) {
      if (typeof appState[key] === "boolean") clean[key] = appState[key];
    }
    function copyNumber(key) {
      if (typeof appState[key] === "number" && Number.isFinite(appState[key])) clean[key] = appState[key];
    }
    copyString("viewBackgroundColor");
    copyString("theme", ["light", "dark"]);
    copyString("name");
    [
      "gridModeEnabled", "objectsSnapModeEnabled", "zenModeEnabled", "viewModeEnabled",
      "exportBackground", "exportEmbedScene", "exportWithDarkMode",
    ].forEach(copyBoolean);
    ["gridSize", "gridStep", "scrollX", "scrollY", "exportScale"].forEach(copyNumber);
    if (isPlainObject(appState.zoom) && typeof appState.zoom.value === "number" && Number.isFinite(appState.zoom.value)) {
      clean.zoom = { value: appState.zoom.value };
    }
    if (isPlainObject(appState.frameRendering)) {
      clean.frameRendering = {};
      ["enabled", "clip", "name", "outline"].forEach(function (key) {
        if (typeof appState.frameRendering[key] === "boolean") clean.frameRendering[key] = appState.frameRendering[key];
      });
    }
    return clean;
  }

  function projectSceneSnapshot() {
    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    var appState = readCurrentAppStateSafe();
    var files = isPlainObject(state.rec.projectSceneFiles) ? state.rec.projectSceneFiles : {};
    if (api) {
      try {
        if (typeof api.getSceneElementsIncludingDeleted === "function") {
          elements = api.getSceneElementsIncludingDeleted();
        } else if (typeof api.getSceneElements === "function") {
          elements = api.getSceneElements();
        }
      } catch (err) {}
      try {
        if (typeof api.getAppState === "function") appState = api.getAppState();
      } catch (err) {}
      try {
        if (typeof api.getFiles === "function") {
          var liveFiles = api.getFiles();
          if (isPlainObject(liveFiles)) files = Object.assign({}, files, liveFiles);
        }
      } catch (err) {}
    }
    state.rec.projectSceneFiles = files;
    return {
      type: "excalidraw",
      version: 2,
      source: "excalicord-project",
      elements: Array.isArray(elements) ? elements : [],
      appState: sanitizeProjectAppState(appState),
      files: files,
    };
  }

  function saveProjectAssets(project) {
    var manifest;
    try {
      manifest = projectFileSnapshot();
    } catch (error) {
      return Promise.reject(error);
    }
    var bridge = nativeBridge();
    var sceneSnapshot = projectSceneSnapshot();
    var scene = JSON.stringify(sceneSnapshot);
    var assets = [
      ["scene.excalidraw", scene],
    ];
    var hasSubtitles = !!(state.v011.text.subtitles && state.v011.text.subtitles.segments.length);
    if (hasSubtitles) {
      assets.push(["text/subtitles.srt", projectSubtitleSrt()]);
    }
    assets.push(["project.excalicord.json", JSON.stringify(manifest, null, 2)]);
    function writeSequentially(writeAsset) {
      return assets.reduce(function (promise, asset) {
        return promise.then(function () { return writeAsset(asset[0], asset[1]); });
      }, Promise.resolve());
    }
    if (state.rec.nativeAvailable && bridge && bridge.writeProjectFile) {
      var nativeWrite = function (path, content) { return bridge.writeProjectFile(path, content); };
      var nativeDelete = hasSubtitles || !bridge.deleteProjectFile
        ? Promise.resolve(true)
        : bridge.deleteProjectFile("text/subtitles.srt");
      return nativeDelete
        .then(function () { return writeSequentially(nativeWrite); })
        .then(function () {
          updateV011ProjectStatus("白板及 schema v2 项目内容已保存：" + projectFolderLabel());
          return sceneSnapshot;
        });
    }
    if (state.rec.projectFolder.handle) {
      var browserDelete = hasSubtitles
        ? Promise.resolve(true)
        : deleteProjectAssetBrowser("text/subtitles.srt");
      return ensureBrowserProjectStructure()
        .then(function () { return browserDelete; })
        .then(function () { return writeSequentially(saveProjectAssetBrowser); })
        .then(function () {
          updateV011ProjectStatus("白板及 schema v2 项目内容已保存：" + projectFolderLabel());
          return sceneSnapshot;
        });
    }
    return Promise.reject(new Error("未选择项目文件夹"));
  }

  function v011ScheduleSave(reason) {
    state.v011.sessionDirty = true;
    if (state.v011.saveTimer) return;
    state.v011.saveTimer = window.setTimeout(function () {
      state.v011.saveTimer = null;
      v011SaveProject(reason || "debounced");
    }, 700);
  }

  function v011SessionTime() {
    if (!state.v011.session) return 0;
    return Math.max(0, (Date.now() - state.v011.session.startedAt) / 1000 - state.v011.session.pausedSeconds);
  }

  function v011RecordEvent(type, payload) {
    var session = state.v011.session;
    if (!session || !state.rec.active) return;
    if (state.rec.paused && type !== "pause" && type !== "resume") return;
    var timeSeconds = Number(v011SessionTime().toFixed(3));
    var event = Object.assign({
      type: type,
      t: timeSeconds,
      timeMs: Math.max(0, Math.round(timeSeconds * 1000)),
    }, payload || {});
    session.events.push(event);
    if (session.events.length > 30000) session.events.splice(0, session.events.length - 30000);
    state.v011.sessionDirty = true;
    if (session.events.length % 24 === 0) v011ScheduleSave("event-batch");
  }

  function v011BeginSession() {
    var frames = typeof getFrames === "function" ? getFrames() : [];
    var activeId = typeof currentFrameId === "function" ? currentFrameId(frames) : "";
    state.smartCamera.targetX = 0.5;
    state.smartCamera.targetY = 0.5;
    state.smartCamera.currentX = 0.5;
    state.smartCamera.currentY = 0.5;
    state.smartCamera.targetScale = 1;
    state.smartCamera.currentScale = 1;
    state.smartCamera.keyframes = [];
    state.smartCamera.pointerInsideCanvas = false;
    state.smartCamera.renderedCrop = null;
    state.rec.sessionId = state.rec.sessionId || v011Id("session");
    state.v011.session = {
      id: state.rec.sessionId,
      schemaVersion: V011_PROJECT_SCHEMA,
      clock: { timebase: "recording-start", unit: "ms" },
      startedAt: Date.now(),
      endedAt: 0,
      duration: 0,
      pausedSeconds: 0,
      pauseStartedAt: 0,
      scope: typeof scopeSel !== "undefined" && scopeSel ? scopeSel.value : "screen",
      ratio: typeof recordingRatioValue === "function" ? recordingRatioValue() : (typeof ratioSel !== "undefined" && ratioSel ? ratioSel.value : "16:9"),
      initialFrameId: activeId,
      events: [],
    };
    state.smartCamera.lastFrameId = activeId;
    state.smartCamera.lastFrameAt = Date.now();
    v011RecordEvent("session-start", { frameId: activeId });
    v011ScheduleSave("session-start");
  }

  function v011PauseSession(paused) {
    var session = state.v011.session;
    if (!session) return;
    if (paused && !session.pauseStartedAt) {
      session.pauseStartedAt = Date.now();
      v011RecordEvent("pause");
    } else if (!paused && session.pauseStartedAt) {
      session.pausedSeconds += (Date.now() - session.pauseStartedAt) / 1000;
      session.pauseStartedAt = 0;
      v011RecordEvent("resume");
    }
    v011ScheduleSave("pause-state");
  }

  function v011EndSession() {
    var session = state.v011.session;
    if (!session || session.endedAt) return;
    if (session.pauseStartedAt) {
      session.pausedSeconds += (Date.now() - session.pauseStartedAt) / 1000;
      session.pauseStartedAt = 0;
    }
    session.endedAt = Date.now();
    session.duration = Number(v011SessionTime().toFixed(3));
    session.durationMs = Math.max(0, Math.round(session.duration * 1000));
    session.events.push({
      type: "session-stop",
      t: session.duration,
      timeMs: session.durationMs,
      duration: session.duration,
      durationMs: session.durationMs,
    });
    state.smartCamera.keyframes = v011BuildCameraTrack(session);
    v011SaveProject("session-stop");
  }

  function v011BuildCameraTrack(session) {
    if (!session || !Array.isArray(session.events)) return [];
    var smartCore = window.ExcalicordSmartCameraCore;
    if (smartCore && typeof smartCore.planFromEvents === "function") {
      try {
        return smartCore.planFromEvents(session.events, {
          durationMs: Number(session.duration || 0) * 1000,
          strength: state.smartCamera.strength,
          speed: state.smartCamera.speed,
          slideFocus: ((session.scope || state.v011.recordingScope) === "canvas" || (session.scope || state.v011.recordingScope) === "frame") && state.smartCamera.slideFocus !== false,
          mouseFocus: state.smartCamera.mouseFocus !== false,
          clickFocus: state.smartCamera.clickFocus !== false,
          allowOutsideCanvas: (session.scope || state.v011.recordingScope) === "screen",
          initialFrameId: session.initialFrameId || "",
        });
      } catch (error) {
        /* Keep the legacy track builder as a safe fallback if the optional module fails. */
      }
    }
    var track = [];
    var lastT = -Infinity;
    var lastFrameId = session.initialFrameId || "";
    var scale = ({ gentle: 1.22, medium: 1.38, strong: 1.58 }[state.smartCamera.strength] || 1.22);
    session.events.forEach(function (event) {
      if (!event || (event.type !== "pointer" && event.type !== "frame-change")) return;
      if (event.type === "frame-change") {
        var canSlideFocus = (session.scope || state.v011.recordingScope) === "canvas" || (session.scope || state.v011.recordingScope) === "frame";
        if (!canSlideFocus || state.smartCamera.slideFocus === false) return;
        lastFrameId = event.frameId || lastFrameId;
        track.push({
          t: event.t,
          x: 0.5,
          y: 0.5,
          scale: 1,
          frameId: lastFrameId,
          source: "auto-frame",
        });
        lastT = event.t;
        return;
      }
      var allowOutsideCanvas = (session.scope || state.v011.recordingScope) === "screen";
      if (state.smartCamera.mouseFocus === false) return;
      if (!event.insideCanvas && !allowOutsideCanvas) return;
      if (event.t - lastT < 0.45) return;
      track.push({
        t: event.t,
        x: event.x,
        y: event.y,
        scale: scale,
        frameId: lastFrameId,
        source: "auto-pointer",
      });
      lastT = event.t;
    });
    return track.slice(0, 1200);
  }

  function v011RecordFrameChange(frame, source) {
    if (!frame) return;
    if (state.smartCamera.lastFrameId === frame.id && Date.now() - state.smartCamera.lastFrameAt < 250) return;
    state.smartCamera.lastFrameId = frame.id;
    state.smartCamera.lastFrameAt = Date.now();
    state.smartCamera.targetX = 0.5;
    state.smartCamera.targetY = 0.5;
    state.smartCamera.targetScale = 1;
    v011RecordEvent("frame-change", {
      frameId: frame.id,
      title: frame.name || "",
      source: source || "navigation",
    });
  }

  function v011CanvasPoint(ev) {
    var canvas = typeof sceneCanvas === "function" ? sceneCanvas() : null;
    var rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    var x = Number(ev && ev.clientX) || 0;
    var y = Number(ev && ev.clientY) || 0;
    var nx = rect && rect.width ? (x - rect.left) / rect.width : x / Math.max(1, window.innerWidth || 1);
    var ny = rect && rect.height ? (y - rect.top) / rect.height : y / Math.max(1, window.innerHeight || 1);
    return {
      x: clamp(nx, 0, 1),
      y: clamp(ny, 0, 1),
      inside: !!(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom),
    };
  }

  function v011RecordPointer(ev) {
    var point = v011CanvasPoint(ev);
    var screenScope = scopeSel && scopeSel.value === "screen";
    var eventPoint = point;
    if (screenScope) {
      eventPoint = {
        x: clamp((Number(ev && ev.clientX) || 0) / Math.max(1, window.innerWidth || 1), 0, 1),
        y: clamp((Number(ev && ev.clientY) || 0) / Math.max(1, window.innerHeight || 1), 0, 1),
        inside: true,
      };
    }
    state.smartCamera.pointerInsideCanvas = screenScope || point.inside;
    state.smartCamera.lastPointerAt = Date.now();
    if (state.rec.paused) return;
    if ((screenScope || point.inside) && state.smartCamera.mouseFocus !== false) {
      state.smartCamera.targetX = eventPoint.x;
      state.smartCamera.targetY = eventPoint.y;
      state.smartCamera.targetScale = state.smartCamera.enabled && state.smartCamera.mouseFocus !== false
        ? ({ gentle: 1.22, medium: 1.38, strong: 1.58 }[state.smartCamera.strength] || 1.22)
        : 1;
    }
    if (!state.v011.session || !state.rec.active) return;
    var last = state.v011.session.lastPointerAt || 0;
    var now = Date.now();
    if (now - last < 80) return;
    state.v011.session.lastPointerAt = now;
    v011RecordEvent("pointer", {
      x: Number(eventPoint.x.toFixed(4)),
      y: Number(eventPoint.y.toFixed(4)),
      insideCanvas: screenScope ? true : point.inside,
      sourceScope: scopeSel ? scopeSel.value : "screen",
    });
  }

  function v011SubtitleId() {
    return v011Id("subtitle");
  }

  function v011ParseSubtitleTime(value) {
    var text = String(value || "").trim().replace(",", ".");
    var parts = text.split(":");
    if (parts.length === 2) parts.unshift("0");
    if (parts.length !== 3) return NaN;
    var hours = Number(parts[0]);
    var minutes = Number(parts[1]);
    var seconds = Number(parts[2]);
    if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function v011FormatSubtitleTime(seconds, separator) {
    var totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    var hours = Math.floor(totalMs / 3600000);
    var minutes = Math.floor((totalMs % 3600000) / 60000);
    var secs = Math.floor((totalMs % 60000) / 1000);
    var ms = totalMs % 1000;
    function pad(value, width) { return String(value).padStart(width, "0"); }
    return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(secs, 2) + (separator || ",") + pad(ms, 3);
  }

  function v011NormalizeSubtitleSegment(segment, index) {
    if (!segment || typeof segment !== "object") return null;
    var start = Number(segment.start);
    var end = Number(segment.end);
    var text = String(segment.text || "").replace(/\r/g, "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return null;
    return {
      id: segment.id || v011SubtitleId(),
      start: Math.max(0, Number(start.toFixed(3))),
      end: Math.max(0, Number(end.toFixed(3))),
      text: text.slice(0, 2000),
      style: segment.style || "default",
      source: segment.source || "imported",
      index: Number.isFinite(index) ? index : 0,
    };
  }

  function v011ParseSubtitleFile(content) {
    var lines = String(content || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    var segments = [];
    var current = [];
    function flush() {
      if (!current.length) return;
      var timingIndex = current.findIndex(function (line) { return line.indexOf("-->") >= 0; });
      if (timingIndex < 0) { current = []; return; }
      var timing = current[timingIndex].split("-->");
      var start = v011ParseSubtitleTime(String(timing[0] || "").trim().split(/\s+/)[0]);
      var end = v011ParseSubtitleTime(String(timing[1] || "").trim().split(/\s+/)[0]);
      var text = current.slice(timingIndex + 1).filter(function (line) {
        return !/^NOTE(?:\s|$)/i.test(line) && !/^STYLE(?:\s|$)/i.test(line);
      }).join("\n").trim();
      var normalized = v011NormalizeSubtitleSegment({ start: start, end: end, text: text }, segments.length);
      if (normalized) segments.push(normalized);
      current = [];
    }
    lines.forEach(function (line) {
      if (!line.trim()) flush();
      else if (!/^WEBVTT(?:\s|$)/i.test(line.trim())) current.push(line);
    });
    flush();
    return segments.slice(0, 5000);
  }

  function v011SetSubtitleTrack(segments, source) {
    var normalized = (Array.isArray(segments) ? segments : []).map(v011NormalizeSubtitleSegment).filter(Boolean);
    normalized.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    normalized.forEach(function (segment, index) {
      segment.index = index;
      if (source) segment.source = source;
    });
    state.v011.text.subtitles.segments = normalized.slice(0, 5000);
    v011ScheduleSave("subtitle-track");
    return state.v011.text.subtitles.segments;
  }

  v011LoadProject();

  /* ============ Shadow-DOM UI ============ */
  var host = document.createElement("div");
  host.id = "excalicord-local";
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: "open" });
  var sectionIconTele =
    '<span class="ec-title-label"><span class="ec-section-icon ec-section-icon-tele" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M5.2 3.4h9.6a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H8.1l-3.7 2.4v-2.4h-.2a1.8 1.8 0 0 1-1.8-1.8V5.2a1.8 1.8 0 0 1 1.8-1.8Z"/><path d="M6.2 7.2h7.6M6.2 10h5.7"/></svg></span><span>提词器</span></span>';
  var sectionIconCamera =
    '<span class="ec-title-label"><span class="ec-section-icon ec-section-icon-camera" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M4.6 6.2h6.7l1.3-1.7h2a1.8 1.8 0 0 1 1.8 1.8v7.5a1.8 1.8 0 0 1-1.8 1.8h-10a1.8 1.8 0 0 1-1.8-1.8V8a1.8 1.8 0 0 1 1.8-1.8Z"/><circle cx="9.6" cy="10.9" r="3.1"/><path d="M14.8 7.8h.1"/></svg></span><span>摄像头</span></span>';
  var sectionIconRecord =
    '<span class="ec-title-label"><span class="ec-section-icon ec-section-icon-record" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><rect x="3.2" y="4.4" width="13.6" height="11.2" rx="2.2"/><circle cx="8" cy="10" r="2.15"/><path d="M12.2 8.3h2.1M12.2 11.7h2.1"/></svg></span><span>录制</span></span>';
  var panelBrandIcon =
    '<span class="ec-panel-brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7.4 6.4h5.9c1 0 1.9.6 2.3 1.5l.4.9h.8a2.7 2.7 0 0 1 2.7 2.7v4.4a2.7 2.7 0 0 1-2.7 2.7H7a2.7 2.7 0 0 1-2.7-2.7v-4.4A2.7 2.7 0 0 1 7 8.8h.5l.6-1.2c.3-.8 1-1.2 1.9-1.2Z"/><circle cx="12" cy="13.8" r="3.2"/><path d="M17.2 10.8h.1"/></svg></span>';
  var sectionIconSlide =
    '<span class="ec-title-label"><span class="ec-section-icon ec-section-icon-slide" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><rect x="3.2" y="4.2" width="13.6" height="9.4" rx="1.8"/><path d="M6 17h8"/><path d="M10 13.6V17"/></svg></span></span>';
  var EC_BUILD_VERSION = "20260823v011q-project-root-isolation";
  var shortcutPrefix = /Mac|iPhone|iPad/i.test(navigator.platform || "") ? "⌥⇧" : "Alt+Shift+";
  function shortcutLabel(key) {
    return shortcutPrefix + key;
  }
  function buttonWithShortcut(label, shortcut) {
    return '<span class="ec-btn-label">' + label + '</span><kbd class="ec-shortcut">' + shortcut + '</kbd>';
  }

  shadow.innerHTML = [
    '<nav class="ec-slide-rail" aria-label="白板幻灯片">',
    '  <button class="ec-slide-add" id="ec-slide-add" title="新增幻灯片" aria-label="新增幻灯片">＋</button>',
    '  <button class="ec-slide-overview-toggle" id="ec-slide-overview-toggle" type="button" title="幻灯片总览" aria-label="幻灯片总览"><svg viewBox="0 0 20 20" focusable="false" aria-hidden="true"><rect x="3.2" y="3.4" width="5.1" height="5.1" rx="1.3"/><rect x="11.7" y="3.4" width="5.1" height="5.1" rx="1.3"/><rect x="3.2" y="11.5" width="5.1" height="5.1" rx="1.3"/><rect x="11.7" y="11.5" width="5.1" height="5.1" rx="1.3"/></svg></button>',
    '  <button class="ec-view-tools-toggle" id="ec-view-tools-toggle" type="button" title="白板控制" aria-label="白板控制"><svg viewBox="0 0 20 20" focusable="false" aria-hidden="true"><circle cx="10" cy="10" r="3.1"/><path d="M2.6 10s2.7-5 7.4-5 7.4 5 7.4 5-2.7 5-7.4 5-7.4-5-7.4-5Z"/></svg></button>',
    '  <div class="ec-slide-tabs" id="ec-slide-tabs" aria-label="切换幻灯片"></div>',
    '  <button class="ec-launcher" title="录制面板" aria-label="录制面板"><span class="ec-launcher-icon" aria-hidden="true"><svg viewBox="0 0 28 28" focusable="false"><path class="ec-launcher-lens" d="M8.8 7.5h6.8c1.2 0 2.2.7 2.7 1.8l.5 1.1h.9c1.7 0 3.1 1.4 3.1 3.1v4.9c0 1.7-1.4 3.1-3.1 3.1H8.3c-1.7 0-3.1-1.4-3.1-3.1v-4.9c0-1.7 1.4-3.1 3.1-3.1h.6l.7-1.5c.4-.9 1.2-1.4 2.2-1.4Z"/><circle class="ec-launcher-core" cx="14" cy="16" r="4.1"/><circle class="ec-launcher-dot" cx="21" cy="12" r="1.15"/></svg></span></button>',
    '</nav>',
    '<div class="ec-view-tools" id="ec-view-tools" role="dialog" aria-label="白板控制" aria-hidden="true">',
    '  <div class="ec-view-tools-head"><div><strong>白板控制</strong><small>视图与设置</small></div><button id="ec-view-tools-close" type="button" title="关闭白板控制">×</button></div>',
    '  <div class="ec-control-tabs" role="tablist" aria-label="白板控制分类">',
    '    <button class="ec-control-tab ec-active" id="ec-control-tab-view" type="button" role="tab" aria-selected="true" aria-controls="ec-control-page-view">视图</button>',
    '    <button class="ec-control-tab" id="ec-control-tab-settings" type="button" role="tab" aria-selected="false" aria-controls="ec-control-page-settings">设置</button>',
    '  </div>',
    '  <div class="ec-control-page ec-active" id="ec-control-page-view" role="tabpanel" aria-labelledby="ec-control-tab-view">',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">画布</div>',
    '      <div class="ec-view-tools-grid">',
    '        <button id="ec-view-overview" type="button"><span>⌗</span>白板总览</button>',
    '        <div class="ec-focus-control"><select id="ec-view-frame-select" aria-label="选择要聚焦的幻灯片"></select><button id="ec-view-current" type="button"><span>▣</span>聚焦</button></div>',
    '      </div>',
    '    </section>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">缩放</div>',
    '      <div class="ec-view-tools-grid">',
    '        <button id="ec-view-zoom-out" type="button"><span>−</span>缩小</button>',
    '        <button id="ec-view-zoom-in" type="button"><span>＋</span>放大</button>',
    '        <button class="ec-view-zoom-reset" id="ec-view-zoom-reset" type="button"><span>1:1</span>恢复 100%</button>',
    '      </div>',
    '    </section>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">历史</div>',
    '      <div class="ec-view-tools-grid">',
    '        <button class="ec-view-history-command" id="ec-view-undo" type="button"><span class="ec-view-history-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg></span>撤回</button>',
    '        <button class="ec-view-history-command" id="ec-view-redo" type="button"><span class="ec-view-history-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></svg></span>前进</button>',
    '      </div>',
    '    </section>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">演示</div>',
    '      <div class="ec-view-tools-grid"><button class="ec-view-present" id="ec-view-present" type="button"><span>▶</span>播放演示</button></div>',
    '    </section>',
    '  </div>',
    '  <div class="ec-control-page" id="ec-control-page-settings" role="tabpanel" aria-labelledby="ec-control-tab-settings" hidden>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">幻灯片行为</div>',
    '      <div class="ec-setting-item"><div class="ec-setting-info"><span class="ec-setting-name">空画板自动创建默认幻灯片</span><span class="ec-setting-desc">重置或清空后自动补一张 16:9 幻灯片。</span></div><label class="ec-toggle ec-setting-switch" title="空画板自动创建默认幻灯片"><input type="checkbox" id="ec-slide-auto-default"/><span class="ec-switch" aria-hidden="true"></span></label></div>',
    '      <div class="ec-setting-item"><div class="ec-setting-info"><span class="ec-setting-name">新增后全局鸟瞰</span><span class="ec-setting-desc">关闭后将聚焦并居中展示新增幻灯片。</span></div><label class="ec-toggle ec-setting-switch" title="新增后全局鸟瞰"><input type="checkbox" id="ec-slide-add-overview"/><span class="ec-switch" aria-hidden="true"></span></label></div>',
    '    </section>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">对齐与显示</div>',
    '      <div class="ec-setting-item"><div class="ec-setting-info"><span class="ec-setting-name">幻灯片智能吸附</span><span class="ec-setting-desc">移动或调整大小时显示参考线并自动吸附。</span></div><label class="ec-toggle ec-setting-switch" title="幻灯片智能吸附"><input type="checkbox" id="ec-slide-grid-snap"/><span class="ec-switch" aria-hidden="true"></span></label></div>',
    '      <div class="ec-setting-item"><div class="ec-setting-info"><span class="ec-setting-name">显示白板网格</span><span class="ec-setting-desc">仅控制网格显示，不影响智能吸附参考线。</span></div><label class="ec-toggle ec-setting-switch" title="显示白板网格"><input type="checkbox" id="ec-slide-grid-visible"/><span class="ec-switch" aria-hidden="true"></span></label></div>',
    '    </section>',
    '    <section class="ec-view-section">',
    '      <div class="ec-view-section-title">悬浮栏位置</div>',
    '      <div class="ec-dock-choices" id="ec-dock-choices">',
    '        <button class="ec-dock-choice" type="button" data-dock="left" aria-label="悬浮栏放在左侧" aria-pressed="false"><span class="ec-dock-preview ec-dock-preview-left"><i></i></span>左侧</button>',
    '        <button class="ec-dock-choice" type="button" data-dock="right" aria-label="悬浮栏放在右侧" aria-pressed="false"><span class="ec-dock-preview ec-dock-preview-right"><i></i></span>右侧</button>',
    '        <button class="ec-dock-choice" type="button" data-dock="top" aria-label="悬浮栏放在顶部" aria-pressed="false"><span class="ec-dock-preview ec-dock-preview-top"><i></i></span>顶部</button>',
    '        <button class="ec-dock-choice" type="button" data-dock="bottom" aria-label="悬浮栏放在底部" aria-pressed="false"><span class="ec-dock-preview ec-dock-preview-bottom"><i></i></span>底部</button>',
    '      </div>',
    '    </section>',
    '  </div>',
    '</div>',
    '<div class="ec-presenter" id="ec-presenter" role="dialog" aria-label="幻灯片播放" aria-hidden="true">',
    '  <div class="ec-presenter-progress"><span id="ec-presenter-progress-bar"></span></div>',
    '  <div class="ec-presenter-meta"><strong id="ec-presenter-title">幻灯片</strong><span id="ec-presenter-count">1 / 1</span></div>',
    '  <button class="ec-presenter-hit ec-presenter-prev" id="ec-presenter-prev" type="button" aria-label="上一张幻灯片"><span>‹</span></button>',
    '  <button class="ec-presenter-hit ec-presenter-next" id="ec-presenter-next" type="button" aria-label="下一张幻灯片"><span>›</span></button>',
    '  <div class="ec-presenter-controls">',
    '    <button id="ec-presenter-prev-small" type="button">← 上一页</button>',
    '    <span>方向键 / 空格翻页</span>',
    '    <button id="ec-presenter-next-small" type="button">下一页 →</button>',
    '    <button class="ec-presenter-exit" id="ec-presenter-exit" type="button">退出演示</button>',
    '  </div>',
    '</div>',
    '<div class="ec-smart-guides" id="ec-smart-guides" aria-hidden="true">',
    '  <div class="ec-smart-guide ec-smart-guide-v" id="ec-smart-guide-v"><span>垂直对齐</span></div>',
    '  <div class="ec-smart-guide ec-smart-guide-h" id="ec-smart-guide-h"><span>水平对齐</span></div>',
    '</div>',
    '<div class="ec-slide-overview" id="ec-slide-overview" role="dialog" aria-label="幻灯片总览" aria-hidden="true">',
    '  <div class="ec-slide-overview-head"><div><strong>幻灯片总览</strong><span id="ec-slide-overview-meta">0 张幻灯片</span></div><div class="ec-slide-overview-actions"><button class="ec-slide-settings-btn" id="ec-slide-settings-btn" type="button" title="打开幻灯片设置" aria-label="打开幻灯片设置">⚙ 设置</button><button class="ec-slide-overview-close" id="ec-slide-overview-close" type="button" title="关闭总览" aria-label="关闭幻灯片总览">×</button></div></div>',
    '  <input class="ec-slide-search" id="ec-slide-search" type="search" placeholder="搜索编号或标题，例如：开场 / 12" aria-label="搜索幻灯片"/>',
    '  <div class="ec-slide-bulkbar" id="ec-slide-bulkbar" aria-hidden="true"><strong id="ec-slide-selected-count">已选 0 页</strong><div><button id="ec-slide-select-all" type="button">全选</button><button id="ec-slide-clear-selection" type="button">取消选择</button><button class="ec-slide-bulk-delete" id="ec-slide-bulk-delete" type="button">删除</button></div></div>',
    '  <div class="ec-slide-grid" id="ec-slide-grid"></div>',
    '</div>',
    '<div class="ec-panel" role="dialog" aria-label="more-excalicord">',
    '  <h2 class="ec-panel-header"><span class="ec-panel-title">' + panelBrandIcon + '<span>more-excalicord</span></span><button class="ec-panel-collapse" id="ec-panel-collapse" type="button" title="关闭面板（Esc）" aria-label="关闭 more-excalicord 面板，快捷键 Esc">×</button></h2>',
    '  <p class="ec-sub">白板 + 摄像头 + 提词器，录制原始素材（本地运行，不上传）</p>',
    '  <div class="ec-section">',
    '    <div class="ec-section-title"><span class="ec-title-label"><span class="ec-section-icon ec-section-icon-slide" aria-hidden="true">▣</span><span>项目</span></span></div>',
    '    <div class="ec-row"><label>项目</label><button class="ec-btn ec-btn-ghost" id="ec-project-folder-choose" style="flex:1">设置项目文件夹…</button><button class="ec-btn ec-btn-ghost" id="ec-project-folder-open">在 Finder 中显示</button></div>',
    '    <div class="ec-project-path" id="ec-project-folder-path" title="未选择项目文件夹"><span>项目文件夹</span><strong>未选择</strong></div>',
    '    <div class="ec-row ec-whiteboard-actions"><label>白板</label><button class="ec-btn ec-btn-ghost" id="ec-project-file-open">打开 Excalidraw 文件…</button><button class="ec-btn ec-btn-ghost" id="ec-project-whiteboard-save">保存白板</button><input id="ec-project-file-input" type="file" accept=".excalidraw,application/json" hidden/></div>',
    '    <p class="ec-sub" id="ec-project-status">先设置项目文件夹；打开与保存均由你明确执行。</p>',
    "  </div>",
    '  <div class="ec-section">',
    '    <div class="ec-section-title"><span class="ec-title-label"><span class="ec-section-icon ec-section-icon-tele" aria-hidden="true">Aa</span><span>提词器 / 讲稿</span></span></div>',
    '    <div class="ec-row"><label>面板</label><button class="ec-btn ec-btn-ghost" id="ec-tele-toggle" style="flex:1">打开提词器</button></div>',
    '    <div class="ec-row"><label>隐藏</label><label class="ec-toggle"><input type="checkbox" id="ec-tele-hide"/> 录制时隐藏（不入镜）</label></div>',
    '    <input id="ec-script-import-file" type="file" accept=".md,.markdown,.txt,.srt,.vtt,text/markdown,text/plain,text/vtt,application/x-subrip" hidden/>',
    '    <p class="ec-sub" id="ec-script-status">讲稿在提词器面板内载入或编辑；录后的逐字稿和字幕仍以实际音频为准。</p>',
    "  </div>",
    '  <div class="ec-section ec-camera-section">',
    '    <div class="ec-section-title"><span class="ec-title-label"><span class="ec-section-icon ec-section-icon-camera" aria-hidden="true">◉</span><span>摄像头画中画</span></span></div>',
    '    <div class="ec-row"><label>启用</label><label class="ec-toggle"><input type="checkbox" id="ec-cam-enable"/> 摄像头画中画</label></div>',
    '    <div class="ec-camera-details" id="ec-camera-details" aria-hidden="true" hidden>',
    '    <div class="ec-row"><label>设备</label><select id="ec-cam-device"><option value="">默认摄像头</option></select></div>',
    '    <div class="ec-row"><label>形状</label><select id="ec-cam-shape"><option value="circle">圆形</option><option value="rounded">圆角方形</option><option value="pill">胶囊</option></select></div>',
    '    <div class="ec-row"><label>大小</label><input type="range" id="ec-cam-size" min="60" max="400" step="5" value="150"/><span class="ec-value" id="ec-cam-size-v">150</span></div>',
    '    <div class="ec-row"><label>人像优化</label><label class="ec-toggle"><input type="checkbox" id="ec-beauty-toggle"/> 启用调节</label></div>',
    '    <div class="ec-row" id="ec-beauty-smooth-row" style="display:none"><label>磨皮</label><input type="range" id="ec-beauty-smooth" min="0" max="1" step="0.05" value="0.35"/><span class="ec-value" id="ec-beauty-smooth-v">0.35</span></div>',
    '    <div class="ec-row" id="ec-beauty-white-row" style="display:none"><label>亮肤</label><input type="range" id="ec-beauty-white" min="0" max="1" step="0.05" value="0.15"/><span class="ec-value" id="ec-beauty-white-v">0.15</span></div>',
    '    <div class="ec-row" id="ec-beauty-slim-row" style="display:none"><label>瘦脸</label><input type="range" id="ec-beauty-slim" min="0" max="1" step="0.05" value="0"/><span class="ec-value" id="ec-beauty-slim-v">0</span></div>',
    '    <div class="ec-row" id="ec-beauty-warm-row" style="display:none"><label>肤色冷暖</label><input type="range" id="ec-beauty-warm" min="-1" max="1" step="0.1" value="0"/><span class="ec-value" id="ec-beauty-warm-v">0</span></div>',
    '    <div class="ec-row" id="ec-beauty-sat-row" style="display:none"><label>饱和度</label><input type="range" id="ec-beauty-sat" min="-1" max="1" step="0.1" value="0"/><span class="ec-value" id="ec-beauty-sat-v">0</span></div>',
    '    <div class="ec-row"><label>镜头补光</label><label class="ec-toggle"><input type="checkbox" id="ec-light-toggle"/> 增强摄像头亮度</label></div>',
    '    <div class="ec-row" id="ec-light-row" style="display:none"><label>强度</label><input type="range" id="ec-light-intensity" min="0" max="1" step="0.05" value="0.35"/><span class="ec-value" id="ec-light-intensity-v">0.35</span></div>',
    '    <div class="ec-row"><label>屏幕柔光</label><label class="ec-toggle"><input type="checkbox" id="ec-screen-light-toggle"/> 显示补光圈</label></div>',
    '    <div class="ec-row" id="ec-screen-light-row" style="display:none"><label>亮度</label><input type="range" id="ec-screen-light-intensity" min="0" max="1" step="0.05" value="0.55"/><span class="ec-value" id="ec-screen-light-intensity-v">0.55</span></div>',
    '    <p class="ec-sub" id="ec-screen-light-note" style="display:none;margin:2px 0 0">在屏幕上显示柔光圈给人脸补光；录制整个浏览器页面时可能入镜。</p>',
    '    <p class="ec-sub" id="ec-faceapi-status" style="margin:2px 0 0;display:none">人脸检测模型加载中…（本地运行）</p>',
    '    <div class="ec-row"><label>镜像</label><label class="ec-toggle"><input type="checkbox" id="ec-cam-mirror" checked/> 左右翻转</label></div>',
    '    </div>',
    "  </div>",
    '  <div class="ec-section">',
    '    <div class="ec-section-title">' + sectionIconRecord + "</div>",
    '    <div class="ec-row"><label>画幅</label><select id="ec-ratio"><option value="youtube">YouTube / B站 横版 16:9</option><option value="wechat-video">视频号 / 小红书 竖版 9:16</option><option value="square">小红书 / 社媒 方形 1:1</option><option value="slides">课件 / 投屏 4:3</option><option value="custom">自定义画幅…</option></select><span class="ec-value" id="ec-ratio-v">1920×1080</span></div>',
    '    <div class="ec-row ec-custom-size-row" id="ec-custom-size-row" style="display:none"><label>自定义</label><input id="ec-custom-width" type="number" min="320" max="7680" step="2" value="1280" aria-label="自定义宽度"/><span class="ec-size-separator">×</span><input id="ec-custom-height" type="number" min="320" max="7680" step="2" value="720" aria-label="自定义高度"/></div>',
    '    <div class="ec-row"><label>范围</label><select id="ec-scope"><option value="screen">选择的屏幕/窗口</option><option value="canvas">白板全景</option><option value="frame">当前幻灯片聚焦</option></select></div>',
    '    <div id="ec-native-status-row" style="display:none"><span id="ec-native-status" class="ec-native-status">检测中…</span></div>',
    '    <div id="ec-native-source-row" style="display:none"><select id="ec-native-source"><option value="display:">自动选择主显示器</option></select></div>',
    '    <div class="ec-row"><label>格式</label><select id="ec-format"><option value="auto">自动（优先 MP4）</option><option value="video/mp4">MP4</option><option value="video/webm">WebM</option></select></div>',
    '    <div class="ec-row"><label>背景</label><select id="ec-bg-style"><option value="warm-gradient">暖色渐变</option><option value="paper">纸张纹理</option><option value="dark">深色舞台</option><option value="solid">纯色</option></select><input type="color" id="ec-bg" value="#f4f1ea" title="纯色或渐变主色"/></div>',
    '    <div class="ec-row"><label>合成</label><label class="ec-toggle"><input type="checkbox" id="ec-compose" title="录制时把摄像头圆框直接合成进视频文件，不依赖屏幕里的气泡位置"/> 摄像头合成进视频</label></div>',
    '    <div class="ec-row" id="ec-composite-position-row"><label>摄像头位置</label><select id="ec-composite-position"><option value="top-left">左上</option><option value="top-right">右上</option><option value="bottom-left">左下</option><option value="bottom-right" selected>右下</option></select></div>',
    '    <div class="ec-row"><label>隐藏</label><label class="ec-toggle"><input type="checkbox" id="ec-hide-bubble"/> 录制时隐藏屏幕上的气泡（与合成进视频无关）</label></div>',
    '    <div class="ec-row ec-mic-row" id="ec-mic-row"><label>麦克风</label><select id="ec-mic-device"><option value="">默认麦克风</option></select><div class="ec-mic-meter" id="ec-mic-meter"><div class="ec-mic-bar" id="ec-mic-bar"></div></div><span class="ec-value" id="ec-mic-status">—</span></div>',
    '    <div class="ec-row"><label>光标</label><label class="ec-toggle"><input type="checkbox" id="ec-cursor-highlight" checked/> 录制中显示光标效果</label></div>',
    '    <div class="ec-cursor-options" id="ec-cursor-options">',
    '      <div class="ec-row ec-cursor-detail"><label>高亮</label><select id="ec-cursor-highlight-style"><option value="halo">光环</option><option value="spotlight">聚光</option><option value="ring">圆环</option><option value="dot">圆点</option></select></div>',
    '      <div class="ec-row ec-cursor-detail"><label>指针</label><select id="ec-cursor-shape"><option value="system">系统指针</option><option value="dot">圆点指针</option><option value="crosshair">十字指针</option><option value="none">不显示指针形状</option></select></div>',
    '      <div class="ec-row ec-cursor-detail"><label>声音</label><select id="ec-cursor-sound"><option value="off">关闭</option><option value="soft">轻提示音</option><option value="click">清脆点击音</option></select></div>',
    '    </div>',
    '    <div class="ec-row"><label>智能镜头</label><label class="ec-toggle"><input type="checkbox" id="ec-smart-camera"/> 开启录后镜头建议</label></div>',
    '    <div class="ec-smart-camera-options" id="ec-smart-camera-options" style="display:none">',
    '      <label class="ec-toggle"><input type="checkbox" id="ec-smart-slide-focus" checked/> 幻灯片聚焦</label>',
    '      <label class="ec-toggle"><input type="checkbox" id="ec-smart-mouse-focus" checked/> 鼠标智能聚焦</label>',
    '      <label class="ec-toggle"><input type="checkbox" id="ec-smart-click-focus" checked/> 点击时聚焦</label>',
    '      <div class="ec-row ec-smart-camera-detail"><label>强度</label><select id="ec-smart-camera-strength"><option value="gentle">轻微</option><option value="medium">适中</option><option value="strong">明显</option></select></div>',
    '      <div class="ec-row ec-smart-camera-detail"><label>速度</label><select id="ec-smart-camera-speed"><option value="slow">慢</option><option value="standard">标准</option><option value="fast">快</option></select></div>',
    '      <p class="ec-sub" id="ec-smart-camera-hint">录制时只记录镜头线索；缩放节奏和焦点可在录后编辑里调整。</p>',
    '    </div>',
    '    <div class="ec-reccontrols"><span class="ec-rec-indicator" id="ec-indicator"></span><span class="ec-timer" id="ec-timer">00:00</span></div>',
    '    <div class="ec-reccontrols ec-rec-actions">',
    '      <button class="ec-btn ec-btn-success" id="ec-rec-start" title="开始录制（快捷键：' + shortcutLabel("R") + '）" aria-label="开始录制，快捷键 ' + shortcutLabel("R") + '">' + buttonWithShortcut("开始录制", shortcutLabel("R")) + '</button>',
    '      <button class="ec-btn ec-btn-ghost" id="ec-rec-pause" title="暂停或继续录制（快捷键：' + shortcutLabel("P") + '）" aria-label="暂停或继续录制，快捷键 ' + shortcutLabel("P") + '" disabled>' + buttonWithShortcut("暂停", shortcutLabel("P")) + '</button>',
    '      <button class="ec-btn ec-btn-danger" id="ec-rec-stop" title="停止录制（快捷键：' + shortcutLabel("S") + '）" aria-label="停止录制，快捷键 ' + shortcutLabel("S") + '" disabled>' + buttonWithShortcut("停止", shortcutLabel("S")) + '</button>',
    "    </div>",
    '    <div class="ec-row ec-export-row" style="margin-top:4px"><label style="flex:0 0 auto">原始录制</label><button class="ec-btn ec-btn-ghost" id="ec-export" style="flex:1">保存录制</button><button class="ec-btn ec-btn-ghost" id="ec-export-open">播放原始录制</button></div>',
    "  </div>",
    "</div>",
    '<div class="ec-mini-recorder" id="ec-mini-recorder" aria-hidden="true">',
    '  <span class="ec-mini-dot" id="ec-mini-indicator"></span><span class="ec-mini-timer" id="ec-mini-timer">00:00</span>',
    '  <button type="button" class="ec-mini-btn ec-mini-start" id="ec-mini-start" title="录制中">开始</button>',
    '  <button type="button" class="ec-mini-btn ec-mini-pause" id="ec-mini-pause" title="暂停或继续录制">暂停</button>',
    '  <button type="button" class="ec-mini-btn ec-mini-stop" id="ec-mini-stop" title="停止录制">停止</button>',
    '</div>',
    '<div class="ec-toast" id="ec-toast"></div>',
    '<div class="ec-source-modal" id="ec-source-modal" aria-hidden="true">',
    '  <div class="ec-source-dialog" role="dialog" aria-modal="true" aria-label="选择录制来源">',
    '    <h3>确认录制范围</h3>',
    '    <p class="ec-source-help">先选择一种录制方式；下方只显示该方式需要的说明或候选来源。</p>',
    '    <div class="ec-source-options" id="ec-source-options"></div>',
    '    <div class="ec-source-actions"><button class="ec-btn ec-btn-ghost" id="ec-source-cancel">取消</button><button class="ec-btn ec-btn-success" id="ec-source-confirm">确认录制</button></div>',
    '  </div>',
    '</div>',
  ].join("");

  /* Stylesheets in the document do not cross the Shadow DOM boundary. */
  var shadowStylesheet = document.createElement("link");
  shadowStylesheet.rel = "stylesheet";
  shadowStylesheet.href = "/recorder/recorder.css?v=" + EC_BUILD_VERSION;
  shadow.prepend(shadowStylesheet);

  var presentationPageStyle = document.createElement("style");
  presentationPageStyle.textContent =
    "html.ec-presentation .layer-ui__wrapper," +
    "html.ec-presentation .App-menu_top," +
    "html.ec-presentation .App-bottom-bar," +
    "html.ec-presentation .layer-ui__wrapper__footer{" +
    "opacity:0!important;pointer-events:none!important;transition:opacity .18s ease}" +
    "html.ec-presentation,html.ec-presentation body{overflow:hidden!important}";
  document.head.appendChild(presentationPageStyle);

  /* ============ Toast ============ */
  var toastEl = shadow.getElementById("ec-toast");
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("ec-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("ec-show");
    }, 2600);
  }

  /* ============ Frame-based whiteboard slides ============ */
  var LEGACY_SLIDE_STORE_KEY = "excalicord-slides-v1";
  var LEGACY_MIGRATION_KEY = "excalicord-slides-v1-migrated";
  var ACTIVE_FRAME_KEY = "excalicord-active-frame";
  var AUTO_DEFAULT_SLIDE_KEY = "excalicord-auto-default-slide";
  var SLIDE_ADD_OVERVIEW_KEY = "excalicord-slide-add-overview";
  var SLIDE_ADD_OVERVIEW_DEFAULT_KEY = "excalicord-slide-add-overview-default-20260821aa";
  var SLIDE_GRID_SNAP_KEY = "excalicord-slide-grid-snap";
  var SLIDE_GRID_VISIBLE_KEY = "excalicord-slide-grid-visible";
  var DOCK_POSITION_KEY = "excalicord-slide-dock-position";
  var STANDARD_LAYOUT_MIGRATION_KEY = "excalicord-frame-layout-6-columns-v1";
  var PENDING_OVERVIEW_KEY = "excalicord-pending-overview";
  var SLIDE_COLUMNS = 6;
  var SLIDE_GAP = 240;
  var ELEMENTS_KEY = "excalidraw";
  var APP_STATE_KEY = "excalidraw-state";
  var slideAddBtn = shadow.getElementById("ec-slide-add");
  var slideOverviewToggle = shadow.getElementById("ec-slide-overview-toggle");
  var viewToolsToggle = shadow.getElementById("ec-view-tools-toggle");
  var viewToolsEl = shadow.getElementById("ec-view-tools");
  var viewToolsClose = shadow.getElementById("ec-view-tools-close");
  var controlTabView = shadow.getElementById("ec-control-tab-view");
  var controlTabSettings = shadow.getElementById("ec-control-tab-settings");
  var controlPageView = shadow.getElementById("ec-control-page-view");
  var controlPageSettings = shadow.getElementById("ec-control-page-settings");
  var viewOverviewBtn = shadow.getElementById("ec-view-overview");
  var viewCurrentBtn = shadow.getElementById("ec-view-current");
  var viewZoomOutBtn = shadow.getElementById("ec-view-zoom-out");
  var viewZoomInBtn = shadow.getElementById("ec-view-zoom-in");
  var viewZoomResetBtn = shadow.getElementById("ec-view-zoom-reset");
  var viewUndoBtn = shadow.getElementById("ec-view-undo");
  var viewRedoBtn = shadow.getElementById("ec-view-redo");
  var viewPresentBtn = shadow.getElementById("ec-view-present");
  var dockChoiceButtons = Array.prototype.slice.call(shadow.querySelectorAll(".ec-dock-choice"));
  var viewFrameSelect = shadow.getElementById("ec-view-frame-select");
  var presenterEl = shadow.getElementById("ec-presenter");
  var presenterTitle = shadow.getElementById("ec-presenter-title");
  var presenterCount = shadow.getElementById("ec-presenter-count");
  var presenterProgressBar = shadow.getElementById("ec-presenter-progress-bar");
  var presenterPrev = shadow.getElementById("ec-presenter-prev");
  var presenterNext = shadow.getElementById("ec-presenter-next");
  var presenterPrevSmall = shadow.getElementById("ec-presenter-prev-small");
  var presenterNextSmall = shadow.getElementById("ec-presenter-next-small");
  var presenterExit = shadow.getElementById("ec-presenter-exit");
  var smartGuidesEl = shadow.getElementById("ec-smart-guides");
  var smartGuideV = shadow.getElementById("ec-smart-guide-v");
  var smartGuideH = shadow.getElementById("ec-smart-guide-h");
  var slideTabsEl = shadow.getElementById("ec-slide-tabs");
  var slideOverviewEl = shadow.getElementById("ec-slide-overview");
  var slideOverviewMeta = shadow.getElementById("ec-slide-overview-meta");
  var slideOverviewClose = shadow.getElementById("ec-slide-overview-close");
  var slideSettingsBtn = shadow.getElementById("ec-slide-settings-btn");
  var slideSearchInput = shadow.getElementById("ec-slide-search");
  var slideGridEl = shadow.getElementById("ec-slide-grid");
  var slideBulkbar = shadow.getElementById("ec-slide-bulkbar");
  var slideSelectedCount = shadow.getElementById("ec-slide-selected-count");
  var slideSelectAllBtn = shadow.getElementById("ec-slide-select-all");
  var slideClearSelectionBtn = shadow.getElementById("ec-slide-clear-selection");
  var slideBulkDeleteBtn = shadow.getElementById("ec-slide-bulk-delete");
  var slideBusy = false;
  var draggingFrameId = "";
  var slideAutosaveTimer = null;
  var slidePreviewObserver = null;
  var selectedFrameIds = {};
  var currentOverviewMatchIds = [];
  var presentationState = {
    active: false,
    index: 0,
    previousAppState: null,
    previousFrameId: "",
  };
  var frameGuideState = {
    active: false,
    pointerDown: false,
    frameId: "",
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
    hasChanged: false,
    snapDx: 0,
    snapDy: 0,
    snapXIndex: -1,
    snapYIndex: -1,
    raf: 0,
  };
  var currentDockPosition = "right";
  var slideAutoDefault = shadow.getElementById("ec-slide-auto-default");
  slideAutoDefault.checked = localStorage.getItem(AUTO_DEFAULT_SLIDE_KEY) !== "0";
  slideAutoDefault.addEventListener("change", function () {
    localStorage.setItem(AUTO_DEFAULT_SLIDE_KEY, slideAutoDefault.checked ? "1" : "0");
  });
  var slideAddOverview = shadow.getElementById("ec-slide-add-overview");
  if (localStorage.getItem(SLIDE_ADD_OVERVIEW_DEFAULT_KEY) !== "1") {
    localStorage.setItem(SLIDE_ADD_OVERVIEW_KEY, "1");
    localStorage.setItem(SLIDE_ADD_OVERVIEW_DEFAULT_KEY, "1");
  }
  slideAddOverview.checked = localStorage.getItem(SLIDE_ADD_OVERVIEW_KEY) !== "0";
  slideAddOverview.addEventListener("change", function () {
    localStorage.setItem(SLIDE_ADD_OVERVIEW_KEY, slideAddOverview.checked ? "1" : "0");
  });
  var slideGridSnap = shadow.getElementById("ec-slide-grid-snap");
  slideGridSnap.checked = localStorage.getItem(SLIDE_GRID_SNAP_KEY) !== "0";
  var slideGridVisible = shadow.getElementById("ec-slide-grid-visible");
  slideGridVisible.checked = localStorage.getItem(SLIDE_GRID_VISIBLE_KEY) === "1";
  slideAddBtn.disabled = true;

  function newElementId(prefix) {
    return (
      prefix +
      "-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function randomNonce() {
    return Math.floor(Math.random() * 2147483647);
  }

  function readElementsSafe() {
    try {
      var parsed = JSON.parse(localStorage.getItem(ELEMENTS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function getLiveExcalidrawAPI() {
    var api = window.__excalicordExcalidrawAPI;
    return api && !api.isDestroyed ? api : null;
  }

  function writeElementsSafe(elements) {
    try {
      localStorage.setItem(ELEMENTS_KEY, JSON.stringify(elements));
      return true;
    } catch (err) {
      toast("幻灯片保存失败：浏览器存储空间不足");
      return false;
    }
  }

  /* Persist current scene to server (scene.excalidraw + version bump).
     Ensures auto-refresh and reloads reflect structural changes (frame add/delete)
     instead of reverting to the initial file. */
  function persistSceneToServer(elements) {
    var appState = readCurrentAppStateSafe();
    var scene = { type: "excalidraw", version: 2, source: "excalicord-local", elements: elements, appState: appState };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/save-scene", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.addEventListener("load", function () {
        if (xhr.status < 200 || xhr.status >= 300) return;
        try {
          var response = JSON.parse(xhr.responseText || "{}");
          var savedVersion = String(response.version || "");
          if (!savedVersion) return;
          /* 告诉 index.html 的版本轮询：这个版本由当前页面自己写入，
             不应当作外部变化重新加载。 */
          sessionStorage.setItem("excalidraw-auto-version", savedVersion);
          window.dispatchEvent(new CustomEvent("excalicord:scene-saved", {
            detail: { version: savedVersion },
          }));
          sessionStorage.removeItem(PENDING_OVERVIEW_KEY);
        } catch (err) {}
      });
      xhr.send(JSON.stringify(scene));
    } catch (e) { /* non-blocking */ }
  }

  function readAppStateSafe() {
    try {
      var parsed = JSON.parse(localStorage.getItem(APP_STATE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function readCurrentAppStateSafe() {
    var api = getLiveExcalidrawAPI();
    if (api) {
      try {
        return api.getAppState();
      } catch (err) {}
    }
    return readAppStateSafe();
  }

  function writeAppStatePatch(patch) {
    var appState = readAppStateSafe();
    Object.keys(patch).forEach(function (key) {
      appState[key] = patch[key];
    });
    try {
      localStorage.setItem(APP_STATE_KEY, JSON.stringify(appState));
      return true;
    } catch (err) {
      return false;
    }
  }

  function getFrames() {
    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    if (api) {
      try {
        elements = api.getSceneElementsIncludingDeleted();
      } catch (err) {}
    }
    return elements
      .filter(function (element) {
        return element && element.type === "frame" && !element.isDeleted;
      })
      .sort(function (a, b) {
        var orderA = a.customData && Number(a.customData.excalicordOrder);
        var orderB = b.customData && Number(b.customData.excalicordOrder);
        var hasOrderA = Number.isFinite(orderA);
        var hasOrderB = Number.isFinite(orderB);
        if (hasOrderA || hasOrderB) {
          if (!hasOrderA) orderA = Number.MAX_SAFE_INTEGER;
          if (!hasOrderB) orderB = Number.MAX_SAFE_INTEGER;
          if (orderA !== orderB) return orderA - orderB;
        }
        if (Math.abs((a.y || 0) - (b.y || 0)) > 80) return (a.y || 0) - (b.y || 0);
        return (a.x || 0) - (b.x || 0);
      });
  }

  function currentFrameId(frames) {
    var fromUrl = new URLSearchParams(location.search).get("frame");
    if (fromUrl && frames.some(function (frame) { return frame.id === fromUrl; })) {
      localStorage.setItem(ACTIVE_FRAME_KEY, fromUrl);
      return fromUrl;
    }
    var stored = localStorage.getItem(ACTIVE_FRAME_KEY);
    if (stored && frames.some(function (frame) { return frame.id === stored; })) {
      return stored;
    }
    return frames[0] ? frames[0].id : "";
  }

  function setSlideBusy(busy) {
    slideBusy = busy;
    slideAddBtn.disabled = busy;
    slideOverviewToggle.disabled = busy;
    viewToolsToggle.disabled = busy;
    slideTabsEl.querySelectorAll("button").forEach(function (button) {
      button.disabled = busy;
    });
    slideGridEl.querySelectorAll("button").forEach(function (button) {
      button.disabled = busy;
    });
  }

  function frameTitle(frame, index) {
    return (frame && frame.name ? String(frame.name).trim() : "") || "幻灯片 " + (index + 1);
  }

  function frameSearchText(frame, index) {
    return [String(index + 1), frameTitle(frame, index), frame && frame.id].join(" ").toLowerCase();
  }

  function compactFrameItems(frames, activeIndex) {
    var count = frames.length;
    if (count <= 8) {
      return frames.map(function (_, index) { return { type: "frame", index: index }; });
    }
    var visible = {};
    [0, count - 1].forEach(function (index) { visible[index] = true; });
    for (var offset = -2; offset <= 2; offset++) {
      var index = activeIndex + offset;
      if (index >= 0 && index < count) visible[index] = true;
    }
    var indices = Object.keys(visible).map(Number).sort(function (a, b) { return a - b; });
    var items = [];
    indices.forEach(function (index, position) {
      if (position > 0 && index - indices[position - 1] > 1) {
        items.push({ type: "ellipsis", from: indices[position - 1] + 1, to: index - 1 });
      }
      items.push({ type: "frame", index: index });
    });
    return items;
  }

  function frameViewport(frame) {
    var viewportW = Math.max(800, window.innerWidth || 1280);
    var viewportH = Math.max(600, window.innerHeight || 720);
    var margin = 180;
    var zoom = Math.min(
      (viewportW - margin) / Math.max(1, frame.width || 1600),
      (viewportH - margin) / Math.max(1, frame.height || 900),
      1,
    );
    zoom = Math.max(0.12, Math.min(1, zoom));
    return {
      scrollX: viewportW / (2 * zoom) - ((frame.x || 0) + (frame.width || 0) / 2),
      scrollY: viewportH / (2 * zoom) - ((frame.y || 0) + (frame.height || 0) / 2),
      zoom: { value: zoom },
      selectedElementIds: {},
      selectedGroupIds: {},
      editingElement: null,
      showWelcomeScreen: false,
    };
  }

  function editorViewportSize() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 720;
    try {
      var host =
        document.querySelector(".excalidraw-container") ||
        document.querySelector(".excalidraw") ||
        document.querySelector(".excalidraw__canvas") ||
        null;
      if (host) {
        var rect = host.getBoundingClientRect();
        if (rect && rect.width > 100 && rect.height > 100) {
          w = rect.width;
          h = rect.height;
        }
      }
    } catch (err) {}
    return { w: Math.max(400, w), h: Math.max(300, h) };
  }

  function fitWhiteboardViewport(elements) {
    var size = editorViewportSize();
    var viewportW = size.w;
    var viewportH = size.h;
    var margin = 140;
    var visible = (elements || []).filter(function (el) {
      return el && !el.isDeleted;
    });
    var frameOnly = visible.filter(function (el) {
      return el.type === "frame";
    });
    /* 鸟瞰以所有 Frame 的整体为基准，保证中心对准 Frame 布局；
       若场景还没有 Frame，则回退到全部元素。 */
    var target = frameOnly.length ? frameOnly : visible;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    target.forEach(function (el) {
      var x = Number(el.x) || 0;
      var y = Number(el.y) || 0;
      var w = Math.max(0, Number(el.width) || 0);
      var h = Math.max(0, Number(el.height) || 0);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    });
    if (!isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 1600;
      maxY = 900;
    }
    var contentW = Math.max(1, maxX - minX);
    var contentH = Math.max(1, maxY - minY);
    var zoom = Math.min(
      (viewportW - margin) / contentW,
      (viewportH - margin) / contentH,
      0.9,
    );
    /* 允许更小的缩放：Frame 数量很多时（如 50+）仍能完整显示整块白板 */
    zoom = Math.max(0.01, Math.min(1, zoom));
    var centerX = (minX + maxX) / 2;
    var centerY = (minY + maxY) / 2;
    return {
      /* Excalidraw 屏幕坐标为 (scene + scroll) * zoom，因此平移量应为
         视口中心的场景坐标减去内容中心，而不是相反。 */
      scrollX: viewportW / (2 * zoom) - centerX,
      scrollY: viewportH / (2 * zoom) - centerY,
      zoom: { value: zoom },
      selectedElementIds: {},
      selectedGroupIds: {},
      editingElement: null,
      showWelcomeScreen: false,
    };
  }

  function showWhiteboardOverview(sourceElements) {
    var api = getLiveExcalidrawAPI();
    var hasSourceElements = Array.isArray(sourceElements);
    var elements = hasSourceElements ? sourceElements : readElementsSafe();
    if (!hasSourceElements && api) {
      try {
        elements = api.getSceneElementsIncludingDeleted();
      } catch (err) {
        console.warn("Excalicord fit-whiteboard read fallback", err);
      }
    }
    var patch = fitWhiteboardViewport(elements);
    writeAppStatePatch(patch);
    if (api) {
      try {
        api.updateScene({
          appState: {
            scrollX: patch.scrollX,
            scrollY: patch.scrollY,
            zoom: patch.zoom,
            selectedElementIds: {},
            selectedGroupIds: {},
            editingElement: null,
          },
        });
      } catch (err) {}
    }
    /* 鸟瞰不属于任何单个 Frame，清除聚焦模式留下的旧 ?frame= 参数，
       否则 currentFrameId() 会持续用旧 URL 覆盖新增页状态。 */
    try {
      if (new URLSearchParams(location.search).has("frame")) {
        history.replaceState(null, "", location.pathname);
      }
    } catch (err) {}
    return true;
  }

  function updateViewFrameSelect() {
    var frames = getFrames();
    var activeId = currentFrameId(frames);
    viewFrameSelect.innerHTML = "";
    frames.forEach(function (frame, index) {
      var option = document.createElement("option");
      option.value = frame.id;
      option.textContent = String(index + 1) + " · " + frameTitle(frame, index);
      option.selected = frame.id === activeId;
      viewFrameSelect.appendChild(option);
    });
    viewFrameSelect.disabled = !frames.length;
    viewCurrentBtn.disabled = !frames.length;
  }

  function setControlTab(tab) {
    var settingsActive = tab === "settings";
    controlTabView.classList.toggle("ec-active", !settingsActive);
    controlTabSettings.classList.toggle("ec-active", settingsActive);
    controlTabView.setAttribute("aria-selected", settingsActive ? "false" : "true");
    controlTabSettings.setAttribute("aria-selected", settingsActive ? "true" : "false");
    controlPageView.classList.toggle("ec-active", !settingsActive);
    controlPageSettings.classList.toggle("ec-active", settingsActive);
    controlPageView.hidden = settingsActive;
    controlPageSettings.hidden = !settingsActive;
  }

  function setViewToolsOpen(open, tab) {
    if (open) {
      closeSlideOverview();
      if (typeof setPanelOpen === "function") setPanelOpen(false);
      updateViewFrameSelect();
      setControlTab(tab === "settings" ? "settings" : "view");
      viewToolsEl.classList.add("ec-open");
      viewToolsEl.setAttribute("aria-hidden", "false");
      viewToolsToggle.classList.add("ec-active");
    } else {
      viewToolsEl.classList.remove("ec-open");
      viewToolsEl.setAttribute("aria-hidden", "true");
      viewToolsToggle.classList.remove("ec-active");
    }
  }

  function applyDockPosition(position, showToast) {
    var allowed = ["left", "right", "top", "bottom"];
    var next = allowed.indexOf(position) >= 0 ? position : "right";
    currentDockPosition = next;
    allowed.forEach(function (candidate) {
      host.classList.remove("ec-dock-" + candidate);
    });
    host.classList.add("ec-dock-" + next);
    localStorage.setItem(DOCK_POSITION_KEY, next);
    dockChoiceButtons.forEach(function (button) {
      var active = button.getAttribute("data-dock") === next;
      button.classList.toggle("ec-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (showToast) {
      var labels = { left: "左侧", right: "右侧", top: "顶部", bottom: "底部" };
      toast("悬浮栏已移到" + labels[next]);
    }
  }

  function effectiveDockPosition() {
    try {
      if (window.matchMedia("(max-width: 520px)").matches) return "bottom";
    } catch (err) {}
    return currentDockPosition;
  }

  function presentFrameAt(index, animate) {
    var frames = getFrames();
    if (!frames.length) return false;
    presentationState.index = Math.max(0, Math.min(frames.length - 1, Number(index) || 0));
    var frame = frames[presentationState.index];
    v011RecordFrameChange(frame, "presentation");
    presenterTitle.textContent = frameTitle(frame, presentationState.index);
    presenterCount.textContent = String(presentationState.index + 1) + " / " + String(frames.length);
    presenterProgressBar.style.width = ((presentationState.index + 1) / frames.length * 100) + "%";
    presenterPrev.disabled = presentationState.index <= 0;
    presenterPrevSmall.disabled = presentationState.index <= 0;
    presenterNext.disabled = presentationState.index >= frames.length - 1;
    presenterNextSmall.disabled = presentationState.index >= frames.length - 1;
    var api = getLiveExcalidrawAPI();
    if (!api) return false;
    try {
      api.updateScene({
        appState: {
          selectedElementIds: {},
          selectedGroupIds: {},
          editingElement: null,
          gridModeEnabled: false,
          frameRendering: {
            enabled: true,
            clip: true,
            name: false,
            outline: false,
          },
        },
      });
      api.setViewport({ target: frame, fit: "scale-down", animation: animate !== false });
      return true;
    } catch (err) {
      return false;
    }
  }

  function stepPresentation(delta) {
    if (!presentationState.active) return;
    var frames = getFrames();
    var nextIndex = presentationState.index + delta;
    if (nextIndex < 0) {
      toast("已经是第一张幻灯片");
      return;
    }
    if (nextIndex >= frames.length) {
      toast("演示已到最后一张");
      return;
    }
    presentFrameAt(nextIndex, true);
  }

  function startPresentation() {
    if (presentationState.active) return;
    var frames = getFrames();
    var api = getLiveExcalidrawAPI();
    if (!frames.length || !api) {
      toast("没有可播放的幻灯片");
      return;
    }
    var currentId = currentFrameId(frames);
    var currentIndex = frames.findIndex(function (frame) { return frame.id === currentId; });
    var appState = api.getAppState();
    presentationState.previousFrameId = currentId;
    presentationState.previousAppState = {
      scrollX: Number(appState.scrollX) || 0,
      scrollY: Number(appState.scrollY) || 0,
      zoom: appState.zoom ? { value: Number(appState.zoom.value) || 1 } : { value: 1 },
      selectedElementIds: Object.assign({}, appState.selectedElementIds || {}),
      selectedGroupIds: Object.assign({}, appState.selectedGroupIds || {}),
      gridModeEnabled: Boolean(appState.gridModeEnabled),
      frameRendering: Object.assign({}, appState.frameRendering || {
        enabled: true,
        clip: true,
        name: true,
        outline: true,
      }),
    };
    presentationState.active = true;
    closeSlideOverview();
    closeSlideSettings();
    setViewToolsOpen(false);
    if (typeof setPanelOpen === "function") setPanelOpen(false);
    document.documentElement.classList.add("ec-presentation");
    host.classList.add("ec-presenting");
    presenterEl.classList.add("ec-open");
    presenterEl.setAttribute("aria-hidden", "false");
    presentFrameAt(currentIndex >= 0 ? currentIndex : 0, false);
    try {
      var fullscreenRequest = document.documentElement.requestFullscreen &&
        document.documentElement.requestFullscreen();
      if (fullscreenRequest && typeof fullscreenRequest.catch === "function") {
        fullscreenRequest.catch(function () {
          toast("浏览器未进入全屏，已开启演示模式");
        });
      }
    } catch (err) {
      toast("浏览器未进入全屏，已开启演示模式");
    }
    window.setTimeout(function () {
      if (presentationState.active) presentFrameAt(presentationState.index, false);
    }, 260);
  }

  function exitPresentation(skipFullscreenExit) {
    if (!presentationState.active) return;
    presentationState.active = false;
    presenterEl.classList.remove("ec-open");
    presenterEl.setAttribute("aria-hidden", "true");
    host.classList.remove("ec-presenting");
    document.documentElement.classList.remove("ec-presentation");
    if (!skipFullscreenExit && document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen(); } catch (err) {}
    }
    var api = getLiveExcalidrawAPI();
    var previous = presentationState.previousAppState;
    if (api && previous) {
      try { api.updateScene({ appState: previous }); } catch (err) {}
      writeAppStatePatch(previous);
    }
    if (presentationState.previousFrameId) {
      localStorage.setItem(ACTIVE_FRAME_KEY, presentationState.previousFrameId);
      try {
        history.replaceState(
          null,
          "",
          location.pathname + "?frame=" + encodeURIComponent(presentationState.previousFrameId),
        );
      } catch (err) {}
    }
    renderFrameTabs();
    toast("已退出幻灯片演示");
  }

  function zoomWhiteboardView(mode) {
    var api = getLiveExcalidrawAPI();
    if (!api) {
      toast("画板尚未准备好，请稍后再试");
      return;
    }
    try {
      /* 直接复用 Excalidraw 自带的缩放按钮。它会使用真实画布中心作为
         锚点，并遵守编辑器自身的最小/最大缩放边界。手工计算不仅容易
         忽略工具栏占用的区域，旧实现还误用了 viewport.width/height
         （editorViewportSize 返回的是 w/h），导致 scrollX/scrollY 变为 NaN。 */
      var selector = mode === "reset"
        ? ".reset-zoom-button"
        : mode === "in"
          ? ".zoom-in-button"
          : ".zoom-out-button";
      var nativeButton = document.querySelector(".excalidraw " + selector) ||
        document.querySelector(selector);
      if (!nativeButton) throw new Error("native zoom control unavailable");
      if (nativeButton.disabled) {
        toast(mode === "in" ? "已是最大缩放" : "已是最小缩放");
        return;
      }
      nativeButton.click();
      window.setTimeout(function () {
        try {
          var nextState = api.getAppState();
          var nextZoom = nextState.zoom && Number(nextState.zoom.value) > 0
            ? Number(nextState.zoom.value)
            : 1;
          /* 全局鸟瞰的几何中心可能正好位于多页之间的空白处。倍率改变后
             将当前页中心重新放到真实编辑区中心，确保画面里始终有内容。 */
          var frames = getFrames();
          var activeId = currentFrameId(frames);
          var activeFrame = frames.find(function (frame) {
            return frame.id === activeId;
          }) || frames[0];
          if (activeFrame) {
            var viewport = editorViewportSize();
            var frameCenterX = (Number(activeFrame.x) || 0) +
              (Number(activeFrame.width) || 0) / 2;
            var frameCenterY = (Number(activeFrame.y) || 0) +
              (Number(activeFrame.height) || 0) / 2;
            var patch = {
              scrollX: viewport.w / (2 * nextZoom) - frameCenterX,
              scrollY: viewport.h / (2 * nextZoom) - frameCenterY,
            };
            api.updateScene({ appState: patch });
            writeAppStatePatch(patch);
          }
          toast("视图缩放至 " + Math.round(nextZoom * 100) + "%");
        } catch (err) {}
      }, 0);
    } catch (err) {
      toast("视图缩放失败");
    }
  }

  /* 保存 scene.excalidraw 会推进 scene.json 版本，页面轮询随后会自动刷新。
     用 sessionStorage 记住本次新增需要鸟瞰，待刷新后的真实场景加载完成再恢复视口。 */
  function restorePendingOverview(attempt) {
    if (sessionStorage.getItem(PENDING_OVERVIEW_KEY) !== "1") return;
    var api = getLiveExcalidrawAPI();
    var frames = getFrames();
    if ((!api || !frames.length) && (attempt || 0) < 20) {
      window.setTimeout(function () {
        restorePendingOverview((attempt || 0) + 1);
      }, 150);
      return;
    }
    if (!frames.length) {
      sessionStorage.removeItem(PENDING_OVERVIEW_KEY);
      return;
    }
    showWhiteboardOverview(frames);
    window.setTimeout(function () {
      showWhiteboardOverview(frames);
    }, 160);
    sessionStorage.removeItem(PENDING_OVERVIEW_KEY);
  }

  function navigateToFrame(frame) {
    localStorage.setItem(ACTIVE_FRAME_KEY, frame.id);
    v011RecordFrameChange(frame, "navigation");
    writeAppStatePatch(frameViewport(frame));
    if (window.__excalicordSuppressProps) window.__excalicordSuppressProps();

    var api = getLiveExcalidrawAPI();
    if (api) {
      try {
        api.updateScene({
          appState: {
            selectedElementIds: {},
            selectedGroupIds: {},
            editingElement: null,
          },
        });
        api.setViewport({
          target: frame,
          fit: "scale-down",
          animation: true,
        });
        history.replaceState(
          null,
          "",
          location.pathname + "?frame=" + encodeURIComponent(frame.id),
        );
        window.setTimeout(function () {
          renderFrameTabs();
          setSlideBusy(false);
          if (window.__excalicordSuppressProps) window.__excalicordSuppressProps();
        }, 360);
        return;
      } catch (err) {
        console.warn("Excalicord Frame navigation fallback", err);
      }
    }

    location.replace(
      location.pathname +
        "?frame=" +
        encodeURIComponent(frame.id) +
        "&t=" +
        Date.now(),
    );
  }

  /* 新增 Frame 通过 updateScene(elements) 异步进入实时场景。元素很多时，
     立即 setViewport() 可能找不到新 Frame 并保留旧视口，因此先等待提交可见。 */
  function focusFrameAfterSceneCommit(frame, attempt) {
    var api = getLiveExcalidrawAPI();
    if (!api && (attempt || 0) < 15) {
      window.setTimeout(function () {
        focusFrameAfterSceneCommit(frame, (attempt || 0) + 1);
      }, 80);
      return;
    }
    if (!api) {
      navigateToFrame(frame);
      toast("已新增幻灯片，已聚焦到新幻灯片");
      return;
    }
    var ready = false;
    try {
      ready = api.getSceneElementsIncludingDeleted().some(function (element) {
        return element && element.id === frame.id && !element.isDeleted;
      });
    } catch (err) {}
    if (!ready && (attempt || 0) < 15) {
      window.setTimeout(function () {
        focusFrameAfterSceneCommit(frame, (attempt || 0) + 1);
      }, 80);
      return;
    }
    navigateToFrame(frame);
    /* setViewport 已收到实时场景中的新 Frame；再校准一次可覆盖同一帧内的
       旧视口提交，但不依赖固定的场景大小或设备速度。 */
    window.setTimeout(function () {
      var liveApi = getLiveExcalidrawAPI();
      if (!liveApi) return;
      try {
        liveApi.setViewport({ target: frame, fit: "scale-down", animation: false });
      } catch (err) {}
    }, 120);
    toast("已新增幻灯片，已聚焦到新幻灯片");
  }

  function switchFrame(id) {
    if (slideBusy) return;
    var frame = getFrames().find(function (candidate) {
      return candidate.id === id;
    });
    if (!frame) return;
    setSlideBusy(true);
    toast("正在聚焦到幻灯片…");
    window.setTimeout(function () {
      navigateToFrame(frame);
    }, 120);
  }

  function elementRight(element) {
    return (Number(element.x) || 0) + Math.max(0, Number(element.width) || 0);
  }

  function createFrameElement(index, x, y) {
    var now = Date.now();
    var id = newElementId("frame");
    return {
      id: id,
      type: "frame",
      x: x,
      y: y,
      width: 1600,
      height: 900,
      angle: 0,
      strokeColor: "#8b5cf6",
      backgroundColor: "#fffdf8",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "dashed",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: randomNonce(),
      version: 1,
      versionNonce: randomNonce(),
      isDeleted: false,
      boundElements: [],
      updated: now,
      link: null,
      locked: false,
      name: "幻灯片 " + index,
      customData: { excalicordFrame: true, excalicordOrder: index - 1 },
    };
  }

  function sortFramesForLayout(frames) {
    return (frames || []).slice().sort(function (a, b) {
      var orderA = a.customData && Number(a.customData.excalicordOrder);
      var orderB = b.customData && Number(b.customData.excalicordOrder);
      var hasA = Number.isFinite(orderA);
      var hasB = Number.isFinite(orderB);
      if (hasA || hasB) {
        if (!hasA) orderA = Number.MAX_SAFE_INTEGER;
        if (!hasB) orderB = Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
      }
      if (Math.abs((a.y || 0) - (b.y || 0)) > 80) return (a.y || 0) - (b.y || 0);
      return (a.x || 0) - (b.x || 0);
    });
  }

  function standardizeFrameLayout(elements, orderedFrameIds) {
    var frames = (elements || []).filter(function (element) {
      return element && element.type === "frame" && !element.isDeleted;
    });
    if (!frames.length) return false;
    var requestedOrder = {};
    (orderedFrameIds || []).forEach(function (id, index) {
      requestedOrder[id] = index;
    });
    frames = frames.slice().sort(function (a, b) {
      var ai = Object.prototype.hasOwnProperty.call(requestedOrder, a.id)
        ? requestedOrder[a.id]
        : Number.MAX_SAFE_INTEGER;
      var bi = Object.prototype.hasOwnProperty.call(requestedOrder, b.id)
        ? requestedOrder[b.id]
        : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return sortFramesForLayout([a, b])[0] === a ? -1 : 1;
    });
    var boundsById = {};
    frames.forEach(function (frame) {
      boundsById[frame.id] = {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1600),
        height: Math.max(1, Number(frame.height) || 900),
      };
    });
    var anchorX = Math.min.apply(null, frames.map(function (frame) {
      return boundsById[frame.id].x;
    }));
    var anchorY = Math.min.apply(null, frames.map(function (frame) {
      return boundsById[frame.id].y;
    }));
    var cellWidth = Math.max.apply(null, frames.map(function (frame) {
      return boundsById[frame.id].width;
    })) + SLIDE_GAP;
    var cellHeight = Math.max.apply(null, frames.map(function (frame) {
      return boundsById[frame.id].height;
    })) + SLIDE_GAP;
    var moveById = {};
    var changed = false;
    var now = Date.now();
    frames.forEach(function (frame, index) {
      var old = boundsById[frame.id];
      var targetX = anchorX + (index % SLIDE_COLUMNS) * cellWidth;
      var targetY = anchorY + Math.floor(index / SLIDE_COLUMNS) * cellHeight;
      var dx = targetX - old.x;
      var dy = targetY - old.y;
      moveById[frame.id] = { dx: dx, dy: dy };
      var oldOrder = frame.customData && Number(frame.customData.excalicordOrder);
      if (dx || dy || oldOrder !== index) {
        frame.x = targetX;
        frame.y = targetY;
        frame.customData = Object.assign({}, frame.customData || {}, {
          excalicordFrame: true,
          excalicordOrder: index,
        });
        frame.version = (Number(frame.version) || 1) + 1;
        frame.versionNonce = randomNonce();
        frame.updated = now;
        changed = true;
      }
    });
    function containingFrameId(element) {
      var centerX = (Number(element.x) || 0) + Math.abs(Number(element.width) || 0) / 2;
      var centerY = (Number(element.y) || 0) + Math.abs(Number(element.height) || 0) / 2;
      for (var i = 0; i < frames.length; i++) {
        var bounds = boundsById[frames[i].id];
        if (
          centerX >= bounds.x && centerX <= bounds.x + bounds.width &&
          centerY >= bounds.y && centerY <= bounds.y + bounds.height
        ) return frames[i].id;
      }
      return "";
    }
    (elements || []).forEach(function (element) {
      if (!element || element.isDeleted || element.type === "frame") return;
      var ownerId = element.frameId || containingFrameId(element);
      var move = moveById[ownerId];
      if (!move || (!move.dx && !move.dy)) return;
      element.x = (Number(element.x) || 0) + move.dx;
      element.y = (Number(element.y) || 0) + move.dy;
      element.version = (Number(element.version) || 1) + 1;
      element.versionNonce = randomNonce();
      element.updated = now;
      changed = true;
    });
    return changed;
  }

  function applyGridSettings(showToast, changedSetting) {
    var snapEnabled = Boolean(slideGridSnap && slideGridSnap.checked);
    var gridVisible = Boolean(slideGridVisible && slideGridVisible.checked);
    localStorage.setItem(SLIDE_GRID_SNAP_KEY, snapEnabled ? "1" : "0");
    localStorage.setItem(SLIDE_GRID_VISIBLE_KEY, gridVisible ? "1" : "0");
    var patch = {
      gridModeEnabled: gridVisible,
      gridSize: 20,
      gridStep: 5,
    };
    writeAppStatePatch(patch);
    var api = getLiveExcalidrawAPI();
    try { if (api) api.updateScene({ appState: patch }); } catch (err) {}
    if (showToast && changedSetting === "visible") {
      toast(gridVisible ? "已显示白板网格" : "已隐藏白板网格");
    } else if (showToast) {
      toast(snapEnabled ? "已开启幻灯片智能吸附" : "已关闭幻灯片智能吸附");
    }
  }

  function hideFrameSmartGuides() {
    smartGuidesEl.classList.remove("ec-open");
    smartGuidesEl.setAttribute("aria-hidden", "true");
    smartGuideV.classList.remove("ec-visible");
    smartGuideH.classList.remove("ec-visible");
  }

  function updateFrameSmartGuides() {
    frameGuideState.raf = 0;
    if (!frameGuideState.active || !slideGridSnap.checked || presentationState.active) {
      hideFrameSmartGuides();
      return;
    }
    var api = getLiveExcalidrawAPI();
    if (!api) return;
    var elements;
    var appState;
    try {
      elements = api.getSceneElementsIncludingDeleted();
      appState = api.getAppState();
    } catch (err) {
      return;
    }
    var frame = elements.find(function (element) {
      return element && element.id === frameGuideState.frameId && element.type === "frame" && !element.isDeleted;
    });
    if (!frame) return;
    var others = elements.filter(function (element) {
      return element && element.type === "frame" && !element.isDeleted && element.id !== frame.id;
    });
    var zoom = appState.zoom && Number(appState.zoom.value) > 0 ? Number(appState.zoom.value) : 1;
    var tolerance = 12 / zoom;
    var frameX = Number(frame.x) || 0;
    var frameY = Number(frame.y) || 0;
    var frameW = Math.max(0, Number(frame.width) || 0);
    var frameH = Math.max(0, Number(frame.height) || 0);
    frameGuideState.hasChanged = frameGuideState.hasChanged ||
      Math.abs(frameX - frameGuideState.startX) > 0.5 ||
      Math.abs(frameY - frameGuideState.startY) > 0.5 ||
      Math.abs(frameW - frameGuideState.startW) > 0.5 ||
      Math.abs(frameH - frameGuideState.startH) > 0.5;
    if (!frameGuideState.hasChanged) {
      hideFrameSmartGuides();
      return;
    }
    var xAnchors = [
      { label: "左边对齐", value: frameX },
      { label: "中心对齐", value: frameX + frameW / 2 },
      { label: "右边对齐", value: frameX + frameW },
    ];
    var yAnchors = [
      { label: "顶部对齐", value: frameY },
      { label: "中心对齐", value: frameY + frameH / 2 },
      { label: "底部对齐", value: frameY + frameH },
    ];
    var bestX = null;
    var bestY = null;
    var resizingNow = Math.abs(frameW - frameGuideState.startW) > 0.5 ||
      Math.abs(frameH - frameGuideState.startH) > 0.5;
    var alignXActive = !resizingNow ||
      Math.abs(frameX - frameGuideState.startX) > 0.5 ||
      Math.abs(frameW - frameGuideState.startW) > 0.5;
    var alignYActive = !resizingNow ||
      Math.abs(frameY - frameGuideState.startY) > 0.5 ||
      Math.abs(frameH - frameGuideState.startH) > 0.5;
    others.forEach(function (other) {
      var ox = Number(other.x) || 0;
      var oy = Number(other.y) || 0;
      var ow = Math.max(0, Number(other.width) || 0);
      var oh = Math.max(0, Number(other.height) || 0);
      var otherX = [ox, ox + ow / 2, ox + ow];
      var otherY = [oy, oy + oh / 2, oy + oh];
      if (alignXActive) {
        xAnchors.forEach(function (anchor, anchorIndex) {
          otherX.forEach(function (targetValue, targetIndex) {
            var diff = targetValue - anchor.value;
            if (Math.abs(diff) <= tolerance && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
              bestX = {
                diff: diff,
                value: targetValue,
                label: anchorIndex === targetIndex ? anchor.label : "垂直边缘对齐",
                index: anchorIndex,
                other: other,
              };
            }
          });
        });
      }
      if (alignYActive) {
        yAnchors.forEach(function (anchor, anchorIndex) {
          otherY.forEach(function (targetValue, targetIndex) {
            var diff = targetValue - anchor.value;
            if (Math.abs(diff) <= tolerance && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
              bestY = {
                diff: diff,
                value: targetValue,
                label: anchorIndex === targetIndex ? anchor.label : "水平边缘对齐",
                index: anchorIndex,
                other: other,
              };
            }
          });
        });
      }
    });
    frameGuideState.snapDx = bestX ? bestX.diff : 0;
    frameGuideState.snapDy = bestY ? bestY.diff : 0;
    frameGuideState.snapXIndex = bestX ? bestX.index : -1;
    frameGuideState.snapYIndex = bestY ? bestY.index : -1;
    frameGuideState.matchedX = Boolean(bestX);
    frameGuideState.matchedY = Boolean(bestY);
    var canvasHost = document.querySelector(".excalidraw-container") || document.querySelector(".excalidraw");
    var rect = canvasHost ? canvasHost.getBoundingClientRect() : { left: 0, top: 0 };
    var scrollX = Number(appState.scrollX) || 0;
    var scrollY = Number(appState.scrollY) || 0;
    function screenX(sceneX) { return rect.left + (sceneX + scrollX) * zoom; }
    function screenY(sceneY) { return rect.top + (sceneY + scrollY) * zoom; }
    if (bestX) {
      var minY = Math.min(frameY, Number(bestX.other.y) || 0);
      var maxY = Math.max(frameY + frameH, (Number(bestX.other.y) || 0) + (Number(bestX.other.height) || 0));
      smartGuideV.style.left = screenX(bestX.value) + "px";
      smartGuideV.style.top = screenY(minY) + "px";
      smartGuideV.style.height = Math.max(24, (maxY - minY) * zoom) + "px";
      smartGuideV.querySelector("span").textContent = bestX.label;
      smartGuideV.classList.add("ec-visible");
    } else {
      smartGuideV.classList.remove("ec-visible");
    }
    if (bestY) {
      var minX = Math.min(frameX, Number(bestY.other.x) || 0);
      var maxX = Math.max(frameX + frameW, (Number(bestY.other.x) || 0) + (Number(bestY.other.width) || 0));
      smartGuideH.style.left = screenX(minX) + "px";
      smartGuideH.style.top = screenY(bestY.value) + "px";
      smartGuideH.style.width = Math.max(24, (maxX - minX) * zoom) + "px";
      smartGuideH.querySelector("span").textContent = bestY.label;
      smartGuideH.classList.add("ec-visible");
    } else {
      smartGuideH.classList.remove("ec-visible");
    }
    if (bestX || bestY) {
      smartGuidesEl.classList.add("ec-open");
      smartGuidesEl.setAttribute("aria-hidden", "false");
    } else {
      hideFrameSmartGuides();
    }
  }

  function beginFrameSmartGuides() {
    if (!frameGuideState.pointerDown || !slideGridSnap.checked || presentationState.active) return;
    var api = getLiveExcalidrawAPI();
    if (!api) return;
    try {
      var appState = api.getAppState();
      var selected = appState.selectedElementIds || {};
      var selectedIds = Object.keys(selected).filter(function (id) { return selected[id]; });
      var frames = api.getSceneElementsIncludingDeleted().filter(function (element) {
        return element && element.type === "frame" && !element.isDeleted && selectedIds.indexOf(element.id) >= 0;
      });
      if (frames.length !== 1) return;
      frameGuideState.active = true;
      frameGuideState.frameId = frames[0].id;
      frameGuideState.startX = Number(frames[0].x) || 0;
      frameGuideState.startY = Number(frames[0].y) || 0;
      frameGuideState.startW = Math.max(0, Number(frames[0].width) || 0);
      frameGuideState.startH = Math.max(0, Number(frames[0].height) || 0);
      frameGuideState.hasChanged = false;
      frameGuideState.snapDx = 0;
      frameGuideState.snapDy = 0;
      frameGuideState.snapXIndex = -1;
      frameGuideState.snapYIndex = -1;
      frameGuideState.matchedX = false;
      frameGuideState.matchedY = false;
    } catch (err) {}
  }

  function commitFrameSmartGuideSnap() {
    if (!frameGuideState.active) return;
    var frameId = frameGuideState.frameId;
    var guideDx = frameGuideState.snapDx;
    var guideDy = frameGuideState.snapDy;
    var snapXIndex = frameGuideState.snapXIndex;
    var snapYIndex = frameGuideState.snapYIndex;
    var matchedX = frameGuideState.matchedX;
    var matchedY = frameGuideState.matchedY;
    var startX = frameGuideState.startX;
    var startY = frameGuideState.startY;
    var startW = frameGuideState.startW;
    var startH = frameGuideState.startH;
    var hasChanged = frameGuideState.hasChanged;
    frameGuideState.active = false;
    frameGuideState.frameId = "";
    hideFrameSmartGuides();
    if (!hasChanged) return;
    window.setTimeout(function () {
      var api = getLiveExcalidrawAPI();
      if (!api || !slideGridSnap.checked) return;
      var elements;
      try { elements = api.getSceneElementsIncludingDeleted(); } catch (err) { return; }
      elements = elements.map(function (element) {
        return element ? Object.assign({}, element) : element;
      });
      var frame = elements.find(function (element) {
        return element && element.id === frameId && element.type === "frame" && !element.isDeleted;
      });
      if (!frame) return;
      var x = Number(frame.x) || 0;
      var y = Number(frame.y) || 0;
      var w = Math.max(1, Number(frame.width) || 1);
      var h = Math.max(1, Number(frame.height) || 1);
      var leftChanged = Math.abs(x - startX) > 0.5;
      var topChanged = Math.abs(y - startY) > 0.5;
      var rightChanged = Math.abs((x + w) - (startX + startW)) > 0.5;
      var bottomChanged = Math.abs((y + h) - (startY + startH)) > 0.5;
      var resizing = Math.abs(w - startW) > 0.5 || Math.abs(h - startH) > 0.5;
      var horizontalResize = Math.abs(x - startX) > 0.5 || Math.abs(w - startW) > 0.5;
      var verticalResize = Math.abs(y - startY) > 0.5 || Math.abs(h - startH) > 0.5;
      var now = Date.now();
      if (resizing) {
        var nextX = x;
        var nextY = y;
        var nextW = w;
        var nextH = h;
        if (horizontalResize && matchedX) {
          if (snapXIndex === 0) {
            nextX += guideDx;
            nextW -= guideDx;
          } else if (snapXIndex === 2) {
            nextW += guideDx;
          } else if (leftChanged && !rightChanged) {
            nextX += guideDx * 2;
            nextW -= guideDx * 2;
          } else {
            nextW += guideDx * 2;
          }
        } else if (horizontalResize && leftChanged && !rightChanged) {
          var gridLeft = Math.round(x / 20) * 20;
          nextW -= gridLeft - x;
          nextX = gridLeft;
        } else if (horizontalResize && rightChanged) {
          nextW += Math.round((x + w) / 20) * 20 - (x + w);
        }
        if (verticalResize && matchedY) {
          if (snapYIndex === 0) {
            nextY += guideDy;
            nextH -= guideDy;
          } else if (snapYIndex === 2) {
            nextH += guideDy;
          } else if (topChanged && !bottomChanged) {
            nextY += guideDy * 2;
            nextH -= guideDy * 2;
          } else {
            nextH += guideDy * 2;
          }
        } else if (verticalResize && topChanged && !bottomChanged) {
          var gridTop = Math.round(y / 20) * 20;
          nextH -= gridTop - y;
          nextY = gridTop;
        } else if (verticalResize && bottomChanged) {
          nextH += Math.round((y + h) / 20) * 20 - (y + h);
        }
        nextW = Math.max(80, nextW);
        nextH = Math.max(45, nextH);
        if (nextX === x && nextY === y && nextW === w && nextH === h) return;
        frame.x = nextX;
        frame.y = nextY;
        frame.width = nextW;
        frame.height = nextH;
        frame.version = (Number(frame.version) || 1) + 1;
        frame.versionNonce = randomNonce();
        frame.updated = now;
      } else {
        var dx = matchedX ? guideDx : Math.round(x / 20) * 20 - x;
        var dy = matchedY ? guideDy : Math.round(y / 20) * 20 - y;
        if (!dx && !dy) return;
        elements.forEach(function (element) {
          if (!element || element.isDeleted) return;
          if (element.id !== frameId && element.frameId !== frameId) return;
          element.x = (Number(element.x) || 0) + dx;
          element.y = (Number(element.y) || 0) + dy;
          element.version = (Number(element.version) || 1) + 1;
          element.versionNonce = randomNonce();
          element.updated = now;
        });
      }
      writeElementsSafe(elements);
      persistSceneToServer(elements);
      try { api.updateScene({ elements: elements }); } catch (err) {}
      if ((!resizing && (matchedX || matchedY)) ||
          (resizing && ((horizontalResize && matchedX) || (verticalResize && matchedY)))) {
        toast(resizing ? "幻灯片边框已吸附到对齐参考线" : "幻灯片已吸附到对齐参考线");
      }
    }, 60);
  }

  function ensureStandardFrameLayoutOnce() {
    if (localStorage.getItem(STANDARD_LAYOUT_MIGRATION_KEY) === "1") return false;
    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    if (api) {
      try { elements = api.getSceneElementsIncludingDeleted(); } catch (err) {}
    }
    elements = (elements || []).map(function (element) {
      return element ? Object.assign({}, element) : element;
    });
    var frames = sortFramesForLayout(elements.filter(function (element) {
      return element && element.type === "frame" && !element.isDeleted;
    }));
    var changed = standardizeFrameLayout(elements, frames.map(function (frame) { return frame.id; }));
    if (changed) {
      if (!writeElementsSafe(elements)) return false;
      persistSceneToServer(elements);
      try { if (api) api.updateScene({ elements: elements }); } catch (err) {}
      showWhiteboardOverview(elements);
      window.setTimeout(function () {
        showWhiteboardOverview(elements);
      }, 140);
    }
    localStorage.setItem(STANDARD_LAYOUT_MIGRATION_KEY, "1");
    return changed;
  }

  function runWhiteboardHistoryCommand(mode) {
    var labels = mode === "undo" ? ["撤销", "Undo"] : ["重做", "Redo"];
    var button = Array.prototype.find.call(document.querySelectorAll("button[aria-label]"), function (candidate) {
      return labels.indexOf(candidate.getAttribute("aria-label")) >= 0;
    });
    if (!button || button.disabled) {
      toast(mode === "undo" ? "没有可撤回的操作" : "没有可恢复的操作");
      return false;
    }
    button.click();
    toast(mode === "undo" ? "已撤回一步" : "已前进一步");
    return true;
  }

  function deleteFrames(frameIds) {
    if (slideBusy) return false;
    var deleteSet = {};
    (frameIds || []).forEach(function (id) {
      if (id) deleteSet[id] = true;
    });
    var requestedIds = Object.keys(deleteSet);
    if (!requestedIds.length) return false;

    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    if (api) {
      try { elements = api.getSceneElementsIncludingDeleted(); } catch (err) {}
    }
    elements = (elements || []).map(function (element) {
      return element ? Object.assign({}, element) : element;
    });
    var originalFrames = sortFramesForLayout(elements.filter(function (element) {
      return element && element.type === "frame" && !element.isDeleted;
    }));
    requestedIds = requestedIds.filter(function (id) {
      return originalFrames.some(function (frame) { return frame.id === id; });
    });
    deleteSet = {};
    requestedIds.forEach(function (id) { deleteSet[id] = true; });
    if (!requestedIds.length) return false;
    if (originalFrames.length - requestedIds.length < 1) {
      toast("至少保留一个幻灯片，请取消选择一页");
      return false;
    }

    setSlideBusy(true);
    var now = Date.now();
    var originalById = {};
    var originalIndexById = {};
    originalFrames.forEach(function (frame, index) {
      originalById[frame.id] = {
        id: frame.id,
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1600),
        height: Math.max(1, Number(frame.height) || 900),
      };
      originalIndexById[frame.id] = index;
    });

    var remainingFrames = originalFrames.filter(function (frame) {
      return !deleteSet[frame.id];
    });
    var frameElementById = {};
    elements.forEach(function (element) {
      if (!element || element.type !== "frame") return;
      frameElementById[element.id] = element;
      if (!deleteSet[element.id]) return;
      element.isDeleted = true;
      element.version = (Number(element.version) || 1) + 1;
      element.versionNonce = randomNonce();
      element.updated = now;
    });

    var moveById = {};
    var newPositionById = {};
    var cursorX = Number(originalFrames[0].x) || 0;
    var anchorY = Number(originalFrames[0].y) || 0;
    remainingFrames.forEach(function (frame, index) {
      var target = frameElementById[frame.id] || frame;
      var oldX = Number(target.x) || 0;
      var oldY = Number(target.y) || 0;
      var dx = cursorX - oldX;
      var dy = anchorY - oldY;
      moveById[frame.id] = { dx: dx, dy: dy };
      target.x = cursorX;
      target.y = anchorY;
      target.customData = Object.assign({}, target.customData || {}, {
        excalicordFrame: true,
        excalicordOrder: index,
      });
      target.version = (Number(target.version) || 1) + 1;
      target.versionNonce = randomNonce();
      target.updated = now;
      newPositionById[frame.id] = { x: target.x, y: target.y };
      cursorX += (Number(target.width) || 1600) + 240;
    });

    var ownerByDeletedId = {};
    requestedIds.forEach(function (id) {
      var originalIndex = originalIndexById[id] || 0;
      ownerByDeletedId[id] = remainingFrames[Math.min(originalIndex, remainingFrames.length - 1)];
    });

    function originalContainingFrame(element) {
      var x = Number(element.x) || 0;
      var y = Number(element.y) || 0;
      var width = Math.abs(Number(element.width) || 0);
      var height = Math.abs(Number(element.height) || 0);
      var centerX = x + width / 2;
      var centerY = y + height / 2;
      for (var i = 0; i < originalFrames.length; i++) {
        var bounds = originalById[originalFrames[i].id];
        if (
          centerX >= bounds.x && centerX <= bounds.x + bounds.width &&
          centerY >= bounds.y && centerY <= bounds.y + bounds.height
        ) return originalFrames[i].id;
      }
      return "";
    }

    elements.forEach(function (element) {
      if (!element || element.isDeleted || element.type === "frame") return;
      var sourceFrameId = element.frameId || originalContainingFrame(element);
      if (!sourceFrameId) return;
      if (deleteSet[sourceFrameId]) {
        var owner = ownerByDeletedId[sourceFrameId];
        var sourceBounds = originalById[sourceFrameId];
        var ownerPosition = owner && newPositionById[owner.id];
        if (!owner || !sourceBounds || !ownerPosition) return;
        element.x = ownerPosition.x + ((Number(element.x) || 0) - sourceBounds.x);
        element.y = ownerPosition.y + ((Number(element.y) || 0) - sourceBounds.y);
        element.frameId = owner.id;
      } else {
        var move = moveById[sourceFrameId];
        if (move && (move.dx || move.dy)) {
          element.x = (Number(element.x) || 0) + move.dx;
          element.y = (Number(element.y) || 0) + move.dy;
        }
      }
      element.version = (Number(element.version) || 1) + 1;
      element.versionNonce = randomNonce();
      element.updated = now;
    });

    standardizeFrameLayout(elements, remainingFrames.map(function (frame) {
      return frame.id;
    }));

    if (!writeElementsSafe(elements)) {
      setSlideBusy(false);
      return false;
    }
    persistSceneToServer(elements);
    try { if (api) api.updateScene({ elements: elements }); } catch (err) {}
    selectedFrameIds = {};
    renderFrameTabs();
    renderSlideOverview();
    var activeId = currentFrameId(remainingFrames);
    var activeFrame = remainingFrames.find(function (frame) { return frame.id === activeId; }) || remainingFrames[0];
    localStorage.setItem(ACTIVE_FRAME_KEY, activeFrame.id);
    toast("已删除 " + requestedIds.length + " 张幻灯片");
    navigateToFrame(activeFrame);
    return true;
  }

  function deleteFrame(frameId) {
    if (slideBusy) return;
    setSlideBusy(true);
    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    if (api) {
      try {
        elements = api.getSceneElementsIncludingDeleted();
      } catch (err) {}
    }
    elements = elements.map(function (el) {
      return el ? Object.assign({}, el) : el;
    });
    var frames = getFrames();
    if (frames.length <= 1) {
      toast("至少保留一个幻灯片");
      setSlideBusy(false);
      return;
    }
    var target = elements.find(function (el) {
      return el && el.id === frameId && el.type === "frame";
    });
    if (target) {
      target.isDeleted = true;
    }
    if (!target) {
      setSlideBusy(false);
      return;
    }
    var deletedX = Number(target.x) || 0;
    var deletedY = Number(target.y) || 0;
    var deletedW = Math.max(0, Number(target.width) || 0);
    /* 删除后把剩余 Frame 按顺序紧凑重排，避免白板留空位 */
    var remainingSorted = elements
      .filter(function (el) {
        return el && el.type === "frame" && !el.isDeleted && el.id !== frameId;
      })
      .sort(function (a, b) {
        var orderA = a.customData && Number(a.customData.excalicordOrder);
        var orderB = b.customData && Number(b.customData.excalicordOrder);
        var hasA = Number.isFinite(orderA);
        var hasB = Number.isFinite(orderB);
        if (hasA || hasB) {
          if (!hasA) orderA = Number.MAX_SAFE_INTEGER;
          if (!hasB) orderB = Number.MAX_SAFE_INTEGER;
          if (orderA !== orderB) return orderA - orderB;
        }
        if (Math.abs((a.y || 0) - (b.y || 0)) > 80) return (a.y || 0) - (b.y || 0);
        return (a.x || 0) - (b.x || 0);
      });
    var moveById = {};
    if (remainingSorted.length) {
      var cursorX = Number(remainingSorted[0].x) || 0;
      var anchorY = Number(remainingSorted[0].y) || 0;
      remainingSorted.forEach(function (frame, index) {
        var oldX = Number(frame.x) || 0;
        var oldY = Number(frame.y) || 0;
        var dx = index === 0 ? 0 : cursorX - oldX;
        var dy = index === 0 ? 0 : anchorY - oldY;
        moveById[frame.id] = { dx: dx, dy: dy };
        frame.customData = Object.assign({}, frame.customData || {}, {
          excalicordFrame: true,
          excalicordOrder: index,
        });
        frame.version = (Number(frame.version) || 1) + 1;
        frame.versionNonce = randomNonce();
        frame.updated = Date.now();
        cursorX = cursorX + (Number(frame.width) || 0) + 240;
      });
      /* 被删 Frame 的内容归属到重排后占据其位置的 Frame；若没有，则归属到剩余第一个 */
      var owner = null;
      for (var oi = 0; oi < remainingSorted.length; oi++) {
        var candidate = remainingSorted[oi];
        var candidateMove = moveById[candidate.id] || { dx: 0, dy: 0 };
        var candidateNewX = (Number(candidate.x) || 0) + candidateMove.dx;
        var candidateW = Math.max(0, Number(candidate.width) || 0);
        if (candidateNewX <= deletedX + deletedW && candidateNewX + candidateW >= deletedX) {
          owner = candidate;
          break;
        }
      }
      if (!owner) owner = remainingSorted[0];
      var ownerMove = moveById[owner.id] || { dx: 0, dy: 0 };
      var ownerNewX = (Number(owner.x) || 0) + ownerMove.dx;
      var ownerNewY = (Number(owner.y) || 0) + ownerMove.dy;
      elements.forEach(function (el) {
        if (!el || el.isDeleted) return;
        if (el.frameId === frameId && owner) {
          var relX = (Number(el.x) || 0) - deletedX;
          var relY = (Number(el.y) || 0) - deletedY;
          el.x = ownerNewX + relX;
          el.y = ownerNewY + relY;
          el.frameId = owner.id;
          el.version = (Number(el.version) || 1) + 1;
          el.versionNonce = randomNonce();
          el.updated = Date.now();
          return;
        }
        var move = moveById[el.id] || moveById[el.frameId];
        if (!move || (!move.dx && !move.dy)) return;
        el.x = (Number(el.x) || 0) + move.dx;
        el.y = (Number(el.y) || 0) + move.dy;
        el.version = (Number(el.version) || 1) + 1;
        el.versionNonce = randomNonce();
        el.updated = Date.now();
      });
    }
    standardizeFrameLayout(elements, remainingSorted.map(function (frame) {
      return frame.id;
    }));
    if (!writeElementsSafe(elements)) {
      setSlideBusy(false);
      return;
    }
    /* Persist to scene.excalidraw so auto-refresh won't undo the deletion */
    persistSceneToServer(elements);
    try {
      if (api) api.updateScene({ elements: elements });
    } catch (err) {}
    renderFrameTabs();
    renderSlideOverview();
    var remaining = getFrames();
    if (remaining.length) {
      var nextId = currentFrameId(remaining);
      if (nextId === frameId || !nextId) {
        localStorage.removeItem(ACTIVE_FRAME_KEY);
        navigateToFrame(remaining[0]);
        return;
      }
      navigateToFrame(
        remaining.find(function (f) { return f.id === nextId; }) || remaining[0]
      );
      return;
    }
    toast("幻灯片已删除");
    setSlideBusy(false);
  }

  function renameFrame(frameId, nextName) {
    var name = String(nextName || "").trim().slice(0, 80);
    if (!name) {
      toast("标题不能为空");
      return false;
    }
    var elements = readElementsSafe();
    var changed = false;
    elements.forEach(function (element) {
      if (element && element.id === frameId && element.type === "frame" && !element.isDeleted) {
        element.name = name;
        element.version = (Number(element.version) || 1) + 1;
        element.versionNonce = randomNonce();
        element.updated = Date.now();
        changed = true;
      }
    });
    if (!changed) {
      toast("未找到要重命名的幻灯片");
      return false;
    }
    if (!writeElementsSafe(elements)) return false;
    persistSceneToServer(elements);
    try {
      var api = getLiveExcalidrawAPI();
      if (api) api.updateScene({ elements: elements });
    } catch (err) {}
    renderFrameTabs();
    renderSlideOverview();
    toast("已重命名为「" + name + "」");
    return true;
  }

  function persistFrameOrder(orderedFrameIds) {
    var orderMap = {};
    orderedFrameIds.forEach(function (id, index) {
      orderMap[id] = index;
    });
    var api = getLiveExcalidrawAPI();
    var elements = readElementsSafe();
    if (api) {
      try {
        elements = api.getSceneElementsIncludingDeleted();
      } catch (err) {}
    }
    elements = elements.map(function (element) {
      return element ? Object.assign({}, element) : element;
    });
    var changed = false;
    var orderedFrameById = {};
    elements.forEach(function (element) {
      if (!element || element.type !== "frame" || element.isDeleted) return;
      if (!Object.prototype.hasOwnProperty.call(orderMap, element.id)) return;
      orderedFrameById[element.id] = element;
    });
    var visualSlots = Object.keys(orderedFrameById)
      .map(function (id) {
        return orderedFrameById[id];
      })
      .sort(function (a, b) {
        if (Math.abs((a.y || 0) - (b.y || 0)) > 80) return (a.y || 0) - (b.y || 0);
        return (a.x || 0) - (b.x || 0);
      })
      .map(function (frame) {
        return {
          id: frame.id,
          x: Number(frame.x) || 0,
          y: Number(frame.y) || 0,
        };
      });
    var frameMoveById = {};
    orderedFrameIds.forEach(function (id, index) {
      var frame = orderedFrameById[id];
      var slot = visualSlots[index];
      if (!frame || !slot) return;
      var fromX = Number(frame.x) || 0;
      var fromY = Number(frame.y) || 0;
      var dx = slot.x - fromX;
      var dy = slot.y - fromY;
      frameMoveById[id] = { dx: dx, dy: dy };
    });
    elements.forEach(function (element) {
      if (!element || element.type !== "frame" || element.isDeleted) return;
      if (!Object.prototype.hasOwnProperty.call(orderMap, element.id)) return;
      element.customData = Object.assign({}, element.customData || {}, {
        excalicordFrame: true,
        excalicordOrder: orderMap[element.id],
      });
      var move = frameMoveById[element.id];
      if (move && (move.dx || move.dy)) {
        element.x = (Number(element.x) || 0) + move.dx;
        element.y = (Number(element.y) || 0) + move.dy;
      }
      element.version = (Number(element.version) || 1) + 1;
      element.versionNonce = randomNonce();
      element.updated = Date.now();
      changed = true;
    });
    elements.forEach(function (element) {
      if (!element || element.isDeleted || !element.frameId) return;
      var move = frameMoveById[element.frameId];
      if (!move || (!move.dx && !move.dy)) return;
      element.x = (Number(element.x) || 0) + move.dx;
      element.y = (Number(element.y) || 0) + move.dy;
      element.version = (Number(element.version) || 1) + 1;
      element.versionNonce = randomNonce();
      element.updated = Date.now();
      changed = true;
    });
    if (standardizeFrameLayout(elements, orderedFrameIds)) changed = true;
    if (!changed) return false;
    var orderedFrames = orderedFrameIds
      .map(function (id) {
        return orderedFrameById[id];
      })
      .filter(Boolean);
    var frameCursor = 0;
    var reorderedElements = elements.map(function (element) {
      if (
        element &&
        element.type === "frame" &&
        !element.isDeleted &&
        Object.prototype.hasOwnProperty.call(orderMap, element.id)
      ) {
        return orderedFrames[frameCursor++] || element;
      }
      return element;
    });
    if (!writeElementsSafe(reorderedElements)) return false;
    persistSceneToServer(reorderedElements);
    try {
      if (api) api.updateScene({ elements: reorderedElements });
    } catch (err) {}
    renderFrameTabs();
    renderSlideOverview();
    return true;
  }

  function reorderFrame(dragFrameId, targetFrameId) {
    if (!dragFrameId || !targetFrameId || dragFrameId === targetFrameId || slideBusy) return false;
    var frames = getFrames();
    var ids = frames.map(function (frame) { return frame.id; });
    var from = ids.indexOf(dragFrameId);
    var to = ids.indexOf(targetFrameId);
    if (from < 0 || to < 0 || from === to) return false;
    var moved = ids.splice(from, 1)[0];
    ids.splice(to, 0, moved);
    if (!persistFrameOrder(ids)) return false;
    toast("已调整幻灯片顺序");
    return true;
  }

  function isSlideOverviewOpen() {
    return slideOverviewEl.classList.contains("ec-open");
  }

  function closeSlideOverview() {
    slideOverviewEl.classList.remove("ec-open");
    slideOverviewEl.setAttribute("aria-hidden", "true");
  }

  function openSlideOverview(focusSearch) {
    if (typeof setPanelOpen === "function") setPanelOpen(false);
    setViewToolsOpen(false);
    renderSlideOverview();
    slideOverviewEl.classList.add("ec-open");
    slideOverviewEl.setAttribute("aria-hidden", "false");
    if (focusSearch) {
      window.setTimeout(function () {
        slideSearchInput.focus({ preventScroll: true });
        slideSearchInput.select();
      }, 30);
    }
  }

  function toggleSlideOverview(focusSearch) {
    if (isSlideOverviewOpen()) closeSlideOverview();
    else openSlideOverview(focusSearch);
  }

  function clearSlideDragState() {
    slideGridEl.querySelectorAll(".ec-dragging,.ec-drop-target").forEach(function (element) {
      element.classList.remove("ec-dragging", "ec-drop-target");
    });
  }

  function createSlideAddOverviewCard(query) {
    var card = document.createElement("div");
    card.className = "ec-slide-card ec-slide-card-add";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ec-slide-card-add-main";
    button.innerHTML = '<span class="ec-slide-card-add-icon">＋</span><span><strong>新增幻灯片</strong><small>按每行 6 张的标准排版新增</small></span>';
    button.title = query ? "清空搜索并新增幻灯片" : "新增幻灯片";
    button.addEventListener("click", function () {
      if (query) slideSearchInput.value = "";
      closeSlideOverview();
      addFrame();
    });
    card.appendChild(button);
    return card;
  }

  function svgPreviewNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  function framePreviewElements(frame, elements) {
    var left = Number(frame.x) || 0;
    var top = Number(frame.y) || 0;
    var right = left + Math.max(1, Number(frame.width) || 1600);
    var bottom = top + Math.max(1, Number(frame.height) || 900);
    return (elements || []).filter(function (element) {
      if (!element || element.isDeleted || element.type === "frame") return false;
      if (element.frameId) return element.frameId === frame.id;
      var x = Number(element.x) || 0;
      var y = Number(element.y) || 0;
      var width = Math.abs(Number(element.width) || 0);
      var height = Math.abs(Number(element.height) || 0);
      var centerX = x + width / 2;
      var centerY = y + height / 2;
      return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    });
  }

  function createFramePreview(frame, elements, files, backgroundColor) {
    var frameX = Number(frame.x) || 0;
    var frameY = Number(frame.y) || 0;
    var frameW = Math.max(1, Number(frame.width) || 1600);
    var frameH = Math.max(1, Number(frame.height) || 900);
    var svg = svgPreviewNode("svg", {
      viewBox: [frameX, frameY, frameW, frameH].join(" "),
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": "真实幻灯片内容预览",
    });
    var backdrop = svgPreviewNode("rect", {
      x: frameX,
      y: frameY,
      width: frameW,
      height: frameH,
      fill: backgroundColor || "#ffffff",
    });
    svg.appendChild(backdrop);

    var contents = framePreviewElements(frame, elements);
    if (!contents.length) {
      var emptyText = svgPreviewNode("text", {
        x: frameX + frameW / 2,
        y: frameY + frameH / 2,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        fill: "#94a3b8",
        "font-size": Math.max(34, frameW / 24),
        "font-family": "system-ui, sans-serif",
      });
      emptyText.textContent = "空白幻灯片";
      svg.appendChild(emptyText);
      return svg;
    }

    contents.slice(0, 800).forEach(function (element) {
      var x = Number(element.x) || 0;
      var y = Number(element.y) || 0;
      var width = Math.max(1, Math.abs(Number(element.width) || 0));
      var height = Math.max(1, Math.abs(Number(element.height) || 0));
      var stroke = element.strokeColor || "#1b1b1f";
      var fill = element.backgroundColor && element.backgroundColor !== "transparent"
        ? element.backgroundColor
        : "none";
      var opacity = Math.max(0, Math.min(1, (Number(element.opacity) || 100) / 100));
      var group = svgPreviewNode("g", { opacity: opacity });
      var angle = Number(element.angle) || 0;
      if (angle) {
        group.setAttribute(
          "transform",
          "rotate(" + (angle * 180 / Math.PI) + " " + (x + width / 2) + " " + (y + height / 2) + ")",
        );
      }
      var shape = null;
      if (element.type === "rectangle") {
        shape = svgPreviewNode("rect", {
          x: x,
          y: y,
          width: width,
          height: height,
          rx: element.roundness ? Math.min(width, height) * 0.05 : 0,
          fill: fill,
        });
      } else if (element.type === "diamond") {
        shape = svgPreviewNode("polygon", {
          points: [
            [x + width / 2, y],
            [x + width, y + height / 2],
            [x + width / 2, y + height],
            [x, y + height / 2],
          ].map(function (point) { return point.join(","); }).join(" "),
          fill: fill,
        });
      } else if (element.type === "ellipse") {
        shape = svgPreviewNode("ellipse", {
          cx: x + width / 2,
          cy: y + height / 2,
          rx: width / 2,
          ry: height / 2,
          fill: fill,
        });
      } else if (element.type === "line" || element.type === "arrow" || element.type === "freedraw") {
        var points = Array.isArray(element.points) ? element.points : [];
        if (points.length) {
          var absolutePoints = points.map(function (point) {
            return [x + (Number(point[0]) || 0), y + (Number(point[1]) || 0)];
          });
          shape = svgPreviewNode(element.type === "freedraw" ? "polyline" : "polyline", {
            points: absolutePoints.map(function (point) { return point.join(","); }).join(" "),
            fill: "none",
          });
          if (element.type === "arrow" && absolutePoints.length > 1) {
            var end = absolutePoints[absolutePoints.length - 1];
            var previous = absolutePoints[absolutePoints.length - 2];
            var direction = Math.atan2(end[1] - previous[1], end[0] - previous[0]);
            var arrowSize = Math.max(24, frameW / 55);
            var arrowHead = svgPreviewNode("polygon", {
              points: [
                end,
                [end[0] - arrowSize * Math.cos(direction - 0.48), end[1] - arrowSize * Math.sin(direction - 0.48)],
                [end[0] - arrowSize * Math.cos(direction + 0.48), end[1] - arrowSize * Math.sin(direction + 0.48)],
              ].map(function (point) { return point.join(","); }).join(" "),
              fill: stroke,
              stroke: "none",
            });
            group.appendChild(arrowHead);
          }
        }
      } else if (element.type === "text") {
        var text = svgPreviewNode("text", {
          x: x,
          y: y + (Number(element.fontSize) || 20),
          fill: stroke,
          "font-size": Number(element.fontSize) || 20,
          "font-family": "system-ui, sans-serif",
          "font-weight": element.fontFamily === 1 ? 600 : 400,
        });
        String(element.text || element.originalText || "").split("\n").forEach(function (line, lineIndex) {
          var tspan = svgPreviewNode("tspan", {
            x: x,
            dy: lineIndex ? (Number(element.fontSize) || 20) * 1.25 : 0,
          });
          tspan.textContent = line;
          text.appendChild(tspan);
        });
        group.appendChild(text);
      } else if (element.type === "image") {
        var file = files && element.fileId ? files[element.fileId] : null;
        if (file && file.dataURL) {
          shape = svgPreviewNode("image", {
            x: x,
            y: y,
            width: width,
            height: height,
            href: file.dataURL,
            preserveAspectRatio: "xMidYMid meet",
          });
        }
      }
      if (!shape && element.type !== "text") {
        shape = svgPreviewNode("rect", {
          x: x,
          y: y,
          width: width,
          height: height,
          rx: Math.min(width, height) * 0.03,
          fill: fill === "none" ? "rgba(148,163,184,0.08)" : fill,
        });
      }
      if (shape) {
        if (element.type !== "image") {
          shape.setAttribute("stroke", stroke);
          shape.setAttribute("stroke-width", String(Math.max(1, Number(element.strokeWidth) || 1)));
          shape.setAttribute("vector-effect", "non-scaling-stroke");
          shape.setAttribute("stroke-linecap", "round");
          shape.setAttribute("stroke-linejoin", "round");
          if (element.strokeStyle === "dashed") shape.setAttribute("stroke-dasharray", "10 7");
          if (element.strokeStyle === "dotted") shape.setAttribute("stroke-dasharray", "2 7");
        }
        group.insertBefore(shape, group.firstChild);
      }
      svg.appendChild(group);
    });
    return svg;
  }

  function scheduleFramePreview(host, frame, elements, files, backgroundColor) {
    host.classList.add("ec-loading");
    var render = function () {
      if (!host.isConnected || host.dataset.previewReady === "1") return;
      host.dataset.previewReady = "1";
      host.classList.remove("ec-loading");
      host.appendChild(createFramePreview(frame, elements, files, backgroundColor));
    };
    if (!("IntersectionObserver" in window)) {
      render();
      return;
    }
    if (!slidePreviewObserver) {
      slidePreviewObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var target = entry.target;
          var previewRender = target.__excalicordPreviewRender;
          slidePreviewObserver.unobserve(target);
          delete target.__excalicordPreviewRender;
          if (previewRender) previewRender();
        });
      }, { root: slideGridEl, rootMargin: "220px 0px" });
    }
    host.__excalicordPreviewRender = render;
    slidePreviewObserver.observe(host);
  }

  function syncSlideSelectionUi(frames) {
    var liveIds = {};
    (frames || []).forEach(function (frame) { liveIds[frame.id] = true; });
    Object.keys(selectedFrameIds).forEach(function (id) {
      if (!liveIds[id]) delete selectedFrameIds[id];
    });
    var selectedIds = Object.keys(selectedFrameIds);
    slideGridEl.querySelectorAll(".ec-slide-card[data-frame-id]").forEach(function (card) {
      var selected = Boolean(selectedFrameIds[card.dataset.frameId]);
      card.classList.toggle("ec-selected", selected);
      var checkbox = card.querySelector(".ec-slide-select-checkbox");
      if (checkbox) checkbox.checked = selected;
    });
    slideSelectedCount.textContent = "已选 " + selectedIds.length + " 页";
    slideBulkDeleteBtn.textContent = "删除 " + selectedIds.length + " 页";
    slideBulkbar.classList.toggle("ec-open", selectedIds.length > 0);
    slideBulkbar.setAttribute("aria-hidden", selectedIds.length > 0 ? "false" : "true");
  }

  function renderSlideOverview() {
    var frames = getFrames();
    var previewElements = readElementsSafe();
    var previewFiles = {};
    var previewBackground = "#ffffff";
    var previewApi = getLiveExcalidrawAPI();
    if (previewApi) {
      try { previewElements = previewApi.getSceneElementsIncludingDeleted(); } catch (err) {}
      try { previewFiles = previewApi.getFiles() || {}; } catch (err) {}
      try { previewBackground = previewApi.getAppState().viewBackgroundColor || previewBackground; } catch (err) {}
    }
    var activeId = currentFrameId(frames);
    var query = (slideSearchInput.value || "").trim().toLowerCase();
    var matches = frames
      .map(function (frame, index) { return { frame: frame, index: index }; })
      .filter(function (item) {
        return !query || frameSearchText(item.frame, item.index).indexOf(query) >= 0;
      });
    currentOverviewMatchIds = matches.map(function (item) { return item.frame.id; });
    slideOverviewMeta.textContent = query
      ? matches.length + " / " + frames.length + " 张幻灯片 · 清空搜索后可拖动排序"
      : frames.length + " 张幻灯片 · 拖动卡片可排序";
    if (slidePreviewObserver) {
      slidePreviewObserver.disconnect();
      slidePreviewObserver = null;
    }
    slideGridEl.innerHTML = "";
    if (!matches.length) {
      var empty = document.createElement("div");
      empty.className = "ec-slide-grid-empty";
      empty.textContent = "没有匹配的幻灯片；可清空搜索或直接新增一页。";
      slideGridEl.appendChild(empty);
      slideGridEl.appendChild(createSlideAddOverviewCard(query));
      syncSlideSelectionUi(frames);
      return;
    }
    matches.forEach(function (item) {
      var frame = item.frame;
      var index = item.index;
      var card = document.createElement("div");
      card.className = "ec-slide-card" +
        (frame.id === activeId ? " ec-active" : "") +
        (selectedFrameIds[frame.id] ? " ec-selected" : "");
      card.dataset.frameId = frame.id;
      if (query) {
        card.classList.add("ec-drag-disabled");
      } else {
        card.draggable = true;
        card.addEventListener("dragstart", function (ev) {
          draggingFrameId = frame.id;
          card.classList.add("ec-dragging");
          try {
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", frame.id);
          } catch (err) {}
        });
        card.addEventListener("dragover", function (ev) {
          if (!draggingFrameId || draggingFrameId === frame.id) return;
          ev.preventDefault();
          card.classList.add("ec-drop-target");
          try { ev.dataTransfer.dropEffect = "move"; } catch (err) {}
        });
        card.addEventListener("dragleave", function () {
          card.classList.remove("ec-drop-target");
        });
        card.addEventListener("drop", function (ev) {
          ev.preventDefault();
          var dragId = draggingFrameId;
          draggingFrameId = "";
          clearSlideDragState();
          reorderFrame(dragId, frame.id);
        });
        card.addEventListener("dragend", function () {
          draggingFrameId = "";
          clearSlideDragState();
        });
      }

      var handle = document.createElement("span");
      handle.className = "ec-slide-drag-handle";
      handle.textContent = "⋮⋮";
      handle.title = query ? "清空搜索后可拖动排序" : "拖动调整幻灯片顺序";
      handle.setAttribute("aria-hidden", "true");

      var selectLabel = document.createElement("label");
      selectLabel.className = "ec-slide-select";
      selectLabel.title = "选择「" + frameTitle(frame, index) + "」";
      var selectCheckbox = document.createElement("input");
      selectCheckbox.type = "checkbox";
      selectCheckbox.className = "ec-slide-select-checkbox";
      selectCheckbox.checked = Boolean(selectedFrameIds[frame.id]);
      selectCheckbox.setAttribute("aria-label", "选择幻灯片 " + String(index + 1));
      selectCheckbox.addEventListener("click", function (ev) { ev.stopPropagation(); });
      selectCheckbox.addEventListener("change", function () {
        if (selectCheckbox.checked) selectedFrameIds[frame.id] = true;
        else delete selectedFrameIds[frame.id];
        syncSlideSelectionUi(frames);
      });
      selectLabel.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      selectLabel.appendChild(selectCheckbox);
      selectLabel.appendChild(document.createElement("span"));

      var badge = document.createElement("span");
      badge.className = "ec-slide-card-no";
      badge.textContent = String(index + 1);

      var jump = document.createElement("button");
      jump.className = "ec-slide-card-main";
      jump.type = "button";
      jump.title = "跳转到「" + frameTitle(frame, index) + "」";
      jump.innerHTML = '<span class="ec-slide-card-preview"></span><span class="ec-slide-card-title"></span><span class="ec-slide-card-sub">点击预览跳转 · 拖动排序</span>';
      scheduleFramePreview(
        jump.querySelector(".ec-slide-card-preview"),
        frame,
        previewElements,
        previewFiles,
        previewBackground,
      );
      jump.querySelector(".ec-slide-card-title").textContent = frameTitle(frame, index);
      jump.addEventListener("click", function () {
        closeSlideOverview();
        switchFrame(frame.id);
      });

      var actions = document.createElement("div");
      actions.className = "ec-slide-card-actions";
      var rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "重命名";
      rename.title = "给此幻灯片设置标题，便于搜索";
      rename.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var nextName = window.prompt("给这页起个标题", frameTitle(frame, index));
        if (nextName === null) return;
        renameFrame(frame.id, nextName);
      });
      var del = document.createElement("button");
      del.type = "button";
      del.className = "ec-slide-card-delete";
      del.textContent = "删除";
      del.title = "删除此幻灯片";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (frames.length <= 1) {
          toast("至少保留一个幻灯片");
          return;
        }
        if (!window.confirm("删除「" + frameTitle(frame, index) + "」？此操作不可撤销。")) return;
        closeSlideOverview();
        deleteFrame(frame.id);
      });
      actions.appendChild(rename);
      actions.appendChild(del);
      card.appendChild(selectLabel);
      card.appendChild(handle);
      card.appendChild(badge);
      card.appendChild(jump);
      card.appendChild(actions);
      slideGridEl.appendChild(card);
    });
    slideGridEl.appendChild(createSlideAddOverviewCard(query));
    syncSlideSelectionUi(frames);
  }

  function addFrame() {
    if (slideBusy) return;
    setSlideBusy(true);
    toast("正在新增幻灯片…");
    window.setTimeout(function () {
      var elements = readElementsSafe();
      var frames = getFrames();
      var maxRight = 0;
      var minY = frames.length ? Number(frames[0].y) || 0 : 0;
      if (elements.length) {
        maxRight = elements.reduce(function (max, element) {
          return Math.max(max, elementRight(element));
        }, -Infinity);
        if (!isFinite(maxRight)) maxRight = 0;
      }
      if (!frames.length && elements.length) {
        minY = elements.reduce(function (min, element) {
          return Math.min(min, Number(element.y) || 0);
        }, Infinity);
        if (!isFinite(minY)) minY = 0;
      }
      var x = frames.length || elements.length ? maxRight + 240 : 0;
      var next = createFrameElement(frames.length + 1, x, minY);
      elements.push(next);
      standardizeFrameLayout(
        elements,
        frames.map(function (frame) { return frame.id; }).concat(next.id),
      );
      if (!writeElementsSafe(elements)) {
        setSlideBusy(false);
        return;
      }
      var overviewAfterAdd = localStorage.getItem(SLIDE_ADD_OVERVIEW_KEY) !== "0";
      if (overviewAfterAdd) sessionStorage.setItem(PENDING_OVERVIEW_KEY, "1");
      else sessionStorage.removeItem(PENDING_OVERVIEW_KEY);
      persistSceneToServer(elements);
      try {
        var liveApi = getLiveExcalidrawAPI();
        if (liveApi) liveApi.updateScene({ elements: elements });
      } catch (err) {}
      /* 新增后立即把新 Frame 设为当前页。鸟瞰只改变视口，不应继续把幻灯片 1
         标记为当前页，也避免后续 Frame 录制仍指向旧页。 */
      localStorage.setItem(ACTIVE_FRAME_KEY, next.id);
      renderFrameTabs();
      renderSlideOverview();
      if (overviewAfterAdd) {
        /* updateScene(elements) 在真实 Excalidraw 中异步提交，不能马上从 API
           回读，否则仍只读到新增前的 Frame（通常是幻灯片 1）。直接用本次
           写入的权威 elements 计算全局范围，并在提交后再校准一次视口。 */
        showWhiteboardOverview(elements);
        /* showWhiteboardOverview() 会清除旧 ?frame=；随后重新确认新增页，
           避免首次 renderFrameTabs() 被旧 URL 参数覆盖。 */
        localStorage.setItem(ACTIVE_FRAME_KEY, next.id);
        renderFrameTabs();
        window.setTimeout(function () {
          showWhiteboardOverview(elements);
        }, 120);
        toast("已新增幻灯片，当前展示整块白板布局");
      } else {
        focusFrameAfterSceneCommit(next, 0);
      }
      window.setTimeout(function () {
        setSlideBusy(false);
      }, 400);
    }, 160);
  }

  /* 场景完全为空（如刚重置画板）时，自动提供一个默认 16:9 幻灯片作为画布边界，
     避免用户在无边界画布上绘制导致尺寸失控。已有任何内容时不做干预。 */
  function ensureDefaultFrameIfEmpty() {
    var api = getLiveExcalidrawAPI();
    if (!api || slideBusy) return;
    if (localStorage.getItem(AUTO_DEFAULT_SLIDE_KEY) === "0") return;
    var elements;
    try {
      elements = api.getSceneElementsIncludingDeleted();
    } catch (err) {
      elements = readElementsSafe();
    }
    var alive = (elements || []).filter(function (el) {
      return el && !el.isDeleted;
    });
    if (alive.length) return;
    setSlideBusy(true);
    var next = createFrameElement(1, 0, 0);
    var nextElements = (elements || []).concat([next]);
    if (!writeElementsSafe(nextElements)) {
      setSlideBusy(false);
      return;
    }
    persistSceneToServer(nextElements);
    try {
      api.updateScene({ elements: nextElements });
    } catch (err) {}
    renderFrameTabs();
    renderSlideOverview();
    if (localStorage.getItem(SLIDE_ADD_OVERVIEW_KEY) !== "0") {
      showWhiteboardOverview();
    } else {
      navigateToFrame(next);
    }
    toast("已创建默认幻灯片（16:9），可直接开始绘制");
    window.setTimeout(function () {
      setSlideBusy(false);
    }, 400);
  }

  var slideContextMenu = null;

  function hideSlideContextMenu() {
    if (slideContextMenu) {
      slideContextMenu.remove();
      slideContextMenu = null;
    }
  }

  function openSlideSettings() {
    hideSlideContextMenu();
    setViewToolsOpen(true, "settings");
  }

  function closeSlideSettings() {
    if (viewToolsEl.classList.contains("ec-open")) setViewToolsOpen(false);
  }

  function showSlideSettingsMenu(ev) {
    hideSlideContextMenu();
    var menu = document.createElement("div");
    menu.className = "ec-slide-menu ec-slide-settings-menu";
    menu.innerHTML =
      '<button class="ec-slide-menu-btn ec-slide-settings-open" type="button">⚙ 设置</button>';
    menu.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });
    menu.querySelector(".ec-slide-settings-open").addEventListener("click", function () {
      hideSlideContextMenu();
      openSlideSettings();
    });
    document.body.appendChild(menu);
    slideContextMenu = menu;
    menu.style.position = "fixed";
    menu.style.zIndex = "2147483647";
    var menuW = menu.offsetWidth || 120;
    var menuH = menu.offsetHeight || 40;
    var left = Math.max(8, Math.min(ev.clientX, window.innerWidth - menuW - 8));
    var top = Math.max(8, Math.min(ev.clientY, window.innerHeight - menuH - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    setTimeout(function () {
      document.addEventListener("pointerdown", hideSlideContextMenu, { once: true });
    }, 50);
  }

  function showSlideContextMenu(ev, frame, index) {
    hideSlideContextMenu();
    var menu = document.createElement("div");
    menu.className = "ec-slide-menu";
    menu.innerHTML = [
      '<span class="ec-slide-menu-title">删除「' + (frame.name || "幻灯片 " + (index + 1)) + '」？</span>',
      '<span class="ec-slide-menu-hint">此操作不可撤销</span>',
      '<div class="ec-slide-menu-actions">',
      '<button class="ec-slide-menu-btn ec-slide-menu-del">删除</button>',
      '<button class="ec-slide-menu-btn ec-slide-menu-cancel">取消</button>',
      '</div>',
    ].join("");
    menu.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });
    menu.querySelector(".ec-slide-menu-del").addEventListener("click", function () {
      hideSlideContextMenu();
      deleteFrame(frame.id);
    });
    menu.querySelector(".ec-slide-menu-cancel").addEventListener("click", hideSlideContextMenu);
    document.body.appendChild(menu);
    slideContextMenu = menu;
    // Position near the slide rail
    var rail = slideTabsEl.parentElement;
    var railRect = rail.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.zIndex = "2147483647";
    var menuW = menu.offsetWidth || 156;
    var menuH = menu.offsetHeight || 96;
    var menuLeft = ev.clientX - menuW / 2;
    var menuTop = ev.clientY - 10;
    var dockPosition = effectiveDockPosition();
    if (dockPosition === "right") {
      menuLeft = railRect.left - menuW - 8;
    } else if (dockPosition === "left") {
      menuLeft = railRect.right + 8;
    } else if (dockPosition === "top") {
      menuTop = railRect.bottom + 8;
    } else if (dockPosition === "bottom") {
      menuTop = railRect.top - menuH - 8;
    }
    menu.style.left = Math.max(8, Math.min(menuLeft, window.innerWidth - menuW - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(menuTop, window.innerHeight - menuH - 8)) + "px";
    // Close on outside click
    setTimeout(function () {
      document.addEventListener("pointerdown", hideSlideContextMenu, { once: true });
    }, 50);
  }

  function renderFrameTabs() {
    ensureDefaultFrameIfEmpty();
    var frames = getFrames();
    var activeId = currentFrameId(frames);
    var activeIndex = Math.max(0, frames.findIndex(function (frame) { return frame.id === activeId; }));
    slideTabsEl.innerHTML = "";
    compactFrameItems(frames, activeIndex).forEach(function (item) {
      if (item.type === "ellipsis") {
        var ellipsis = document.createElement("button");
        ellipsis.className = "ec-slide-tab ec-slide-ellipsis";
        ellipsis.type = "button";
        ellipsis.textContent = "…";
        ellipsis.title = "更多幻灯片";
        ellipsis.setAttribute("aria-label", "更多幻灯片");
        ellipsis.addEventListener("click", function () {
          openSlideOverview(true);
        });
        slideTabsEl.appendChild(ellipsis);
        return;
      }
      var index = item.index;
      var frame = frames[index];
      var button = document.createElement("button");
      button.className = "ec-slide-tab" + (frame.id === activeId ? " ec-active" : "");
      button.type = "button";
      button.textContent = String(index + 1);
      button.title = frameTitle(frame, index);
      button.setAttribute("aria-label", "第 " + (index + 1) + " 张幻灯片");
      button.addEventListener("click", function () {
        switchFrame(frame.id);
      });
      button.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (frames.length <= 1) {
          toast("至少保留一个幻灯片");
          return;
        }
        showSlideContextMenu(ev, frame, index);
      });
      slideTabsEl.appendChild(button);
    });
    if (isSlideOverviewOpen()) renderSlideOverview();
    slideAddBtn.disabled = slideBusy;
  }

  function migrateLegacySlidesIfNeeded() {
    if (sessionStorage.getItem("excalicord-frame-migration-done") === "1") return false;
    var hasLegacySlideUrl = new URLSearchParams(location.search).has("slide");
    var raw = localStorage.getItem(LEGACY_SLIDE_STORE_KEY);
    if (!raw) return false;
    var store = null;
    try {
      store = JSON.parse(raw);
    } catch (err) {
      return false;
    }
    if (!store || !Array.isArray(store.slides) || !store.slides.length) return false;
    var candidates = store.slides
      .map(function (slide) {
        var count = 0;
        try {
          var parsed = JSON.parse(slide.elements || "[]");
          count = Array.isArray(parsed) ? parsed.filter(function (el) { return el && !el.isDeleted; }).length : 0;
        } catch (err) {
          count = 0;
        }
        return { slide: slide, count: count };
      })
      .sort(function (a, b) {
        return b.count - a.count;
      });
    var best = candidates[0];
    var currentCount = readElementsSafe().filter(function (el) { return el && !el.isDeleted; }).length;
    if (!hasLegacySlideUrl && currentCount >= best.count) return false;
    try {
      localStorage.setItem(ELEMENTS_KEY, best.slide.elements || "[]");
      localStorage.setItem(APP_STATE_KEY, best.slide.appState || "{}");
      localStorage.setItem(
        LEGACY_MIGRATION_KEY,
        JSON.stringify({ at: Date.now(), restoredSlide: best.slide.id, elements: best.count }),
      );
      sessionStorage.setItem("excalicord-frame-migration-done", "1");
      toast("已从旧版独立幻灯片恢复为同一画布幻灯片模式…");
      window.setTimeout(function () {
        location.replace(location.pathname + "?frames=1&t=" + Date.now());
      }, 120);
      return true;
    } catch (err) {
      return false;
    }
  }

  function initFrames() {
    applyDockPosition(localStorage.getItem(DOCK_POSITION_KEY) || "right", false);
    applyGridSettings(false);
    ensureStandardFrameLayoutOnce();
    renderFrameTabs();
    restorePendingOverview(0);
    slideAddBtn.disabled = false;
    slideAutosaveTimer = window.setInterval(renderFrameTabs, 2000);
  }

  if (!migrateLegacySlidesIfNeeded()) {
    slideAddBtn.addEventListener("click", addFrame);
    slideOverviewToggle.addEventListener("click", function () {
      toggleSlideOverview(true);
    });
    slideOverviewClose.addEventListener("click", closeSlideOverview);
    slideSelectAllBtn.addEventListener("click", function () {
      currentOverviewMatchIds.forEach(function (id) { selectedFrameIds[id] = true; });
      syncSlideSelectionUi(getFrames());
    });
    slideClearSelectionBtn.addEventListener("click", function () {
      selectedFrameIds = {};
      syncSlideSelectionUi(getFrames());
    });
    slideBulkDeleteBtn.addEventListener("click", function () {
      var ids = Object.keys(selectedFrameIds);
      var frames = getFrames();
      if (!ids.length) return;
      if (frames.length - ids.length < 1) {
        toast("至少保留一个幻灯片，请取消选择一页");
        return;
      }
      if (!window.confirm("删除选中的 " + ids.length + " 张幻灯片？删除后内容将跟随重排后的幻灯片，此操作不可撤销。")) return;
      closeSlideOverview();
      deleteFrames(ids);
    });
    slideSearchInput.addEventListener("input", renderSlideOverview);
    slideSearchInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeSlideOverview();
      }
    });
    slideOverviewEl.addEventListener("pointerdown", function (ev) {
      ev.stopPropagation();
    });
    slideOverviewEl.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      showSlideSettingsMenu(ev);
    });
    slideSettingsBtn.addEventListener("click", openSlideSettings);
    slideOverviewToggle.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      showSlideSettingsMenu(ev);
    });
    viewToolsToggle.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (viewToolsEl.classList.contains("ec-open")) setViewToolsOpen(false);
      else setViewToolsOpen(true, "view");
    });
    viewToolsEl.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
    viewToolsClose.addEventListener("click", function () { setViewToolsOpen(false); });
    controlTabView.addEventListener("click", function () { setControlTab("view"); });
    controlTabSettings.addEventListener("click", function () { setControlTab("settings"); });
    viewOverviewBtn.addEventListener("click", function () {
      showWhiteboardOverview();
      setViewToolsOpen(false);
      toast("已展示白板总览");
    });
    viewCurrentBtn.addEventListener("click", function () {
      var frames = getFrames();
      var frame = frames.find(function (candidate) { return candidate.id === viewFrameSelect.value; }) || frames[0];
      if (frame) navigateToFrame(frame);
      setViewToolsOpen(false);
    });
    viewZoomOutBtn.addEventListener("click", function () { zoomWhiteboardView("out"); });
    viewZoomInBtn.addEventListener("click", function () { zoomWhiteboardView("in"); });
    viewZoomResetBtn.addEventListener("click", function () { zoomWhiteboardView("reset"); });
    viewUndoBtn.addEventListener("click", function () { runWhiteboardHistoryCommand("undo"); });
    viewRedoBtn.addEventListener("click", function () { runWhiteboardHistoryCommand("redo"); });
    viewPresentBtn.addEventListener("click", startPresentation);
    dockChoiceButtons.forEach(function (button) {
      button.addEventListener("click", function (ev) {
        ev.stopPropagation();
        applyDockPosition(button.getAttribute("data-dock"), true);
      });
    });
    presenterPrev.addEventListener("click", function (ev) {
      ev.stopPropagation();
      stepPresentation(-1);
    });
    presenterNext.addEventListener("click", function (ev) {
      ev.stopPropagation();
      stepPresentation(1);
    });
    presenterPrevSmall.addEventListener("click", function (ev) {
      ev.stopPropagation();
      stepPresentation(-1);
    });
    presenterNextSmall.addEventListener("click", function (ev) {
      ev.stopPropagation();
      stepPresentation(1);
    });
    presenterExit.addEventListener("click", function (ev) {
      ev.stopPropagation();
      exitPresentation(false);
    });
    presenterEl.addEventListener("click", function (ev) {
      if (ev.target === presenterEl) stepPresentation(1);
    });
    document.addEventListener("fullscreenchange", function () {
      if (presentationState.active && !document.fullscreenElement) {
        exitPresentation(true);
      }
    });
    document.addEventListener("pointerdown", function () { setViewToolsOpen(false); });
    slideGridSnap.addEventListener("change", function () {
      applyGridSettings(true, "snap");
      if (!slideGridSnap.checked) {
        frameGuideState.active = false;
        frameGuideState.frameId = "";
        hideFrameSmartGuides();
      }
    });
    slideGridVisible.addEventListener("change", function () {
      applyGridSettings(true, "visible");
    });
    document.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || presentationState.active) return;
      var path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
      if (path.indexOf(host) >= 0) return;
      frameGuideState.pointerDown = true;
      window.setTimeout(beginFrameSmartGuides, 0);
    }, true);
    document.addEventListener("pointermove", function () {
      if (!frameGuideState.active || frameGuideState.raf) return;
      frameGuideState.raf = window.requestAnimationFrame(updateFrameSmartGuides);
    }, true);
    document.addEventListener("pointerup", function () {
      frameGuideState.pointerDown = false;
      commitFrameSmartGuideSnap();
    }, true);
    document.addEventListener("pointercancel", function () {
      frameGuideState.pointerDown = false;
      frameGuideState.active = false;
      frameGuideState.frameId = "";
      hideFrameSmartGuides();
    }, true);
    window.setTimeout(initFrames, 900);
  }

  /* Legacy helper kept as a no-op so the shared unload path remains simple. */
  function snapshotActiveSlide() {
    renderFrameTabs();
  }

  function getFrameDebugState() {
    var elements = readElementsSafe();
    var frames = getFrames();
    return {
      frames: frames,
      activeId: currentFrameId(frames),
      elementCount: elements.length,
      legacyStorePresent: Boolean(localStorage.getItem(LEGACY_SLIDE_STORE_KEY)),
      migrated: localStorage.getItem(LEGACY_MIGRATION_KEY) || "",
    };
  }
 window.addEventListener("beforeunload", snapshotActiveSlide);

  /* ============ Auto-hide Excalidraw properties panel on frame navigation ============ */
  /* When navigating to a frame, Excalidraw may auto-show the element properties panel
     (opacity, layer order, etc.) in the top-left area. This MutationObserver detects
     that panel appearing and hides it, so it doesn't pop up on every frame switch. */
  (function setupPropertiesPanelAutoHide() {
    function hidePropertiesPanel() {
      var panel = document.querySelector(".selected-shape-actions-container");
      if (panel) {
        panel.style.display = "none";
      }
      var island = document.querySelector(".Island.App-menu__left");
      if (island && island.querySelector(".selected-shape-actions")) {
        island.style.display = "none";
      }
    }
    function showPropertiesPanel() {
      var panel = document.querySelector(".selected-shape-actions-container");
      if (panel) panel.style.display = "";
      var island = document.querySelector(".Island.App-menu__left");
      if (island && island.querySelector(".selected-shape-actions")) {
        island.style.display = "";
      }
    }
    /* When user manually selects a non-frame element, we should allow the panel to show.
       But on frame auto-navigation, we suppress it. */
    var _frameNavSuppressing = false;
    var _suppressTimer = null;
    window.__excalicordSuppressProps = function () {
      _frameNavSuppressing = true;
      hidePropertiesPanel();
      clearTimeout(_suppressTimer);
      _suppressTimer = setTimeout(function () {
        _frameNavSuppressing = false;
      }, 2000);
    };

    /* Observe DOM changes to catch the panel appearing after frame navigation */
    var excalidrawEl = document.querySelector(".excalidraw");
    if (excalidrawEl) {
      var observer = new MutationObserver(function () {
        if (_frameNavSuppressing) {
          hidePropertiesPanel();
        }
      });
      observer.observe(excalidrawEl, { childList: true, subtree: true, attributes: true });
    }
    /* Also hide on initial page load if we have a frame URL param */
    if (new URLSearchParams(location.search).get("frame")) {
      window.__excalicordSuppressProps();
      /* Re-check periodically during Excalidraw initialization */
      var initChecks = 0;
      var initInterval = setInterval(function () {
        hidePropertiesPanel();
        initChecks++;
        if (initChecks >= 20) clearInterval(initInterval);
      }, 200);
    }
  })();

 /* ============ Body-level overlays (recorded into the screen) ============ */
  var countdownEl = document.createElement("div");
  countdownEl.className = "ec-countdown";
  countdownEl.id = "excalicord-countdown";
  countdownEl.style.display = "none";
  document.body.appendChild(countdownEl);

  var cursorHighlight = document.createElement("div");
  cursorHighlight.className = "ec-cursor-highlight";
  cursorHighlight.id = "excalicord-cursor-highlight";
  cursorHighlight.style.display = "none";
  document.body.appendChild(cursorHighlight);

  var micIndicator = document.createElement("div");
  micIndicator.className = "ec-mic-indicator";
  micIndicator.id = "excalicord-mic-indicator";
  micIndicator.style.display = "none";
  document.body.appendChild(micIndicator);

  var bubble = document.createElement("div");
  bubble.className = "ec-bubble";
  bubble.id = "excalicord-camera-bubble";
  bubble.style.left = "60px";
  bubble.style.top = "60px";
  bubble.style.width = "200px";
  bubble.style.height = "200px";
  bubble.style.display = "none";
  bubble.style.borderRadius = "50%";
  bubble.innerHTML =
    '<div class="ec-bubble-empty">摄像头未开启</div>' +
    '<div class="ec-bubble-resize" title="拖动右下角调整大小"></div>';
  document.body.appendChild(bubble);

  var screenLight = document.createElement("div");
  screenLight.className = "ec-screen-light";
  screenLight.id = "excalicord-screen-light";
  screenLight.style.display = "none";
  screenLight.setAttribute("aria-hidden", "true");
  document.body.appendChild(screenLight);

  var beautyCanvas = document.createElement("canvas");
  beautyCanvas.style.display = "none";
  beautyCanvas.style.width = "0";
  beautyCanvas.style.height = "0";
  document.body.appendChild(beautyCanvas);

  var tele = document.createElement("div");
  tele.className = "ec-tele";
  tele.id = "excalicord-teleprompter";
  tele.style.width = state.tele.width + "px";
  tele.style.height = state.tele.height + "px";
  tele.style.left =
    Math.max(8, Math.round((window.innerWidth - state.tele.width) / 2)) + "px";
  tele.style.top = "96px";
  tele.style.opacity = state.tele.opacity;
  tele.innerHTML =
    '<div class="ec-tele-bar"><span class="ec-tele-title">📜 提词器</span>' +
    '<button class="ec-tele-scroll" title="滚动（空格）">▶</button>' +
    '<button class="ec-tele-close" title="关闭">✕</button></div>' +
    '<div class="ec-tele-body">' +
    '<textarea class="ec-tele-text" placeholder="粘贴讲稿…按空格开始/暂停自动滚动，↑↓ 手动微调"></textarea>' +
    '<div class="ec-tele-text-actions"><button class="ec-tele-text-action" type="button" data-action="save-script">保存为讲稿</button><button class="ec-tele-text-action" type="button" data-action="load-script">载入讲稿文件…</button></div>' +
    '<div class="ec-tele-controls"><span>速度</span><input type="range" class="ec-tele-speed" min="1" max="40" step="1" value="6"/><span>字号</span><input type="range" class="ec-tele-fs" min="12" max="48" step="1" value="22"/><span>透明</span><input type="range" class="ec-tele-opacity" min="5" max="100" step="5" value="85"/></div>' +
    '<div class="ec-tele-controls"><span class="ec-kbd">空格</span>滚动/暂停 <span class="ec-kbd">↑</span><span class="ec-kbd">↓</span>微调</div>' +
    "</div>" +
    '<div class="ec-tele-resize"></div>';
  document.body.appendChild(tele);

  /* ============ Gestures (drag / resize) ============ */
  var gesture = null;
  function beginGesture(kind, el, ev) {
    ev.preventDefault();
    var rect = el.getBoundingClientRect();
    gesture = {
      kind: kind,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
      el: el,
    };
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (e) {}
    }
    if (el === bubble) bubble.classList.add("ec-dragging");
  }

  document.addEventListener("pointermove", function (ev) {
    if (!gesture) return;
    var el = gesture.el;
    var dx = ev.clientX - gesture.startX;
    var dy = ev.clientY - gesture.startY;
    if (gesture.kind === "drag") {
      el.style.left = clamp(gesture.x + dx, -80, window.innerWidth - 40) + "px";
      el.style.top = clamp(gesture.y + dy, 0, window.innerHeight - 40) + "px";
    } else {
      var nw = clamp(gesture.w + dx, 90, 640);
      var nh = clamp(gesture.h + dy, 70, 480);
      el.style.width = nw + "px";
      el.style.height = nh + "px";
      if (el === tele) {
        state.tele.width = nw;
        state.tele.height = nh;
      }
    }
  });

  function endGesture(ev) {
    if (gesture && gesture.pointerId === ev.pointerId) {
      if (bubble) bubble.classList.remove("ec-dragging");
      gesture = null;
    }
  }
  document.addEventListener("pointerup", endGesture);
  document.addEventListener("pointercancel", endGesture);

  bubble.addEventListener("pointerdown", function (ev) {
    if (ev.target.classList.contains("ec-bubble-resize")) {
      beginGesture("resize", bubble, ev);
    } else {
      beginGesture("drag", bubble, ev);
    }
  });

  /* ============ Camera ============ */
  var camEnable = shadow.getElementById("ec-cam-enable");
  var cameraDetails = shadow.getElementById("ec-camera-details");
  var camDevice = shadow.getElementById("ec-cam-device");
  var micDeviceSel = shadow.getElementById("ec-mic-device");
  var camShape = shadow.getElementById("ec-cam-shape");
  var camSize = shadow.getElementById("ec-cam-size");
  var camSizeV = shadow.getElementById("ec-cam-size-v");
  var camMirror = shadow.getElementById("ec-cam-mirror");
  var beautyToggle = shadow.getElementById("ec-beauty-toggle");
  var beautySmoothRow = shadow.getElementById("ec-beauty-smooth-row");
  var beautySmooth = shadow.getElementById("ec-beauty-smooth");
  var beautySmoothV = shadow.getElementById("ec-beauty-smooth-v");
  var beautyWhiteRow = shadow.getElementById("ec-beauty-white-row");
  var beautyWhite = shadow.getElementById("ec-beauty-white");
  var beautyWhiteV = shadow.getElementById("ec-beauty-white-v");
  var beautySlimRow = shadow.getElementById("ec-beauty-slim-row");
  var beautySlim = shadow.getElementById("ec-beauty-slim");
  var beautySlimV = shadow.getElementById("ec-beauty-slim-v");
  var beautyWarmRow = shadow.getElementById("ec-beauty-warm-row");
  var beautyWarm = shadow.getElementById("ec-beauty-warm");
  var beautyWarmV = shadow.getElementById("ec-beauty-warm-v");
  var beautySatRow = shadow.getElementById("ec-beauty-sat-row");
  var beautySat = shadow.getElementById("ec-beauty-sat");
  var beautySatV = shadow.getElementById("ec-beauty-sat-v");
  var lightToggle = shadow.getElementById("ec-light-toggle");
  var lightRow = shadow.getElementById("ec-light-row");
  var lightIntensity = shadow.getElementById("ec-light-intensity");
  var lightIntensityV = shadow.getElementById("ec-light-intensity-v");
  var screenLightToggle = shadow.getElementById("ec-screen-light-toggle");
  var screenLightRow = shadow.getElementById("ec-screen-light-row");
  var screenLightIntensity = shadow.getElementById("ec-screen-light-intensity");
  var screenLightIntensityV = shadow.getElementById("ec-screen-light-intensity-v");
  var screenLightNote = shadow.getElementById("ec-screen-light-note");
  var faceapiStatus = shadow.getElementById("ec-faceapi-status");

  /* face-api lazy init (local models only) */
  var faceApiState = {
    ready: false,
    loading: false,
    failed: false,
    landmarks: null,
    frameCounter: 0,
    slimCanvas: null,
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("加载失败: " + src));
      };
      document.head.appendChild(s);
    });
  }

  function initFaceApi() {
    if (faceApiState.ready || faceApiState.loading || faceApiState.failed) {
      return;
    }
    if (typeof window.faceapi !== "undefined") {
      faceApiState.ready = true;
      return;
    }
    faceApiState.loading = true;
    faceapiStatus.style.display = "block";
    faceapiStatus.textContent = "加载人脸检测模型…（本地运行）";
    Promise.all([
      loadScript("/recorder/vendor/tf.min.js"),
      loadScript("/recorder/vendor/face-api.min.js"),
    ])
      .then(function () {
        return Promise.all([
          window.faceapi.nets.tinyFaceDetector.loadFromUri(
            "/recorder/vendor/models",
          ),
          window.faceapi.nets.faceLandmark68Net.loadFromUri(
            "/recorder/vendor/models",
          ),
        ]);
      })
      .then(function () {
        faceApiState.ready = true;
        faceApiState.loading = false;
        faceapiStatus.textContent = "瘦脸：人脸检测已就绪（本地）";
        setTimeout(function () {
          faceapiStatus.style.display = "none";
        }, 2500);
      })
      .catch(function (err) {
        faceApiState.failed = true;
        faceApiState.loading = false;
        faceapiStatus.textContent =
          "人脸检测模型加载失败：" + (err && err.message ? err.message : err);
        setTimeout(function () {
          faceapiStatus.style.display = "none";
        }, 5000);
      });
  }

  function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }
    while (camDevice.options.length > 1) camDevice.remove(1);
    navigator.mediaDevices
      .enumerateDevices()
      .then(function (devices) {
        var index = 1;
        devices.forEach(function (d) {
          if (d.kind === "videoinput") {
            var opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || "摄像头 " + index;
            camDevice.appendChild(opt);
            index += 1;
          }
        });
        if (state.camera.deviceId && Array.prototype.some.call(camDevice.options, function (option) { return option.value === state.camera.deviceId; })) {
          camDevice.value = state.camera.deviceId;
        }
      })
      .catch(function () {});
  }

  function listMicrophones() {
    if (!micDeviceSel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }
    while (micDeviceSel.options.length > 1) micDeviceSel.remove(1);
    navigator.mediaDevices
      .enumerateDevices()
      .then(function (devices) {
        var index = 1;
        devices.forEach(function (d) {
          if (d.kind === "audioinput") {
            var opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || "麦克风 " + index;
            micDeviceSel.appendChild(opt);
            index += 1;
          }
        });
        if (state.mic.deviceId && Array.prototype.some.call(micDeviceSel.options, function (option) { return option.value === state.mic.deviceId; })) {
          micDeviceSel.value = state.mic.deviceId;
        }
      })
      .catch(function () {});
  }
  listCameras();
  listMicrophones();
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", function () {
      listCameras();
      listMicrophones();
    });
  }

  function stopCamera() {
    if (state.camera.raf) {
      cancelAnimationFrame(state.camera.raf);
      state.camera.raf = null;
    }
    if (state.camera.stream) {
      state.camera.stream.getTracks().forEach(function (t) {
        t.stop();
      });
      state.camera.stream = null;
    }
    if (state.camera.video) {
      state.camera.video.srcObject = null;
      state.camera.video.remove();
      state.camera.video = null;
    }
    state.camera.enabled = false;
    bubble.style.display = "none";
    updateScreenLight();
  }

  function updateScreenLight() {
    if (screenLightToggle) state.camera.screenLightEnabled = !!screenLightToggle.checked;
    if (screenLightIntensity) {
      state.camera.screenLightIntensity = clamp(parseFloat(screenLightIntensity.value) || 0, 0, 1);
    }
    var enabled = !!(state.camera.enabled && state.camera.screenLightEnabled);
    var intensity = clamp(state.camera.screenLightIntensity || 0, 0, 1);
    screenLight.style.display = enabled ? "block" : "none";
    screenLight.hidden = !enabled;
    screenLight.setAttribute("aria-hidden", enabled ? "false" : "true");
    screenLight.style.setProperty("--ec-screen-light", String(intensity));
    screenLight.style.opacity = enabled ? String(intensity) : "0";
    if (screenLightRow) screenLightRow.style.display = screenLightToggle && screenLightToggle.checked ? "flex" : "none";
    if (screenLightNote) screenLightNote.style.display = screenLightToggle && screenLightToggle.checked ? "block" : "none";
    if (screenLightIntensityV) screenLightIntensityV.textContent = Number(intensity).toFixed(2);
  }

  function applyBeautyFrame(video, w, h) {
    beautyCanvas.width = w;
    beautyCanvas.height = h;
    var ctx = beautyCanvas.getContext("2d");
    var warm = beautyToggle.checked ? parseFloat(beautyWarm.value) || 0 : 0;
    var sat = beautyToggle.checked ? parseFloat(beautySat.value) || 0 : 0;
    var light = lightToggle.checked ? parseFloat(lightIntensity.value) || 0 : 0;
    var hasFilter = (warm !== 0 || sat !== 0 || light > 0) && typeof ctx.filter === "string";
    ctx.save();
    if (state.camera.mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    if (hasFilter) {
      var f = "";
      if (warm !== 0) {
        f += "hue-rotate(" + (-warm * 14).toFixed(1) + "deg) ";
      }
      if (sat !== 0) {
        f += "saturate(" + (1 + sat * 0.45).toFixed(2) + ") ";
      }
      if (light > 0) {
        f +=
          "brightness(" +
          (1 + light * 0.32).toFixed(2) +
          ") contrast(" +
          (1 + light * 0.08).toFixed(2) +
          ")";
      }
      ctx.filter = f.trim();
    }
    ctx.drawImage(video, 0, 0, w, h);
    if (hasFilter) {
      ctx.filter = "none";
    }
    ctx.restore();
    var smooth = beautyToggle.checked ? state.camera.smoothing : 0;
    var white = beautyToggle.checked ? state.camera.whitening : 0;
    if (smooth > 0) {
      var blur = document.createElement("canvas");
      blur.width = Math.max(1, Math.round(w / 4));
      blur.height = Math.max(1, Math.round(h / 4));
      var bctx = blur.getContext("2d");
      bctx.drawImage(beautyCanvas, 0, 0, blur.width, blur.height);
      ctx.globalAlpha = smooth;
      ctx.drawImage(blur, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (white > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (white * 0.38).toFixed(3) + ")";
      ctx.fillRect(0, 0, w, h);
    }
    if (light > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = "rgba(255,244,220," + (light * 0.16).toFixed(3) + ")";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  function detectFaceLoop(video) {
    if (!faceApiState.ready) return;
    faceApiState.frameCounter += 1;
    if (faceApiState.frameCounter % 4 !== 0) return;
    window.faceapi
      .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .then(function (res) {
        faceApiState.landmarks = res ? res.landmarks : null;
      })
      .catch(function () {
        faceApiState.landmarks = null;
      });
  }

  /* Slim-face band resampling: squeeze cheeks toward the nose center.
   * target x (distance d from face center) maps to a source x farther out
   * (s = t * k, k>1 near the cheeks), so the rendered face is narrower. */
  function applySlim(srcCanvas, dstCanvas, w, h, cx, faceW, strength) {
    if (!dstCanvas) return;
    var ctx = dstCanvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    var half = faceW / 2;
    var N = 14;
    for (var i = 0; i < N; i++) {
      var x0 = Math.round((w * i) / N);
      var x1 = Math.max(x0 + 1, Math.round((w * (i + 1)) / N));
      var tcx = (x0 + x1) / 2;
      var d = Math.abs(tcx - cx) / half;
      var k = 1;
      if (d < 1) {
        var edgeBoost = Math.pow(Math.min(d, 1), 2);
        var falloff = Math.max(0, Math.min(1, (1.08 - d) / 0.22));
        k = 1 + strength * 0.4 * edgeBoost * falloff;
      }
      var scx = cx + (tcx - cx) * k;
      var sw = (x1 - x0) * k;
      ctx.drawImage(
        srcCanvas,
        scx - sw / 2,
        0,
        sw,
        h,
        x0,
        0,
        x1 - x0,
        h,
      );
    }
  }

  function renderCameraLoop() {
    var video = state.camera.video;
    if (!video || video.readyState < 2 || !video.videoWidth) {
      state.camera.raf = requestAnimationFrame(renderCameraLoop);
      return;
    }
    var w = video.videoWidth;
    var h = video.videoHeight;
    var useBeauty = beautyToggle.checked || lightToggle.checked;
    var canvas = bubble.querySelector("canvas");
    var videoEl = bubble.querySelector("video");
    if (useBeauty) {
      var needFace = parseFloat(beautySlim.value) > 0;
      if (needFace && !faceApiState.ready && !faceApiState.failed) {
        initFaceApi();
      }
      detectFaceLoop(video);
      applyBeautyFrame(video, w, h);
      var slimStrength = parseFloat(beautySlim.value) || 0;
      var lm = faceApiState.landmarks;
      if (
        slimStrength > 0 &&
        lm &&
        lm.positions &&
        lm.positions.length >= 15
      ) {
        if (!faceApiState.slimCanvas) {
          faceApiState.slimCanvas = document.createElement("canvas");
        }
        faceApiState.slimCanvas.width = w;
        faceApiState.slimCanvas.height = h;
        var p2 = lm.positions[2];
        var p14 = lm.positions[14];
        var faceCx = state.camera.mirrored
          ? w - (p2.x + p14.x) / 2
          : (p2.x + p14.x) / 2;
        var faceW = Math.abs(p14.x - p2.x);
        if (faceW > 10) {
          applySlim(
            beautyCanvas,
            faceApiState.slimCanvas,
            w,
            h,
            faceCx,
            faceW,
            clamp(slimStrength, 0, 1),
          );
          if (!canvas) {
            canvas = document.createElement("canvas");
            bubble.insertBefore(canvas, bubble.firstChild);
          }
          var sctx = canvas.getContext("2d");
          canvas.width = w;
          canvas.height = h;
          sctx.drawImage(faceApiState.slimCanvas, 0, 0);
        } else {
          if (!canvas) {
            canvas = document.createElement("canvas");
            bubble.insertBefore(canvas, bubble.firstChild);
          }
          var bctx = canvas.getContext("2d");
          canvas.width = w;
          canvas.height = h;
          bctx.drawImage(beautyCanvas, 0, 0);
        }
      } else {
        if (!canvas) {
          canvas = document.createElement("canvas");
          Object.assign(canvas.style, { width: "100%", height: "100%", objectFit: "cover", display: "block" });
          bubble.insertBefore(canvas, bubble.firstChild);
        }
        canvas.width = w;
        canvas.height = h;
        var bctx2 = canvas.getContext("2d");
        bctx2.drawImage(beautyCanvas, 0, 0);
      }
      if (videoEl) videoEl.remove();
    } else {
      if (!videoEl) {
        videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        bubble.insertBefore(videoEl, bubble.firstChild);
      }
      if (videoEl.srcObject !== state.camera.stream) {
        videoEl.srcObject = state.camera.stream;
      }
      videoEl.style.transform = state.camera.mirrored
        ? "scaleX(-1)"
        : "none";
      if (canvas) canvas.remove();
    }
    var empty = bubble.querySelector(".ec-bubble-empty");
    if (empty) empty.remove();
    state.camera.raf = requestAnimationFrame(renderCameraLoop);
  }

  function startCamera(options) {
    options = options || {};
    if (state.camera.stream) return;
    var constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    };
    if (state.camera.deviceId) {
      constraints.video.deviceId = { exact: state.camera.deviceId };
    }
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(function (stream) {
        state.camera.stream = stream;
        state.camera.enabled = true;
        var video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.srcObject = stream;
        video.setAttribute("aria-hidden", "true");
        Object.assign(video.style, {
          position: "fixed",
          left: "-10000px",
          top: "0",
          width: "2px",
          height: "2px",
          opacity: "0",
          pointerEvents: "none",
        });
        document.body.appendChild(video);
        state.camera.video = video;
        return video.play().then(function () {
          bubble.style.display = "block";
          updateScreenLight();
          if (!options.silentSuccess) toast("摄像头已开启");
          renderCameraLoop();
        });
      })
      .catch(function (err) {
        stopCamera();
        if (!options.silentError) {
          toast("摄像头开启失败：" + (err && err.message ? err.message : err));
        }
        camEnable.checked = false;
        updateCameraDetailsVisibility();
      });
  }

  function applyBubbleStyle() {
    var shape = state.camera.shape;
    if (shape === "circle") {
      bubble.style.borderRadius = "50%";
    } else if (shape === "pill") {
      bubble.style.borderRadius = "9999px";
    } else {
      bubble.style.borderRadius = "18px";
    }
    bubble.style.width = state.camera.size + "px";
    bubble.style.height =
      (shape === "circle"
        ? state.camera.size
        : Math.round(state.camera.size * 0.72)) + "px";
  }

  function updateCameraDetailsVisibility() {
    var open = Boolean(camEnable.checked);
    cameraDetails.hidden = !open;
    cameraDetails.classList.toggle("ec-open", open);
    cameraDetails.setAttribute("aria-hidden", open ? "false" : "true");
    camEnable.setAttribute("aria-expanded", open ? "true" : "false");
  }

  camEnable.addEventListener("change", function () {
    updateCameraDetailsVisibility();
    if (camEnable.checked) {
      startCamera();
    } else {
      stopCamera();
    }
  });
  updateCameraDetailsVisibility();
  camDevice.addEventListener("change", function () {
    state.camera.deviceId = camDevice.value;
    if (state.camera.enabled) {
      stopCamera();
      camEnable.checked = true;
      startCamera();
    }
  });
  camShape.addEventListener("change", function () {
    state.camera.shape = camShape.value;
    applyBubbleStyle();
  });
  camSize.addEventListener("input", function () {
    state.camera.size = parseInt(camSize.value, 10);
    camSizeV.textContent = state.camera.size;
    applyBubbleStyle();
  });
  camMirror.addEventListener("change", function () {
    state.camera.mirrored = camMirror.checked;
  });
  beautyToggle.addEventListener("change", function () {
    beautySmoothRow.style.display = beautyToggle.checked ? "flex" : "none";
    beautyWhiteRow.style.display = beautyToggle.checked ? "flex" : "none";
    beautySlimRow.style.display = beautyToggle.checked ? "flex" : "none";
    beautyWarmRow.style.display = beautyToggle.checked ? "flex" : "none";
    beautySatRow.style.display = beautyToggle.checked ? "flex" : "none";
    if (beautyToggle.checked && parseFloat(beautySlim.value) > 0) {
      initFaceApi();
    }
  });
  beautySmooth.addEventListener("input", function () {
    state.camera.smoothing = parseFloat(beautySmooth.value);
    beautySmoothV.textContent = Number(beautySmooth.value).toFixed(2);
  });
  beautyWhite.addEventListener("input", function () {
    state.camera.whitening = parseFloat(beautyWhite.value);
    beautyWhiteV.textContent = Number(beautyWhite.value).toFixed(2);
  });
  beautySlim.addEventListener("input", function () {
    state.camera.slim = parseFloat(beautySlim.value);
    beautySlimV.textContent = Number(beautySlim.value).toFixed(2);
    if (parseFloat(beautySlim.value) > 0) initFaceApi();
  });
  beautyWarm.addEventListener("input", function () {
    state.camera.skinWarm = parseFloat(beautyWarm.value);
    beautyWarmV.textContent =
      Number(beautyWarm.value) > 0
        ? "+" + Number(beautyWarm.value).toFixed(1)
        : Number(beautyWarm.value).toFixed(1);
  });
  beautySat.addEventListener("input", function () {
    state.camera.skinSat = parseFloat(beautySat.value);
    beautySatV.textContent =
      Number(beautySat.value) > 0
        ? "+" + Number(beautySat.value).toFixed(1)
        : Number(beautySat.value).toFixed(1);
  });
  lightToggle.addEventListener("change", function () {
    state.camera.lightEnabled = lightToggle.checked;
    lightRow.style.display = lightToggle.checked ? "flex" : "none";
  });
  lightIntensity.addEventListener("input", function () {
    state.camera.lightIntensity = parseFloat(lightIntensity.value);
    lightIntensityV.textContent = Number(lightIntensity.value).toFixed(2);
  });
  screenLightToggle.addEventListener("change", function () {
    updateScreenLight();
    v011ScheduleSave("screen-light");
    toast(screenLightToggle.checked ? "屏幕柔光已开启" : "屏幕柔光已关闭");
  });
  screenLightIntensity.addEventListener("input", function () {
    updateScreenLight();
    v011ScheduleSave("screen-light-intensity");
  });
  updateScreenLight();

  /* ============ Recording ============ */
  var recStart = shadow.getElementById("ec-rec-start");
  var recPause = shadow.getElementById("ec-rec-pause");
  var recStop = shadow.getElementById("ec-rec-stop");
  var recExport = shadow.getElementById("ec-export");
  var recOpen = shadow.getElementById("ec-export-open");
  var timerEl = shadow.getElementById("ec-timer");
  var indicator = shadow.getElementById("ec-indicator");
  var miniRecorder = shadow.getElementById("ec-mini-recorder");
  var miniTimer = shadow.getElementById("ec-mini-timer");
  var miniIndicator = shadow.getElementById("ec-mini-indicator");
  var miniStart = shadow.getElementById("ec-mini-start");
  var miniPause = shadow.getElementById("ec-mini-pause");
  var miniStop = shadow.getElementById("ec-mini-stop");
  var ratioSel = shadow.getElementById("ec-ratio");
  var ratioV = shadow.getElementById("ec-ratio-v");
  var customSizeRow = shadow.getElementById("ec-custom-size-row");
  var customWidthInput = shadow.getElementById("ec-custom-width");
  var customHeightInput = shadow.getElementById("ec-custom-height");
  var scopeSel = shadow.getElementById("ec-scope");
  var nativeStatusRow = shadow.getElementById("ec-native-status-row");
  var nativeStatusEl = shadow.getElementById("ec-native-status");
  var nativeSourceRow = shadow.getElementById("ec-native-source-row");
  var nativeSourceSel = shadow.getElementById("ec-native-source");
  var formatSel = shadow.getElementById("ec-format");
  var bgStyleSel = shadow.getElementById("ec-bg-style");
  var bgInput = shadow.getElementById("ec-bg");
  var composeChk = shadow.getElementById("ec-compose");
  var compositePositionSel = shadow.getElementById("ec-composite-position");
  var hideBubbleChk = shadow.getElementById("ec-hide-bubble");
  var cursorHighlightChk = shadow.getElementById("ec-cursor-highlight");
  var cursorOptions = shadow.getElementById("ec-cursor-options");
  var cursorHighlightStyleSel = shadow.getElementById("ec-cursor-highlight-style");
  var cursorShapeSel = shadow.getElementById("ec-cursor-shape");
  var cursorSoundSel = shadow.getElementById("ec-cursor-sound");
  var smartCameraChk = shadow.getElementById("ec-smart-camera");
  var smartCameraOptions = shadow.getElementById("ec-smart-camera-options");
  var smartSlideFocusChk = shadow.getElementById("ec-smart-slide-focus");
  var smartMouseFocusChk = shadow.getElementById("ec-smart-mouse-focus");
  var smartClickFocusChk = shadow.getElementById("ec-smart-click-focus");
  var smartCameraStrength = shadow.getElementById("ec-smart-camera-strength");
  var smartCameraSpeed = shadow.getElementById("ec-smart-camera-speed");
  var smartCameraHint = shadow.getElementById("ec-smart-camera-hint");
  var sourceModal = shadow.getElementById("ec-source-modal");
  var sourceOptions = shadow.getElementById("ec-source-options");
  var sourceCancel = shadow.getElementById("ec-source-cancel");
  var sourceConfirm = shadow.getElementById("ec-source-confirm");
  var sourcePickerMode = "system";
  var lastDisplaySourceValue = "display:";
  var lastWindowSourceValue = "";

  compositePositionSel.addEventListener("change", function () {
    state.camera.compositePosition = compositePositionSel.value || "bottom-right";
  });
  if (micDeviceSel) {
    micDeviceSel.addEventListener("change", function () {
      state.mic.deviceId = micDeviceSel.value || "";
      if (state.rec.active) {
        toast("麦克风选择会在下一次录制开始时生效");
      }
      v011ScheduleSave("microphone-device");
    });
  }

  var RATIOS = {
    youtube: [1920, 1080],
    "wechat-video": [1080, 1920],
    square: [1080, 1080],
    slides: [1440, 1080],
    "16:9": [1920, 1080],
    "4:3": [1440, 1080],
    "1:1": [1080, 1080],
    "9:16": [1080, 1920],
    "3:4": [1080, 1440],
  };

  function parseCustomRatio(value) {
    var match = /^custom:(\d{3,5})x(\d{3,5})$/i.exec(String(value || ""));
    if (!match) return null;
    return [
      clamp(parseInt(match[1], 10) || 1280, 320, 7680),
      clamp(parseInt(match[2], 10) || 720, 320, 7680),
    ];
  }

  function customRecordingSize() {
    return [
      clamp(parseInt(customWidthInput && customWidthInput.value, 10) || state.v011.recordingCustomWidth || 1280, 320, 7680),
      clamp(parseInt(customHeightInput && customHeightInput.value, 10) || state.v011.recordingCustomHeight || 720, 320, 7680),
    ];
  }

  function recordingSize() {
    if (ratioSel.value === "custom") return customRecordingSize();
    return RATIOS[ratioSel.value] || RATIOS.youtube;
  }

  function recordingRatioValue() {
    if (ratioSel.value !== "custom") return ratioSel.value || "youtube";
    var size = customRecordingSize();
    return "custom:" + size[0] + "x" + size[1];
  }

  function updateRatio() {
    var r = recordingSize();
    ratioV.textContent = r[0] + "×" + r[1];
    if (customSizeRow) customSizeRow.style.display = ratioSel.value === "custom" ? "flex" : "none";
  }
  function restoreV011RecordingSettings() {
    var savedScope = state.v011.recordingScope || "screen";
    var savedRatio = state.v011.recordingRatio || "youtube";
    var customSize = parseCustomRatio(savedRatio);
    if (Array.prototype.some.call(scopeSel.options, function (option) { return option.value === savedScope; })) {
      scopeSel.value = savedScope;
    }
    if (customSize) {
      state.v011.recordingCustomWidth = customSize[0];
      state.v011.recordingCustomHeight = customSize[1];
      if (customWidthInput) customWidthInput.value = String(customSize[0]);
      if (customHeightInput) customHeightInput.value = String(customSize[1]);
      ratioSel.value = "custom";
    } else if (Array.prototype.some.call(ratioSel.options, function (option) { return option.value === savedRatio; })) {
      ratioSel.value = savedRatio;
    } else if (savedRatio === "16:9") {
      ratioSel.value = "youtube";
    } else if (savedRatio === "9:16" || savedRatio === "3:4") {
      ratioSel.value = "wechat-video";
    } else if (savedRatio === "1:1") {
      ratioSel.value = "square";
    } else if (savedRatio === "4:3") {
      ratioSel.value = "slides";
    }
    updateRatio();
  }
  ratioSel.addEventListener("change", function () {
    updateRatio();
    state.v011.recordingRatio = recordingRatioValue();
    v011ScheduleSave("recording-ratio");
  });
  [customWidthInput, customHeightInput].forEach(function (input) {
    if (!input) return;
    input.addEventListener("input", function () {
      var size = customRecordingSize();
      state.v011.recordingCustomWidth = size[0];
      state.v011.recordingCustomHeight = size[1];
      state.v011.recordingRatio = recordingRatioValue();
      updateRatio();
      v011ScheduleSave("recording-custom-size");
    });
  });
  updateRatio();
  if (bgStyleSel) bgStyleSel.value = state.settings.backgroundStyle || "warm-gradient";
  if (bgInput) bgInput.value = state.settings.background || "#f4f1ea";
  if (bgStyleSel) {
    bgStyleSel.addEventListener("change", function () {
      state.settings.backgroundStyle = bgStyleSel.value || "warm-gradient";
      v011ScheduleSave("recording-background-style");
    });
  }
  if (bgInput) {
    bgInput.addEventListener("input", function () {
      state.settings.background = bgInput.value || "#f4f1ea";
      v011ScheduleSave("recording-background-color");
    });
  }

  function updateSmartCameraUI() {
    var isFrameScope = scopeSel.value === "frame";
    var isCanvasScope = scopeSel.value === "canvas";
    var canSlideFocus = isCanvasScope || isFrameScope;
    smartCameraOptions.style.display = smartCameraChk.checked ? "block" : "none";
    smartCameraChk.title = "录制时记录事件，录后生成非破坏式镜头轨";
    if (smartSlideFocusChk) {
      smartSlideFocusChk.disabled = !canSlideFocus;
      smartSlideFocusChk.parentElement.title = canSlideFocus
        ? "根据幻灯片切换生成全景/聚焦镜头"
        : "屏幕/窗口录制没有 Excalidraw 幻灯片上下文";
      if (!canSlideFocus) smartSlideFocusChk.checked = false;
      else smartSlideFocusChk.checked = state.smartCamera.slideFocus !== false;
      if (canSlideFocus) state.smartCamera.slideFocus = smartSlideFocusChk.checked;
    }
    if (smartMouseFocusChk) smartMouseFocusChk.checked = state.smartCamera.mouseFocus !== false;
    if (smartClickFocusChk) smartClickFocusChk.checked = state.smartCamera.clickFocus !== false;
    if (smartCameraHint) {
      smartCameraHint.textContent = canSlideFocus
        ? "录制时记录幻灯片切换、鼠标停留和点击；录后可调整镜头焦点、倍率和节奏。"
        : "屏幕/窗口录制会记录鼠标停留和点击；录后可生成并调整聚焦镜头，幻灯片聚焦仅用于白板。";
    }
  }

  smartCameraChk.addEventListener("change", function () {
    state.smartCamera.enabled = smartCameraChk.checked;
    updateSmartCameraUI();
    if (state.smartCamera.enabled) {
      toast("智能镜头已开启：录后会生成可调整的镜头建议");
    }
    v011ScheduleSave("smart-camera-setting");
  });
  [
    [smartSlideFocusChk, "slideFocus"],
    [smartMouseFocusChk, "mouseFocus"],
    [smartClickFocusChk, "clickFocus"],
  ].forEach(function (entry) {
    var input = entry[0];
    var key = entry[1];
    if (!input) return;
    input.addEventListener("change", function () {
      state.smartCamera[key] = input.checked;
      updateSmartCameraUI();
      v011ScheduleSave("smart-camera-" + key);
    });
  });
  smartCameraStrength.addEventListener("change", function () {
    state.smartCamera.strength = smartCameraStrength.value || "gentle";
    v011ScheduleSave("smart-camera-strength");
  });
  smartCameraSpeed.addEventListener("change", function () {
    state.smartCamera.speed = smartCameraSpeed.value || "standard";
    v011ScheduleSave("smart-camera-speed");
  });
  scopeSel.addEventListener("change", function () {
    state.v011.recordingScope = scopeSel.value;
    updateSmartCameraUI();
    v011ScheduleSave("recording-scope");
  });
  restoreV011RecordingSettings();
  smartCameraChk.checked = !!state.smartCamera.enabled;
  smartCameraStrength.value = state.smartCamera.strength || "gentle";
  smartCameraSpeed.value = state.smartCamera.speed || "standard";
  updateSmartCameraUI();

  function cameraDiameterRatio() {
    var shortEdge = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    return clamp((Number(state.camera.size) || Number(camSize.value) || 150) / shortEdge, 0.08, 0.50);
  }

  function cameraCompositeCenter() {
    var diameter = cameraDiameterRatio();
    var margin = 0.04;
    var position = state.camera.compositePosition || "bottom-right";
    return {
      x: position.indexOf("right") >= 0
        ? 1 - margin - diameter / 2
        : margin + diameter / 2,
      y: position.indexOf("bottom") >= 0
        ? 1 - margin - diameter / 2
        : margin + diameter / 2,
    };
  }

  function cameraCompositePlacement(W, H) {
    var radius = Math.min(W, H) * cameraDiameterRatio() / 2;
    var marginX = Math.max(24, W * 0.04);
    var marginY = Math.max(24, H * 0.04);
    var position = state.camera.compositePosition || "bottom-right";
    return {
      radius: radius,
      x: position.indexOf("right") >= 0 ? W - radius - marginX : radius + marginX,
      y: position.indexOf("bottom") >= 0 ? H - radius - marginY : radius + marginY,
    };
  }

  function nativeBridge() {
    return window.ExcalicordNativeBridge || null;
  }

  function updateNativeRows() {
    nativeStatusRow.style.display = "none";
    nativeSourceRow.style.display = "none";
  }

  function setNativeStatus(available, text) {
    state.rec.nativeAvailable = available;
    nativeStatusEl.textContent = text;
    nativeStatusEl.classList.toggle("ec-native-ready", available);
    nativeStatusEl.classList.toggle("ec-native-offline", !available);
    updateNativeRows();
  }

  function fileNameForExport(ext) {
    return (
      "excalicord-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "." +
      (ext || "mp4")
    );
  }

  function outputFileName(ext) {
    if (!state.rec.lastFileName) {
      state.rec.lastFileName = fileNameForExport(ext || state.rec.lastExt || "mp4");
    }
    return state.rec.lastFileName;
  }

  function resetSavedOutputMarkers() {
    state.rec.lastSavedPath = "";
    state.rec.lastSavedFileName = "";
    state.rec.lastSavedViaNative = false;
    state.rec.lastSavedToBrowserFolder = false;
    if (state.rec.lastPreviewUrl) {
      URL.revokeObjectURL(state.rec.lastPreviewUrl);
      state.rec.lastPreviewUrl = "";
    }
  }

  function markBrowserRecordingComplete(ext, mime) {
    state.rec.lastExt = ext || "mp4";
    state.rec.lastMime = mime || (state.rec.lastExt === "mp4" ? "video/mp4" : "video/webm");
    state.rec.lastFileName = fileNameForExport(state.rec.lastExt);
    resetSavedOutputMarkers();
  }

  function dispatchRecordingReady(fileName, duration) {
    var relativePath = recordingRelativePath(fileName);
    var name = String(relativePath || "").split(/[\\/]/).pop();
    if (!name || state.rec.recordingReadyDispatched) return;
    state.rec.recordingReadyDispatched = true;
    window.dispatchEvent(new CustomEvent("excalicord:recording-ready", {
      detail: {
        projectId: state.v011.projectId,
        sessionId: state.rec.sessionId || "",
        mediaPath: relativePath,
        fileName: name,
        duration: Number(duration || state.rec.seconds || 0),
        durationMs: Number(duration || state.rec.seconds || 0) * 1000,
      },
    }));
  }

  function resetCompletedRecordingState() {
    state.rec.chunks = [];
    state.rec.lastBlob = null;
    state.rec.lastFileName = "";
    state.rec.seconds = 0;
    state.rec.paused = false;
    state.rec.recorder = null;
    state.rec.selectedDisplaySurface = "";
    state.rec.usingDirectDisplay = false;
    state.rec.nativeRecordingReady = false;
    state.rec.nativeOutputPath = "";
    state.rec.sessionId = v011Id("session");
    state.rec.recordingReadyDispatched = false;
    state.rec.lastExt = "webm";
    state.rec.lastMime = "video/webm";
    updateRecordingTimers();
    resetSavedOutputMarkers();
    updateOutputActions();
  }

  function shortPath(path) {
    if (!path) return "";
    var homePrefix = "/Users/";
    if (path.indexOf(homePrefix) === 0) {
      var parts = path.split("/");
      if (parts.length > 3) return "~/" + parts.slice(3).join("/");
    }
    return path;
  }

  function setNativeProjectFolder(folder) {
    var path = folder && folder.path ? folder.path : "";
    if (state.rec.projectFolder.mode !== "native" || state.rec.projectFolder.path !== path) {
      state.rec.projectFolder.loadedOnce = false;
      state.rec.projectSceneFiles = {};
    }
    state.rec.projectFolder.mode = path ? "native" : "none";
    state.rec.projectFolder.path = path;
    state.rec.projectFolder.name = path ? shortPath(path) : "";
    state.rec.projectFolder.handle = null;
  }

  function setBrowserProjectFolder(handle) {
    if (state.rec.projectFolder.mode !== "browser" || state.rec.projectFolder.handle !== handle) {
      state.rec.projectFolder.loadedOnce = false;
      state.rec.projectSceneFiles = {};
    }
    state.rec.projectFolder.mode = handle ? "browser" : "none";
    state.rec.projectFolder.path = "";
    state.rec.projectFolder.name = handle && handle.name ? handle.name : "";
    state.rec.projectFolder.handle = handle || null;
  }

  function projectFolderLabel() {
    return state.rec.projectFolder.name || shortPath(state.rec.projectFolder.path) || "未选择";
  }

  function projectFolderDisplayPath() {
    if (state.rec.projectFolder.mode === "native" && state.rec.projectFolder.path) {
      return state.rec.projectFolder.path;
    }
    if (state.rec.projectFolder.mode === "browser" && state.rec.projectFolder.name) {
      return state.rec.projectFolder.name + "（浏览器授权目录）";
    }
    return "未选择";
  }

  function renderProjectFolderPath() {
    var pathDisplay = shadow.getElementById("ec-project-folder-path");
    var chooseButton = shadow.getElementById("ec-project-folder-choose");
    if (!pathDisplay) return;
    var displayPath = projectFolderDisplayPath();
    var value = pathDisplay.querySelector("strong");
    if (value) value.textContent = displayPath;
    pathDisplay.title = displayPath === "未选择" ? "未选择项目文件夹" : displayPath;
    pathDisplay.classList.toggle("ec-empty", displayPath === "未选择");
    if (chooseButton) chooseButton.textContent = "设置项目文件夹…";
  }

  function updateProjectFolderStatus() {
    updateOutputActions();
    renderProjectFolderPath();
    if (state.rec.projectFolder.mode !== "none") {
      updateV011ProjectStatus("项目文件夹已设置：" + projectFolderLabel() + "；白板、录制和成片都会写入这里。");
    } else {
      updateV011ProjectStatus("未设置项目文件夹；打开与保存均不会写入其他位置。");
    }
  }

  function hasCompletedRecording() {
    return !!state.rec.nativeRecordingReady || !!state.rec.lastBlob;
  }

  function updateOutputActions() {
    var hasMovie = hasCompletedRecording();
    var active = !!state.rec.active;
    if (!hasMovie) {
      recExport.textContent = "保存录制";
      recExport.title = "将原始录制保存到项目文件夹的 recordings 子文件夹";
      recOpen.textContent = "播放原始录制";
      recOpen.title = "录制完成后播放原始录制";
    } else if (state.rec.nativeRecordingReady) {
      recExport.textContent = "打开保存位置";
      recExport.title = "原始录制已自动保存，点击打开保存位置";
      recOpen.textContent = "播放原始录制";
      recOpen.title = "用系统默认播放器播放最后生成的原始录制";
    } else if (state.rec.nativeAvailable) {
      recExport.textContent = "保存录制";
      recExport.title = "保存到项目文件夹的 recordings 子文件夹；同一段重复保存会覆盖";
      recOpen.textContent = "播放原始录制";
      recOpen.title = "先保存原始录制，再用系统默认播放器播放";
    } else if (state.rec.projectFolder.handle) {
      recExport.textContent = "保存录制";
      recExport.title = "保存到项目文件夹的 recordings 子文件夹";
      recOpen.textContent = "播放原始录制";
      recOpen.title = "后台不可用时只能在新标签页播放原始录制";
    } else {
      recExport.textContent = "保存录制";
      recExport.title = "请先在项目区选择项目文件夹";
      recOpen.textContent = "播放原始录制";
      recOpen.title = "后台不可用时只能在新标签页播放原始录制";
    }
    recExport.disabled = active;
    recOpen.disabled = active || !hasMovie;
  }

  function refreshProjectFolderStatus() {
    var bridge = nativeBridge();
    var reader = bridge && (bridge.projectFolder || bridge.saveFolder);
    if (!bridge || !state.rec.nativeAvailable || !reader) {
      updateProjectFolderStatus();
      return Promise.resolve(false);
    }
    return reader()
      .then(function (folder) {
        setNativeProjectFolder(folder);
        updateProjectFolderStatus();
        return true;
      })
      .catch(function () {
        updateProjectFolderStatus();
        return false;
      });
  }

  function chooseBrowserSaveFolder() {
    if (!window.showDirectoryPicker) {
      toast("当前浏览器不支持项目文件夹，请使用支持 showDirectoryPicker 的浏览器或桌面录制服务");
      return Promise.resolve(false);
    }
    return window.showDirectoryPicker({ mode: "readwrite" })
      .then(function (handle) {
        setBrowserProjectFolder(handle);
        updateProjectFolderStatus();
        toast("已设置项目文件夹：" + projectFolderLabel());
        return true;
      })
      .catch(function (error) {
        if (error && error.name !== "AbortError") {
          toast("选择浏览器项目文件夹失败：" + (error.message || error));
        }
        updateProjectFolderStatus();
        return false;
      });
  }

  function chooseProjectFolder() {
    var bridge = nativeBridge();
    var chooser = bridge && (bridge.chooseProjectFolder || bridge.chooseSaveFolder);
    if (!bridge || !state.rec.nativeAvailable || !chooser) {
      return chooseBrowserSaveFolder();
    }
    updateV011ProjectStatus("正在选择项目文件夹…");
    return chooser()
      .then(function (folder) {
        if (folder && folder.cancelled) {
          updateV011ProjectStatus("已取消选择项目文件夹");
          return false;
        }
        setNativeProjectFolder(folder);
        updateProjectFolderStatus();
        toast("已设置项目文件夹：" + projectFolderLabel());
        return true;
      })
      .catch(function (error) {
        var message = error && error.message ? error.message : String(error || "");
        if (!/cancel/i.test(message)) toast("选择项目文件夹失败：" + message);
        updateProjectFolderStatus();
        return false;
      });
  }

  function openProjectFolder() {
    var bridge = nativeBridge();
    var opener = bridge && (bridge.openProjectFolder || bridge.openSaveFolder);
    if (bridge && state.rec.nativeAvailable && opener) {
      return opener()
        .then(function (folder) {
          setNativeProjectFolder(folder);
          updateProjectFolderStatus();
          toast("已在 Finder 中显示项目文件夹");
        })
        .catch(function (error) {
          toast("打开 Finder 失败：" + (error.message || error));
        });
    }
    if (state.rec.projectFolder.handle) {
      toast("项目文件夹已设置：" + projectFolderLabel() + "；浏览器不允许直接唤起系统文件管理器");
    } else {
      toast("请先设置项目文件夹；浏览器不允许直接唤起系统文件管理器");
    }
    return Promise.resolve(false);
  }

  function recordingRelativePath(filePath, fileName) {
    var raw = String(filePath || "").replace(/\\/g, "/");
    var marker = raw.indexOf("/recordings/");
    if (marker >= 0) raw = raw.slice(marker + 1);
    if (raw.indexOf("recordings/") === 0) return raw;
    var name = String(fileName || raw).split("/").pop();
    return "recordings/" + (state.rec.sessionId || "legacy") + "/" + name;
  }

  function sessionMetadataPayload() {
    var session = state.v011.session || {};
    return {
      schemaVersion: 1,
      sessionId: state.rec.sessionId || session.id || "",
      clock: { timebase: "recording-start", unit: "ms" },
      startedAt: session.startedAt || null,
      endedAt: session.endedAt || null,
      durationMs: Number(session.durationMs || Math.round(Number(session.duration || 0) * 1000)),
      scope: session.scope || state.v011.recordingScope || "screen",
      ratio: session.ratio || state.v011.recordingRatio || "16:9",
      initialFrameId: session.initialFrameId || "",
    };
  }

  function eventsMetadataPayload() {
    var events = state.v011.session && Array.isArray(state.v011.session.events)
      ? state.v011.session.events
      : [];
    return {
      schemaVersion: 1,
      sessionId: state.rec.sessionId || (state.v011.session && state.v011.session.id) || "",
      clock: { timebase: "recording-start", unit: "ms" },
      events: events.map(function (event) {
        var copy = Object.assign({}, event);
        copy.timeMs = Number.isFinite(Number(copy.timeMs))
          ? Math.max(0, Math.round(Number(copy.timeMs)))
          : Math.max(0, Math.round(Number(copy.t || 0) * 1000));
        delete copy.t;
        return copy;
      }),
    };
  }

  function writeRecordingMetadata(relativePath) {
    var parts = String(relativePath || "").split("/");
    if (parts.length !== 3 || parts[0] !== "recordings" || !parts[1]) {
      return Promise.resolve({ ok: true, legacy: true });
    }
    var assets = [
      ["recordings/" + parts[1] + "/session.json", JSON.stringify(sessionMetadataPayload(), null, 2)],
      ["recordings/" + parts[1] + "/events.json", JSON.stringify(eventsMetadataPayload(), null, 2)],
    ];
    var bridge = nativeBridge();
    if (state.rec.projectFolder.mode === "native") {
      if (!bridge || typeof bridge.writeProjectFile !== "function") {
        return Promise.reject(new Error("Native 会话元数据写入服务不可用"));
      }
      return assets.reduce(function (promise, asset) {
        return promise.then(function () { return bridge.writeProjectFile(asset[0], asset[1]); });
      }, Promise.resolve()).then(function () { return { ok: true }; });
    }
    if (state.rec.projectFolder.handle) {
      return assets.reduce(function (promise, asset) {
        return promise.then(function () { return saveProjectAssetBrowser(asset[0], asset[1]); });
      }, Promise.resolve()).then(function () { return { ok: true }; });
    }
    return Promise.resolve({ ok: true, localOnly: true });
  }

  function finalizeSavedRecording(filePath, fileName, mimeType, duration) {
    var relativePath = recordingRelativePath(filePath, fileName);
    v011RecordSavedMedia(relativePath, mimeType, duration);
    return writeRecordingMetadata(relativePath).then(function (result) {
      dispatchRecordingReady(relativePath, duration);
      return result;
    });
  }

  function saveBlobToBrowserFolder(blob, fileName) {
    var root = state.rec.projectFolder.handle;
    if (!root) return Promise.resolve(false);
    var overwritten = false;
    var recordingsHandle;
    var sessionHandle;
    var relativePath = "recordings/" + (state.rec.sessionId || "legacy") + "/" + fileName;
    return Promise.resolve()
      .then(function () {
        return root.requestPermission
          ? root.requestPermission({ mode: "readwrite" })
          : "granted";
      })
      .then(function (permission) {
        if (permission !== "granted") throw new Error("未获得文件夹写入权限");
        return root.getDirectoryHandle("recordings", { create: true });
      })
      .then(function (dir) {
        recordingsHandle = dir;
        return recordingsHandle.getDirectoryHandle(state.rec.sessionId || "legacy", { create: true });
      })
      .then(function (dir) {
        sessionHandle = dir;
        return sessionHandle.getFileHandle(fileName, { create: false })
          .then(function (fileHandle) {
            overwritten = true;
            return fileHandle;
          })
          .catch(function () {
            overwritten = false;
            return sessionHandle.getFileHandle(fileName, { create: true });
          });
      })
      .then(function (fileHandle) { return fileHandle.createWritable(); })
      .then(function (writable) {
        return writable.write(blob).then(function () { return writable.close(); });
      })
      .then(function () {
        state.rec.lastSavedFileName = fileName;
        state.rec.lastSavedPath = projectFolderLabel() + "/" + relativePath;
        state.rec.lastSavedViaNative = false;
        state.rec.lastSavedToBrowserFolder = true;
        return finalizeSavedRecording(relativePath, fileName, (blob && blob.type) || state.rec.lastMime, state.rec.seconds)
          .then(function () { return { ok: true, fileName: fileName, path: relativePath, overwritten: overwritten }; });
      });
  }

  function saveBlobViaNative(blob, fileName) {
    var bridge = nativeBridge();
    if (!bridge || !state.rec.nativeAvailable || !bridge.saveBrowserRecording) {
      return Promise.resolve(null);
    }
    var agentFileName = (state.rec.sessionId || "legacy") + "/" + fileName;
    return bridge.saveBrowserRecording(blob, agentFileName)
      .then(function (saved) {
        state.rec.lastSavedPath = saved && saved.path ? saved.path : state.rec.lastSavedPath;
        state.rec.lastSavedFileName = saved && saved.fileName ? saved.fileName.split("/").pop() : fileName;
        state.rec.lastSavedViaNative = true;
        state.rec.lastSavedToBrowserFolder = false;
        return finalizeSavedRecording(
          saved && (saved.path || saved.fileName) || state.rec.lastSavedPath,
          state.rec.lastSavedFileName || fileName,
          (blob && blob.type) || state.rec.lastMime,
          state.rec.seconds,
        ).then(function () { return saved; });
      });
  }

  function populateNativeSources(payload) {
    var selected = nativeSourceSel.value;
    var firstDisplay = (payload.displays || [])[0] || null;
    nativeSourceSel.innerHTML = "";
    var browserPicker = document.createElement("option");
    browserPicker.value = "browser-picker:";
    browserPicker.textContent = "系统选择器（推荐）";
    browserPicker.dataset.kind = "browser-picker";
    browserPicker.dataset.sourceName = "系统选择器（推荐）";
    browserPicker.dataset.meta = "打开浏览器自带选择器，可选择 Chrome 标签页、窗口或整个屏幕";
    nativeSourceSel.appendChild(browserPicker);
    var automatic = document.createElement("option");
    automatic.value = "display:";
    automatic.textContent = "自动选择主显示器";
    automatic.dataset.kind = "display";
    automatic.dataset.sourceName = "自动选择主显示器";
    automatic.dataset.thumbnail = firstDisplay && firstDisplay.thumbnail ? firstDisplay.thumbnail : "";
    nativeSourceSel.appendChild(automatic);
    (payload.displays || []).forEach(function (source, index) {
      var option = document.createElement("option");
      option.value = "display:" + source.id;
      option.textContent =
        (index === 0 ? "主显示器" : source.name) +
        "（" + source.width + "×" + source.height + "）";
      option.dataset.kind = "display";
      option.dataset.sourceName = index === 0 ? "主显示器" : source.name;
      option.dataset.width = source.width || "";
      option.dataset.height = source.height || "";
      option.dataset.thumbnail = source.thumbnail || "";
      nativeSourceSel.appendChild(option);
    });
    (payload.windows || []).forEach(function (source) {
      var option = document.createElement("option");
      option.value = "window:" + source.id;
      option.textContent =
        "窗口 · " +
        (source.application ? source.application + " · " : "") +
        source.name;
      option.dataset.kind = "window";
      option.dataset.sourceName = source.name || "";
      option.dataset.application = source.application || "";
      option.dataset.width = source.width || "";
      option.dataset.height = source.height || "";
      option.dataset.thumbnail = source.thumbnail || "";
      nativeSourceSel.appendChild(option);
    });
    if (selected && nativeSourceSel.querySelector('option[value="' + selected + '"]')) {
      nativeSourceSel.value = selected;
    }
  }

  function sourceLabelFromOption(option) {
    var value = option.value || "";
    var text = option.textContent || "";
    if (value === "browser-picker:") {
      return {
        kind: "系统选择器",
        text: "打开系统选择器",
        meta: option.dataset.meta || "可选择浏览器标签页、窗口或整个屏幕，并看到真实预览",
        thumbnail: "",
        previewText: "🧭",
      };
    }
    if (value.indexOf("window:") === 0) {
      var app = option.dataset.application || "";
      var rawName = option.dataset.sourceName || text.replace(/^窗口 ·\s*/, "") || "";
      var name = rawName.trim();
      var browserWindow = isBrowserSourceOption(option);
      if (!name || /^窗口\s*\d+$/i.test(name) || /^window\s*\d+$/i.test(name)) {
        name = app
          ? app + (browserWindow ? " 浏览器窗口" : " 应用窗口")
          : (browserWindow ? "浏览器窗口" : "应用窗口");
      } else if (app && name.indexOf(app) !== 0) {
        name = app + " · " + name;
      }
      return {
        kind: browserWindow ? "浏览器窗口" : "应用窗口",
        text: name || (browserWindow ? "浏览器窗口" : "应用窗口"),
        meta: sourceMeta(option, browserWindow ? "整窗录制（不是单个 Tab）" : "应用窗口"),
        thumbnail: option.dataset.thumbnail || "",
      };
    }
    return {
      kind: "全局桌面",
      text: option.dataset.sourceName || text.replace(/^主显示器/, "主显示器") || "自动选择主显示器",
      meta: sourceMeta(option, "全屏录制"),
      thumbnail: option.dataset.thumbnail || "",
    };
  }

  function sourceMeta(option, fallback) {
    var width = option.dataset.width || "";
    var height = option.dataset.height || "";
    return width && height ? fallback + " · " + width + "×" + height : fallback;
  }

  function isSuppressedSourceOption(option) {
    var value = option.value || "";
    var text = option.textContent || "";
    if (value.indexOf("window:") !== 0) return false;
    return /Open and Save Panel Service|自动填充|Autofill|Save Panel|Open Panel|AccessibilityVisualsAgent|Notification Center|控制中心|程序坞|Dock|Wallpaper|聚焦|Display \d+ Backstop/i.test(text);
  }

  function isBrowserSourceOption(option) {
    var value = option.value || "";
    var text = option.textContent || "";
    if (value.indexOf("window:") !== 0 || isSuppressedSourceOption(option)) return false;
    return /Chrome|Chromium|Microsoft Edge|\bEdge\b|Safari|Firefox|Arc|Brave|浏览器|Excalidraw|localhost|127\.0\.0\.1|5001/i.test(text);
  }

  function isGenericBrowserShell(option) {
    var name = (option.dataset.sourceName || "").trim();
    if (!isBrowserSourceOption(option)) return false;
    if (option.dataset.thumbnail) return false;
    return !name || /^窗口\s*\d+$/i.test(name) || /^window\s*\d+$/i.test(name);
  }

  function isGenericUntitledWindow(option) {
    var name = (option.dataset.sourceName || "").trim();
    if (option.dataset.thumbnail) return false;
    return !name || /^窗口\s*\d+$/i.test(name) || /^window\s*\d+$/i.test(name);
  }

  function isApplicationSourceOption(option) {
    var value = option.value || "";
    if (value.indexOf("window:") !== 0) return false;
    if (isSuppressedSourceOption(option)) return false;
    if (isGenericBrowserShell(option)) return false;
    if (isGenericUntitledWindow(option)) return false;
    return true;
  }

  function browserSourceRank(option) {
    var text = option.textContent || "";
    if (/localhost|127\.0\.0\.1|5001|Excalidraw/i.test(text)) return 0;
    if (/Microsoft Edge|\bEdge\b/i.test(text)) return 1;
    if (/Safari|Firefox|Arc|Brave/i.test(text)) return 2;
    if (/Chrome|Chromium/i.test(text)) return 3;
    return 4;
  }

  function allNativeSourceOptions() {
    return Array.from(nativeSourceSel.options);
  }

  function displaySourceOptions() {
    return allNativeSourceOptions().filter(function (option) {
      return (option.value || "").indexOf("display:") === 0;
    });
  }

  function windowSourceOptions() {
    return allNativeSourceOptions()
      .filter(isApplicationSourceOption)
      .sort(function (a, b) {
        var diff = browserSourceRank(a) - browserSourceRank(b);
        if (diff) return diff;
        return (a.textContent || "").localeCompare(b.textContent || "");
      });
  }

  function sourceModeFromValue(value) {
    if ((value || "") === "browser-picker:") return "system";
    if ((value || "").indexOf("display:") === 0) return "desktop";
    if ((value || "").indexOf("window:") === 0) return "window";
    return "system";
  }

  function setSourcePickerMode(mode) {
    sourcePickerMode = mode || "system";
    if (sourcePickerMode === "system") {
      nativeSourceSel.value = "browser-picker:";
    } else if (sourcePickerMode === "desktop") {
      var displays = displaySourceOptions();
      if (!displays.some(function (option) { return option.value === lastDisplaySourceValue; })) {
        lastDisplaySourceValue = displays[0] ? displays[0].value : "display:";
      }
      nativeSourceSel.value = lastDisplaySourceValue;
    } else if (sourcePickerMode === "window") {
      var windows = windowSourceOptions();
      if (!windows.some(function (option) { return option.value === lastWindowSourceValue; })) {
        lastWindowSourceValue = windows[0] ? windows[0].value : "";
      }
      if (lastWindowSourceValue) nativeSourceSel.value = lastWindowSourceValue;
    }
    renderSourcePickerOptions();
    updateProjectFolderStatus();
  }

  function currentModeSourceOptions() {
    if (sourcePickerMode === "desktop") return displaySourceOptions();
    if (sourcePickerMode === "window") return windowSourceOptions();
    return [];
  }

  function createModeCard(mode, title, subtitle, badge) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ec-source-mode" + (sourcePickerMode === mode ? " ec-active" : "");
    button.dataset.mode = mode;
    var top = document.createElement("span");
    top.className = "ec-source-mode-title";
    top.textContent = title;
    var sub = document.createElement("span");
    sub.className = "ec-source-mode-sub";
    sub.textContent = subtitle;
    button.appendChild(top);
    if (badge) {
      var b = document.createElement("span");
      b.className = "ec-source-mode-badge";
      b.textContent = badge;
      button.appendChild(b);
    }
    button.appendChild(sub);
    button.addEventListener("click", function () {
      setSourcePickerMode(mode);
    });
    return button;
  }

  function createSourceModeTabs() {
    var modes = document.createElement("div");
    modes.className = "ec-source-modes";
    modes.appendChild(createModeCard(
      "system",
      "系统选择器",
      "看真实 Tab / 窗口 / 屏幕预览",
      "推荐"
    ));
    modes.appendChild(createModeCard(
      "desktop",
      "录制整个桌面",
      "浏览器可最小化，适合多 App 切换",
      "稳定"
    ));
    modes.appendChild(createModeCard(
      "window",
      "录制指定窗口",
      "固定录 Zotero / PPT / 飞书等窗口",
      "精准"
    ));
    sourceOptions.appendChild(modes);
  }

  function createSourceHint(title, body) {
    var hint = document.createElement("div");
    hint.className = "ec-source-hint";
    var h = document.createElement("div");
    h.className = "ec-source-hint-title";
    h.textContent = title;
    var p = document.createElement("div");
    p.className = "ec-source-hint-body";
    p.textContent = body;
    hint.appendChild(h);
    hint.appendChild(p);
    sourceOptions.appendChild(hint);
  }

  function renderSourceRadioOption(option, index) {
    var value = option.value;
    var label = sourceLabelFromOption(option);
    var item = document.createElement("label");
    item.className = "ec-source-option";
    var checked = value === nativeSourceSel.value || (!nativeSourceSel.value && index === 0);
    var radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ec-source-choice";
    radio.value = value;
    radio.checked = checked;
    radio.addEventListener("change", function () {
      nativeSourceSel.value = value;
      if (value.indexOf("display:") === 0) lastDisplaySourceValue = value;
      if (value.indexOf("window:") === 0) lastWindowSourceValue = value;
    });
    var preview = document.createElement("span");
    preview.className = "ec-source-preview";
    if (label.thumbnail && /^data:image\//.test(label.thumbnail)) {
      var img = document.createElement("img");
      img.src = label.thumbnail;
      img.alt = label.text + " 预览";
      img.loading = "lazy";
      preview.appendChild(img);
    } else {
      var isWindow = value.indexOf("window:") === 0;
      preview.classList.add(isWindow ? "ec-source-preview-browser" : "ec-source-preview-display");
      preview.textContent = label.previewText || (isWindow ? "🪟" : "🖥");
    }
    var kind = document.createElement("span");
    kind.className = "ec-source-kind";
    kind.textContent = label.kind;
    var textWrap = document.createElement("span");
    textWrap.className = "ec-source-text";
    var name = document.createElement("span");
    name.className = "ec-source-name";
    name.textContent = label.text;
    var meta = document.createElement("span");
    meta.className = "ec-source-meta";
    meta.textContent = label.meta || "";
    item.appendChild(radio);
    item.appendChild(preview);
    textWrap.appendChild(kind);
    textWrap.appendChild(name);
    textWrap.appendChild(meta);
    item.appendChild(textWrap);
    return item;
  }

  function renderSourcePickerOptions() {
    sourceOptions.innerHTML = "";
    sourceConfirm.disabled = false;
    createSourceModeTabs();

    if (sourcePickerMode === "system") {
      nativeSourceSel.value = "browser-picker:";
      createSourceHint(
        "下一步会打开浏览器自带选择器",
        "里面可以选择 Chrome 标签页、窗口或整个屏幕，并显示系统级真实预览；这是最适合临时选择来源的方式。"
      );
      return;
    }

    var pickerOptions = currentModeSourceOptions();
    if (!pickerOptions.length) {
      var empty = document.createElement("div");
      empty.className = "ec-source-empty";
      empty.textContent = sourcePickerMode === "window"
        ? "未找到可录制窗口。请先打开 Zotero、PPT、飞书等应用窗口，或改用系统选择器。"
        : "未找到可录制显示器。请检查桌面录制服务或屏幕录制权限。";
      sourceOptions.appendChild(empty);
      sourceConfirm.disabled = true;
      return;
    }

    if (sourcePickerMode === "desktop") {
      createSourceHint(
        "后台直接录整个桌面",
        "适合浏览器最小化后继续录制，或在 Zotero、PPT、浏览器之间切换。"
      );
    } else if (sourcePickerMode === "window") {
      createSourceHint(
        "后台直接录指定窗口",
        "适合固定录 Zotero、PPT、飞书或某个浏览器窗口；不会再打开系统选择器。"
      );
    }

    if (!pickerOptions.some(function (option) { return option.value === nativeSourceSel.value; })) {
      nativeSourceSel.value = pickerOptions[0].value;
    }

    pickerOptions.forEach(function (option, index) {
      sourceOptions.appendChild(renderSourceRadioOption(option, index));
    });
  }

  function closeSourcePicker() {
    sourceModal.classList.remove("ec-open");
    sourceModal.setAttribute("aria-hidden", "true");
  }

  function chooseNativeSource() {
    sourcePickerMode = "system";
    nativeSourceSel.value = "browser-picker:";
    renderSourcePickerOptions();
    sourceModal.classList.add("ec-open");
    sourceModal.setAttribute("aria-hidden", "false");
    return new Promise(function (resolve) {
      function cleanup(result) {
        sourceCancel.removeEventListener("click", onCancel);
        sourceConfirm.removeEventListener("click", onConfirm);
        sourceModal.removeEventListener("click", onBackdrop);
        closeSourcePicker();
        resolve(result);
      }
      function onCancel() { cleanup(false); }
      function onConfirm() {
        var checked = sourceOptions.querySelector('input[name="ec-source-choice"]:checked');
        if (checked) nativeSourceSel.value = checked.value;
        cleanup(true);
      }
      function onBackdrop(ev) {
        if (ev.target === sourceModal) cleanup(false);
      }
      sourceCancel.addEventListener("click", onCancel);
      sourceConfirm.addEventListener("click", onConfirm);
      sourceModal.addEventListener("click", onBackdrop);
      var first = sourceOptions.querySelector("input");
      if (first) first.focus({ preventScroll: true });
    });
  }

  function loadNativeSources() {
    var bridge = nativeBridge();
    if (!bridge || !state.rec.nativeAvailable) return Promise.resolve(false);
    nativeStatusEl.textContent = "正在读取桌面和窗口…";
    return bridge.sources()
      .then(function (payload) {
        populateNativeSources(payload);
        nativeStatusEl.textContent = "桌面录制服务已连接";
        return true;
      })
      .catch(function (error) {
        nativeStatusEl.textContent = "需要屏幕录制权限";
        toast("无法读取录制来源：" + (error.message || error));
        return false;
      });
  }

  function refreshNativeEngine(force) {
    var bridge = nativeBridge();
    if (!bridge) {
      setNativeStatus(false, "未安装 · 使用浏览器录制");
      return Promise.resolve(false);
    }
    return bridge.health(force)
      .then(function (health) {
        var ready =
          health &&
          health.ok &&
          (health.capabilities || []).indexOf("display") !== -1;
        setNativeStatus(
          ready,
          ready
            ? health.permissions && health.permissions.screen === false
              ? "已连接 · 首次录制需授权屏幕"
              : "已连接 · 浏览器可最小化"
            : "桌面录制服务尚未就绪",
        );
        if (ready) refreshProjectFolderStatus();
        else updateProjectFolderStatus();
        if (ready && (health.state === "recording" || health.state === "paused")) {
          return bridge.status().then(function (status) {
            state.rec.nativeActive = true;
            state.rec.active = true;
            state.rec.paused = status.state === "paused";
            state.rec.seconds = Math.max(0, Math.floor(status.seconds || 0));
            state.rec.nativeOutputPath = status.outputPath || "";
            updateRecordingTimers();
            if (!state.rec.timer) state.rec.timer = setInterval(tickTimer, 1000);
            setRecUI(true, state.rec.paused);
            return true;
          });
        }
        return ready;
      })
      .catch(function () {
        setNativeStatus(false, "未连接 · 使用浏览器录制");
        return false;
      });
  }

  scopeSel.addEventListener("change", updateNativeRows);
  scopeSel.addEventListener("change", updateProjectFolderStatus);
  updateNativeRows();
  updateProjectFolderStatus();
  refreshNativeEngine(false);

  function pickMimeType() {
    var want = formatSel.value;
    var mp4Candidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1.4d002a",
      "video/mp4;codecs=avc1.640028",
      "video/mp4",
    ];
    var candidates =
      want === "auto"
        ? mp4Candidates.concat([
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ])
        : want === "video/mp4"
          ? mp4Candidates
          : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < candidates.length; i++) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(candidates[i])
      ) {
        return candidates[i];
      }
    }
    return "video/webm";
  }

  function updateRecordingTimers() {
    var value = fmtTime(state.rec.seconds);
    timerEl.textContent = value;
    if (miniTimer) miniTimer.textContent = value;
  }

  function tickTimer() {
    state.rec.seconds += 1;
    updateRecordingTimers();
  }

  function setRecUI(active, paused) {
    recStart.disabled = active && !paused;
    recPause.disabled = !active;
    recStop.disabled = !active;
    recPause.innerHTML = buttonWithShortcut(paused ? "继续" : "暂停", shortcutLabel("P"));
    recPause.title = (paused ? "继续录制" : "暂停录制") + "（快捷键：" + shortcutLabel("P") + "）";
    recPause.setAttribute("aria-label", (paused ? "继续录制" : "暂停录制") + "，快捷键 " + shortcutLabel("P"));
    recPause.classList.toggle("ec-is-resume", !!paused);
    indicator.classList.toggle("ec-live", active);
    indicator.classList.toggle("ec-paused", !!active && !!paused);
    launcher.classList.toggle("ec-recording", !!active && !paused);
    launcher.classList.toggle("ec-paused", !!active && !!paused);
    if (active) {
      panel.classList.remove("ec-open");
      launcher.classList.remove("ec-panel-open");
    }
    if (miniRecorder) {
      miniRecorder.classList.toggle("ec-open", !!active);
      miniRecorder.classList.toggle("ec-paused", !!active && !!paused);
      miniRecorder.setAttribute("aria-hidden", active ? "false" : "true");
    }
    if (miniIndicator) {
      miniIndicator.classList.toggle("ec-paused", !!active && !!paused);
    }
    if (miniStart) miniStart.disabled = !!active;
    if (miniPause) {
      miniPause.disabled = !active;
      miniPause.textContent = paused ? "继续" : "暂停";
      miniPause.title = paused ? "继续录制" : "暂停录制";
    }
    if (miniStop) miniStop.disabled = !active;
    updateRecordingTimers();
    updateOutputActions();
  }

  function stopCursorSoundMix() {
    if (state.cursor.soundContext && typeof state.cursor.soundContext.close === "function") {
      state.cursor.soundContext.close().catch(function () {});
    }
    state.cursor.soundContext = null;
    state.cursor.soundDestination = null;
    state.cursor.soundNodes = [];
  }

  function mixedBrowserAudioTracks(audioTracks) {
    var inputTracks = (Array.isArray(audioTracks) ? audioTracks : []).filter(function (track) {
      return track && track.readyState !== "ended";
    });
    stopCursorSoundMix();
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var destination = ac.createMediaStreamDestination();
      var nodes = [];
      inputTracks.forEach(function (track) {
        var source = ac.createMediaStreamSource(new MediaStream([track]));
        source.connect(destination);
        nodes.push(source);
      });
      state.cursor.soundContext = ac;
      state.cursor.soundDestination = destination;
      state.cursor.soundNodes = nodes;
      return destination.stream.getAudioTracks();
    } catch (e) {
      stopCursorSoundMix();
      return inputTracks;
    }
  }

  function stopComposeLoop() {
    if (state.rec.composeRaf) {
      cancelAnimationFrame(state.rec.composeRaf);
      state.rec.composeRaf = null;
    }
    state.rec.composeCanvas = null;
    state.rec.composeCtx = null;
    state.rec.composeVideo = null;
    if (state.rec.displayStream) {
      state.rec.displayStream.getTracks().forEach(function (t) {
        t.stop();
      });
      state.rec.displayStream = null;
    }
    stopMicPolling();
    if (state.mic.stream) {
      state.mic.stream.getTracks().forEach(function (t) { t.stop(); });
      state.mic.stream = null;
      state.mic.analyser = null;
      state.mic.dataArray = null;
    }
    if (state.mic.audioContext && typeof state.mic.audioContext.close === "function") {
      state.mic.audioContext.close().catch(function () {});
      state.mic.audioContext = null;
    }
    stopCursorSoundMix();
    cursorHighlight.style.display = "none";
  }

  function sceneCanvas() {
    return (
      document.querySelector("canvas.excalidraw__canvas.interactive") ||
      document.querySelector(".excalidraw__canvas canvas") ||
      document.querySelector(".excalidraw-container canvas")
    );
  }

  function sceneStaticCanvas() {
    return (
      document.querySelector("canvas.excalidraw__canvas:not(.interactive)") ||
      document.querySelector(".excalidraw__canvas.static canvas") ||
      null
    );
  }

  function allSceneCanvases() {
    var canvases = document.querySelectorAll("canvas.excalidraw__canvas");
    if (canvases.length >= 2) return Array.from(canvases);
    var interactive = sceneCanvas();
    var staticC = sceneStaticCanvas();
    if (staticC && interactive && staticC !== interactive) return [staticC, interactive];
    return interactive ? [interactive] : [];
  }

  function sceneCanvasRect() {
    var canvas = sceneCanvas();
    if (!canvas) return null;
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function drawFittedSource(ctx, source, crop, W, H, mode) {
    if (!source || !crop || crop.sw <= 1 || crop.sh <= 1) return false;
    var scale =
      mode === "cover"
        ? Math.max(W / crop.sw, H / crop.sh)
        : Math.min(W / crop.sw, H / crop.sh);
    var dw = crop.sw * scale;
    var dh = crop.sh * scale;
    ctx.drawImage(
      source,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      (W - dw) / 2,
      (H - dh) / 2,
      dw,
      dh,
    );
    return true;
  }

  function visibleCanvasCrop(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    return { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height };
  }

  function activeFrameElement() {
    var frames = getFrames();
    if (!frames.length) return null;
    var activeId = currentFrameId(frames);
    return (
      frames.find(function (frame) {
        return frame.id === activeId;
      }) || frames[0]
    );
  }

  function activeFrameCanvasCrop(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    var frame = activeFrameElement();
    if (!frame) return null;
    var appState = readCurrentAppStateSafe();
    var zoom =
      appState.zoom && typeof appState.zoom.value === "number"
        ? appState.zoom.value
        : 1;
    var scrollX = Number(appState.scrollX) || 0;
    var scrollY = Number(appState.scrollY) || 0;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var pad = 32;
    var cssX = ((Number(frame.x) || 0) + scrollX) * zoom - pad;
    var cssY = ((Number(frame.y) || 0) + scrollY) * zoom - pad;
    var cssW = Math.max(1, (Number(frame.width) || 1600) * zoom + pad * 2);
    var cssH = Math.max(1, (Number(frame.height) || 900) * zoom + pad * 2);
    var x0 = clamp(cssX - rect.left, 0, rect.width);
    var y0 = clamp(cssY - rect.top, 0, rect.height);
    var x1 = clamp(cssX + cssW - rect.left, 0, rect.width);
    var y1 = clamp(cssY + cssH - rect.top, 0, rect.height);
    if (x1 - x0 < 8 || y1 - y0 < 8) return visibleCanvasCrop(canvas);
    return {
      sx: x0 * scaleX,
      sy: y0 * scaleY,
      sw: (x1 - x0) * scaleX,
      sh: (y1 - y0) * scaleY,
    };
  }

  function applySmartCameraCrop(baseCrop, canvasWidth, canvasHeight, scope) {
    var smart = state.smartCamera;
    smart.renderedCrop = baseCrop;
    if (!smart.enabled || !smart.pointerInsideCanvas) {
      smart.targetScale = 1;
    }
    smart.currentX += (smart.targetX - smart.currentX) * 0.12;
    smart.currentY += (smart.targetY - smart.currentY) * 0.12;
    smart.currentScale += (smart.targetScale - smart.currentScale) * 0.10;
    if (Math.abs(smart.currentScale - 1) < 0.005) smart.currentScale = 1;
    if (Math.abs(smart.currentX - smart.targetX) < 0.002) smart.currentX = smart.targetX;
    if (Math.abs(smart.currentY - smart.targetY) < 0.002) smart.currentY = smart.targetY;
    if (!smart.enabled || smart.currentScale <= 1.01) return baseCrop;

    var centerX = smart.currentX * canvasWidth;
    var centerY = smart.currentY * canvasHeight;
    if (scope === "frame") {
      centerX = clamp(centerX, baseCrop.sx + baseCrop.sw * 0.18, baseCrop.sx + baseCrop.sw * 0.82);
      centerY = clamp(centerY, baseCrop.sy + baseCrop.sh * 0.18, baseCrop.sy + baseCrop.sh * 0.82);
    }
    var sw = Math.max(8, baseCrop.sw / smart.currentScale);
    var sh = Math.max(8, baseCrop.sh / smart.currentScale);
    var sx = clamp(centerX - sw / 2, baseCrop.sx, baseCrop.sx + baseCrop.sw - sw);
    var sy = clamp(centerY - sh / 2, baseCrop.sy, baseCrop.sy + baseCrop.sh - sh);
    smart.renderedCrop = { sx: sx, sy: sy, sw: sw, sh: sh };
    return smart.renderedCrop;
  }

  function drawWhiteboardSource(ctx, W, H, video) {
    var scope = scopeSel.value;
    var canvases = allSceneCanvases();
    if (!canvases.length) return false;
    var excalCanvas = canvases[0];
    var cW = excalCanvas.width;
    var cH = excalCanvas.height;
    if (!cW || !cH) return false;
    if (!state.rec._wbCopy || state.rec._wbCopy.width !== cW || state.rec._wbCopy.height !== cH) {
      state.rec._wbCopy = document.createElement("canvas");
      state.rec._wbCopy.width = cW;
      state.rec._wbCopy.height = cH;
    }
    var copyCtx = state.rec._wbCopy.getContext("2d");
    try {
      copyCtx.clearRect(0, 0, cW, cH);
      for (var ci = 0; ci < canvases.length; ci++) {
        copyCtx.drawImage(canvases[ci], 0, 0);
      }
    } catch (e) { return false; }
    var cssRect = sceneCanvasRect();
    if (!cssRect) return false;
    var pxPerCssX = cW / (cssRect.width || 1);
    var pxPerCssY = cH / (cssRect.height || 1);
    var crop;
    if (scope === "frame") {
      var frame = activeFrameElement();
      if (!frame) return false;
      var appState = readCurrentAppStateSafe();
      var zoom = appState.zoom && typeof appState.zoom.value === "number" ? appState.zoom.value : 1;
      var scrollX = Number(appState.scrollX) || 0;
      var scrollY = Number(appState.scrollY) || 0;
      var pad = 32;
      var cssX = ((Number(frame.x) || 0) + scrollX) * zoom - pad;
      var cssY = ((Number(frame.y) || 0) + scrollY) * zoom - pad;
      var cssW = Math.max(1, (Number(frame.width) || 1600) * zoom + pad * 2);
      var cssH = Math.max(1, (Number(frame.height) || 900) * zoom + pad * 2);
      crop = {
        sx: clamp(cssX * pxPerCssX, 0, cW),
        sy: clamp(cssY * pxPerCssY, 0, cH),
        sw: clamp(cssW * pxPerCssX, 1, cW),
        sh: clamp(cssH * pxPerCssY, 1, cH),
      };
    } else {
      crop = {
        sx: 0,
        sy: 0,
        sw: cW,
        sh: cH,
      };
    }
    return drawFittedSource(
      ctx,
      state.rec._wbCopy,
      applySmartCameraCrop(crop, cW, cH, scope),
      W,
      H,
      "contain",
    );
  }

  function drawDisplaySource(ctx, video, W, H) {
    if (!video.videoWidth) return false;
    return drawFittedSource(
      ctx,
      video,
      { sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight },
      W,
      H,
      "cover",
    );
  }

  function drawRecordingBackground(ctx, W, H) {
    var color = bgInput.value || "#f4f1ea";
    var style = bgStyleSel && bgStyleSel.value ? bgStyleSel.value : "warm-gradient";
    if (style === "solid") {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (style === "dark") {
      var dark = ctx.createLinearGradient(0, 0, W, H);
      dark.addColorStop(0, "#111827");
      dark.addColorStop(0.55, "#1f2937");
      dark.addColorStop(1, "#312e81");
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(129, 140, 248, 0.16)";
      ctx.beginPath();
      ctx.arc(W * 0.18, H * 0.16, Math.min(W, H) * 0.28, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (style === "paper") {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(120, 113, 108, 0.045)";
      for (var y = 0; y < H; y += 24) ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
      for (var x = 0; x < W; x += 32) ctx.fillRect(x, 0, 1, H);
      return;
    }
    var warm = ctx.createLinearGradient(0, 0, W, H);
    warm.addColorStop(0, color);
    warm.addColorStop(0.48, "#f8fafc");
    warm.addColorStop(1, "#eef2ff");
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(99, 102, 241, 0.12)";
    ctx.beginPath();
    ctx.arc(W * 0.82, H * 0.18, Math.min(W, H) * 0.30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(20, 184, 166, 0.10)";
    ctx.beginPath();
    ctx.arc(W * 0.18, H * 0.86, Math.min(W, H) * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }

  function cameraRenderSource() {
    var processed = bubble.querySelector("canvas");
    if (processed && processed.width && processed.height) {
      return {
        source: processed,
        width: processed.width,
        height: processed.height,
        mirrored: false,
      };
    }
    var cam = state.camera;
    if (cam.video && cam.video.videoWidth) {
      return {
        source: cam.video,
        width: cam.video.videoWidth,
        height: cam.video.videoHeight,
        mirrored: cam.mirrored,
      };
    }
    return null;
  }

  function drawCompositedCursor(ctx, x, y) {
    var style = state.cursor.highlightStyle || "halo";
    var shape = state.cursor.pointerShape || "system";
    ctx.save();
    ctx.translate(x, y);
    if (style === "spotlight") {
      var glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
      glow.addColorStop(0, "rgba(255,255,255,0.48)");
      glow.addColorStop(0.38, "rgba(105,101,219,0.24)");
      glow.addColorStop(1, "rgba(105,101,219,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "ring") {
      ctx.strokeStyle = "rgba(105,101,219,0.88)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 17, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.72)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.stroke();
    } else if (style === "dot") {
      ctx.fillStyle = "rgba(105,101,219,0.88)";
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.94)";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(105,101,219,0.22)";
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(105,101,219,0.76)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (shape === "dot") {
      ctx.fillStyle = "rgba(15,23,42,0.84)";
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (shape === "crosshair") {
      ctx.strokeStyle = "rgba(15,23,42,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(12, 0);
      ctx.moveTo(0, -12);
      ctx.lineTo(0, 12);
      ctx.stroke();
    } else if (shape !== "none") {
      ctx.fillStyle = "rgba(255,255,255,0.97)";
      ctx.strokeStyle = "rgba(15,23,42,0.36)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(17, 9);
      ctx.lineTo(10, 12);
      ctx.lineTo(15, 24);
      ctx.lineTo(10, 26);
      ctx.lineTo(5, 14);
      ctx.lineTo(0, 19);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function composeDrawLoop() {
    var video = state.rec.composeVideo;
    var ctx = state.rec.composeCtx;
    var cv = state.rec.composeCanvas;
    var scope = scopeSel.value;
    var needsVideo = scope !== "canvas" && scope !== "frame";
    if (!ctx || !cv) return;
    if (needsVideo && !video) return;
    var W = cv.width;
    var H = cv.height;
    drawRecordingBackground(ctx, W, H);
    if (scopeSel.value === "canvas" || scopeSel.value === "frame") {
      if (!drawWhiteboardSource(ctx, W, H, video)) {
        /* fallback: show placeholder if canvas content not available */
        ctx.fillStyle = "#888";
        ctx.font = "24px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("白板内容不可用", W / 2, H / 2);
      }
    } else {
      drawDisplaySource(ctx, video, W, H);
    }
    var cam = state.camera;
    if (composeChk.checked && cam.enabled && cam.stream) {
      var camSrc = cameraRenderSource();
      if (!camSrc) {
        state.rec.composeRaf = requestAnimationFrame(composeDrawLoop);
        return;
      }
      var placement = cameraCompositePlacement(W, H);
      var radius = placement.radius;
      var cx = placement.x;
      var cy = placement.y;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 18;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius - 3, 0, Math.PI * 2);
      ctx.clip();
      var src = camSrc.source;
      var sw = camSrc.width;
      var sh = camSrc.height;
      var inner = radius - 3;
      var ss = Math.max((inner * 2) / sw, (inner * 2) / sh);
      var sx = (sw - (inner * 2) / ss) / 2;
      var sy = (sh - (inner * 2) / ss) / 2;
      if (camSrc.mirrored) {
        ctx.translate(cx, cy);
        ctx.scale(-1, 1);
        ctx.drawImage(
          src,
          sx,
          sy,
          (inner * 2) / ss,
          (inner * 2) / ss,
          -inner,
          -inner,
          inner * 2,
          inner * 2,
        );
      } else {
        ctx.drawImage(
          src,
          sx,
          sy,
          (inner * 2) / ss,
          (inner * 2) / ss,
          cx - inner,
          cy - inner,
          inner * 2,
          inner * 2,
        );
      }
      ctx.restore();
    }
    if (cursorHighlightChk.checked && state.rec.active) {
      var cx0 = state.cursor.x;
      var cy0 = state.cursor.y;
      var canvasRect2 = sceneCanvasRect();
      if (canvasRect2) {
        var scope2 = scopeSel.value;
        var needsVid2 = scope2 !== "canvas" && scope2 !== "frame";
        if (needsVid2 && (!video || !video.videoWidth)) {
          state.rec.composeRaf = requestAnimationFrame(composeDrawLoop);
          return;
        }
        var vidW = (needsVid2 && video ? video.videoWidth : W) || 1;
        var vidH = (needsVid2 && video ? video.videoHeight : H) || 1;
        var srcX, srcY, srcW, srcH;
        if (scope2 === "canvas" || scope2 === "frame") {
          srcX = 0; srcY = 0; srcW = W; srcH = H;
        } else {
          srcX = 0; srcY = 0; srcW = vidW; srcH = vidH;
        }
        var drawX = (cx0 / (window.innerWidth || 1)) * W;
        var drawY = (cy0 / (window.innerHeight || 1)) * H;
        if (scope2 === "canvas" || scope2 === "frame") {
          var sourceCanvas = sceneCanvas();
          var sourceW = sourceCanvas && sourceCanvas.width ? sourceCanvas.width : W;
          var sourceH = sourceCanvas && sourceCanvas.height ? sourceCanvas.height : H;
          var renderedCrop = state.smartCamera.renderedCrop;
          if (state.smartCamera.enabled && renderedCrop && sourceCanvas) {
            var sourceX = (cx0 - canvasRect2.left) / canvasRect2.width * sourceW;
            var sourceY = (cy0 - canvasRect2.top) / canvasRect2.height * sourceH;
            var containScale = Math.min(W / renderedCrop.sw, H / renderedCrop.sh);
            var renderedW = renderedCrop.sw * containScale;
            var renderedH = renderedCrop.sh * containScale;
            drawX = (sourceX - renderedCrop.sx) * containScale + (W - renderedW) / 2;
            drawY = (sourceY - renderedCrop.sy) * containScale + (H - renderedH) / 2;
          } else {
            drawX = (cx0 - canvasRect2.left) / canvasRect2.width * W;
            drawY = (cy0 - canvasRect2.top) / canvasRect2.height * H;
          }
        } else {
          drawX = cx0 / (window.innerWidth || 1) * W;
          drawY = cy0 / (window.innerHeight || 1) * H;
        }
        drawCompositedCursor(ctx, drawX, drawY);
      }
    }
    state.rec.composeRaf = requestAnimationFrame(composeDrawLoop);
  }

  function requestMicAccess(callback) {
    var audioConstraint = state.mic.deviceId
      ? { deviceId: { exact: state.mic.deviceId } }
      : true;
    navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false })
      .then(function (micStream) {
        state.mic.stream = micStream;
        try {
          var ac = new (window.AudioContext || window.webkitAudioContext)();
          var src = ac.createMediaStreamSource(micStream);
          var analyser = ac.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          state.mic.audioContext = ac;
          state.mic.analyser = analyser;
          state.mic.dataArray = new Uint8Array(analyser.frequencyBinCount);
        } catch (e) {}
        listMicrophones();
        if (callback) callback();
      })
      .catch(function () {
        if (callback) callback();
      });
  }

  function updateMicLevel() {
    if (!state.mic.analyser || !state.mic.dataArray) return;
    state.mic.analyser.getByteFrequencyData(state.mic.dataArray);
    var sum = 0;
    for (var i = 0; i < state.mic.dataArray.length; i++) sum += state.mic.dataArray[i];
    state.mic.level = sum / state.mic.dataArray.length / 255;
    var micBar = shadow.getElementById("ec-mic-bar");
    var micStatus = shadow.getElementById("ec-mic-status");
    if (micBar) micBar.style.width = Math.round(state.mic.level * 100) + "%";
    if (micStatus) {
      var muted = state.mic.level < 0.02;
      state.mic.muted = muted;
      micStatus.textContent = muted ? "🔇" : "🎤";
      micStatus.style.color = muted ? "#e74c3c" : "#27ae60";
    }
    micIndicator.style.display = (state.rec.active && state.mic.muted) ? "flex" : "none";
  }

  function startMicPolling() {
    if (state.mic.timer) return;
    state.mic.timer = setInterval(updateMicLevel, 150);
    updateMicLevel();
  }

  function stopMicPolling() {
    if (state.mic.timer) { clearInterval(state.mic.timer); state.mic.timer = null; }
    micIndicator.style.display = "none";
  }

  function doCountdown(callback) {
    state.countdown.active = true;
    state.countdown.value = 3;
    /* Auto-hide panel during countdown so it doesn't appear in the recording */
    panel.classList.remove("ec-open");
    launcher.classList.remove("ec-panel-open");
    countdownEl.style.display = "flex";
    countdownEl.textContent = "3";
    function tick() {
      if (state.countdown.value <= 0) {
        state.countdown.active = false;
        countdownEl.style.display = "none";
        if (callback) callback();
        return;
      }
      countdownEl.textContent = String(state.countdown.value);
      countdownEl.classList.remove("ec-countdown-pop");
      void countdownEl.offsetWidth;
      countdownEl.classList.add("ec-countdown-pop");
      state.countdown.value--;
      setTimeout(tick, 900);
    }
    tick();
  }

  function startBrowserRecording() {
    resetCompletedRecordingState();
    requestMicAccess(function () {
      doCountdown(function () {
        _startRecordingInner();
      });
    });
  }

  function startNativeRecording() {
    var bridge = nativeBridge();
    if (!bridge) {
      startBrowserRecording();
      return;
    }
    var source = nativeSourceSel.value || "display:";
    var separator = source.indexOf(":");
    var sourceType = separator >= 0 ? source.slice(0, separator) : "display";
    var sourceId = separator >= 0 ? source.slice(separator + 1) : "";
    var compositeCenter = cameraCompositeCenter();
    var cameraRequested = camEnable.checked || state.camera.enabled;
    var nativeCameraComposite = cameraRequested && composeChk.checked;

    resetCompletedRecordingState();
    state.rec.restoreCameraAfterNative = cameraRequested;
    if (nativeCameraComposite && state.camera.enabled) stopCamera();
    state.rec.nativeRecordingReady = false;
    state.rec.nativeOutputPath = "";
    state.rec.seconds = 0;
    state.rec.paused = false;
    updateRecordingTimers();
    nativeStatusEl.textContent = "正在启动桌面录制…";

    bridge.start({
      sourceType: sourceType,
      sourceId: sourceId,
      sessionId: state.rec.sessionId,
      cameraEnabled: nativeCameraComposite,
      microphoneEnabled: true,
      cameraX: compositeCenter.x,
      cameraY: compositeCenter.y,
      cameraSize: cameraDiameterRatio(),
      cameraMirrored: state.camera.mirrored,
      smoothing: beautyToggle.checked ? state.camera.smoothing : 0,
      whitening: beautyToggle.checked ? state.camera.whitening : 0,
      lightIntensity: lightToggle.checked ? state.camera.lightIntensity : 0,
    })
      .then(function (response) {
        state.rec.nativeActive = true;
        state.rec.active = true;
        v011BeginSession();
        state.rec.nativeOutputPath = response.outputPath || "";
        state.rec.selectedDisplaySurface = "native-" + sourceType;
        state.rec.usingDirectDisplay = true;
        state.rec.timer = setInterval(tickTimer, 1000);
        if (state.tele.hideWhileRecording && state.tele.open) {
          tele.style.visibility = "hidden";
        }
        setRecUI(true, false);
        nativeStatusEl.textContent = "桌面录制中 · 浏览器可最小化";
        toast(nativeCameraComposite
          ? "桌面录制已开始，摄像头会合成进 MP4"
          : "桌面录制已开始，摄像头只作为屏幕气泡显示");
      })
      .catch(function (error) {
        state.rec.nativeActive = false;
        state.rec.active = false;
        setRecUI(false, false);
        nativeStatusEl.textContent = "启动失败 · 可使用浏览器回退";
        if (state.rec.restoreCameraAfterNative && camEnable.checked) {
          startCamera({ silentSuccess: true, silentError: true });
        }
        toast("桌面录制启动失败：" + (error.message || error));
      });
  }

  function startRecording() {
    if (state.countdown.active || state.rec.active) return;
    if (!selectedProjectFolderAvailable()) {
      setPanelOpen(true);
      updateV011ProjectStatus("开始录制前请先设置项目文件夹；本次录制及附带内容都会保存到该目录。");
      toast("请先设置项目文件夹，再开始录制");
      return;
    }
    if (scopeSel.value !== "screen") {
      startBrowserRecording();
      return;
    }
    refreshNativeEngine(true).then(function (available) {
      if (!available) {
        toast("桌面录制服务未连接，改用浏览器共享录制");
        startBrowserRecording();
        return;
      }
      loadNativeSources().then(function (loaded) {
        if (!loaded) {
          toast("录制来源不可用，改用浏览器共享录制");
          startBrowserRecording();
          return;
        }
        chooseNativeSource().then(function (confirmed) {
          if (!confirmed) {
            nativeStatusEl.textContent = "已取消录制来源选择";
            toast("已取消录制");
            return;
          }
          if (nativeSourceSel.value === "browser-picker:") {
            toast("请选择要录制的浏览器标签页、窗口或屏幕");
            startBrowserRecording();
            return;
          }
          doCountdown(startNativeRecording);
        });
      });
    });
  }

  function _startRecordingInner() {
    var scope = scopeSel.value;
    var canvasOrFrame = scope === "canvas" || scope === "frame";

    if (scope === "frame" && !activeFrameElement()) {
      toast("当前白板还没有幻灯片，将改为录制白板全景");
    }

    /* --- canvas / frame: no screen-share dialog needed --- */
    if (canvasOrFrame) {
      state.rec.chunks = [];
      state.rec.seconds = 0;
      state.rec.paused = false;

      var r = recordingSize();
      var cv = document.createElement("canvas");
      cv.width = r[0];
      cv.height = r[1];
      var ctx = cv.getContext("2d");
      state.rec.composeCanvas = cv;
      state.rec.composeCtx = ctx;
      state.rec.composeVideo = null;          /* not needed for canvas/frame */
      state.rec.displayStream = null;         /* no display stream */
      state.rec.selectedDisplaySurface = scope;
      state.rec.usingDirectDisplay = false;

      var vTrack = cv.captureStream(30).getVideoTracks()[0];
      var inputAudioTracks = [];
      if (state.mic.stream) {
        var micTracks = state.mic.stream.getAudioTracks();
        for (var mi = 0; mi < micTracks.length; mi++) inputAudioTracks.push(micTracks[mi]);
      }
      var tracks = [vTrack].concat(mixedBrowserAudioTracks(inputAudioTracks));
      var outputStream = new MediaStream(tracks);

      state.rec.composeRaf = requestAnimationFrame(composeDrawLoop);
      if (hideBubbleChk.checked && state.camera.enabled) {
        bubble.style.visibility = "hidden";
      }
      if (state.tele.hideWhileRecording && state.tele.open) {
        tele.style.visibility = "hidden";
      }

      var mime = pickMimeType();
      var options = { mimeType: mime, videoBitsPerSecond: 8000000 };
      if (mime.indexOf("mp4") === -1) {
        if (formatSel.value === "video/mp4") {
          toast("当前浏览器不支持 MP4 录制，已降级为 WebM");
        }
      }
      var recorder;
      try { recorder = new MediaRecorder(outputStream, options); }
      catch (e) { recorder = new MediaRecorder(outputStream); }
      recorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size > 0) state.rec.chunks.push(ev.data);
      };
      recorder.onstop = function () {
        var ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";
        state.rec.lastBlob = new Blob(state.rec.chunks, { type: mime.split(";")[0] });
        markBrowserRecordingComplete(ext, mime.split(";")[0]);
        v011EndSession();
        state.rec.chunks = [];
        if (state.rec.timer) clearInterval(state.rec.timer);
        state.rec.timer = null;
        state.rec.active = false;
        stopComposeLoop();
        setRecUI(false, false);
        updateRecordingTimers();
        bubble.style.visibility = "visible";
        tele.style.visibility = "visible";
        updateV011ProjectStatus("原始录制已就绪；可保存录制或播放原始录制。");
        updateOutputActions();
        toast("原始录制已就绪（" + ext.toUpperCase() + "），可保存录制或播放");
      };
      recorder.start(1000);
      state.rec.recorder = recorder;
      state.rec.active = true;
      v011BeginSession();
      state.rec.startTime = Date.now();
      state.rec.timer = setInterval(tickTimer, 1000);
      setRecUI(true, false);
      startMicPolling();
      if (cursorHighlightChk.checked) cursorHighlight.style.display = "block";
      toast("正在录制…");
      return;                                  /* skip getDisplayMedia entirely */
    }

    /* --- screen scope: original flow with getDisplayMedia --- */
    var constraints = {
      video: {
        frameRate: { ideal: 30 },
        displaySurface: "monitor",
      },
      audio: true,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "include",
      systemAudio: "include",
    };
    navigator.mediaDevices
      .getDisplayMedia(constraints)
      .then(function (displayStream) {
        var displayTrack = displayStream.getVideoTracks()[0];
        var displaySettings = displayTrack && displayTrack.getSettings
          ? displayTrack.getSettings()
          : {};
        var displaySurface = displaySettings.displaySurface || "unknown";
        state.rec.displayStream = displayStream;
        state.rec.chunks = [];
        state.rec.seconds = 0;
        state.rec.paused = false;

        var directVideoTracks = displayStream.getVideoTracks().slice();
        var directAudioTracks = displayStream.getAudioTracks().slice();
        if (state.mic.stream) {
          state.mic.stream.getAudioTracks().forEach(function (track) {
            if (!directAudioTracks.some(function (item) { return item.id === track.id; })) {
              directAudioTracks.push(track);
            }
          });
        }
        var outputStream = new MediaStream(directVideoTracks.concat(mixedBrowserAudioTracks(directAudioTracks)));
        var isDesktopSurface =
          displaySurface === "monitor" || displaySurface === "window";
        var useComposedOutput = composeChk.checked && !isDesktopSurface;
        state.rec.selectedDisplaySurface = displaySurface;
        state.rec.usingDirectDisplay = !useComposedOutput;

        if (displaySurface === "browser") {
          toast("当前采集源是浏览器标签页；录制桌面请在共享窗口中选择「整个屏幕」");
        } else if (displaySurface === "monitor") {
          toast("已连接整个屏幕，切换到其他应用后仍会持续录制");
        } else if (displaySurface === "window") {
          toast("已连接所选窗口；只有该窗口会被录制");
        }

        if (composeChk.checked && isDesktopSurface) {
          toast("为保证离开或最小化浏览器后持续录制，桌面/窗口模式使用原始采集流");
        }

        if (displayTrack) {
          displayTrack.addEventListener("ended", function () {
            if (state.rec.active) stopRecording();
          }, { once: true });
        }
        if (useComposedOutput) {
          var r = recordingSize();
          var cv = document.createElement("canvas");
          cv.width = r[0];
          cv.height = r[1];
          var ctx = cv.getContext("2d");
          var video = document.createElement("video");
          video.autoplay = true;
          video.playsInline = true;
          video.muted = true;
          video.srcObject = displayStream;
          state.rec.composeCanvas = cv;
          state.rec.composeCtx = ctx;
          state.rec.composeVideo = video;
          var vTrack = cv.captureStream(30).getVideoTracks()[0];
          var audioTracks = displayStream.getAudioTracks().slice();
          if (state.mic.stream) {
            state.mic.stream.getAudioTracks().forEach(function (track) {
              if (!audioTracks.some(function (item) { return item.id === track.id; })) {
                audioTracks.push(track);
              }
            });
          }
          var tracks = [vTrack].concat(mixedBrowserAudioTracks(audioTracks));
          outputStream = new MediaStream(tracks);
          state.rec.composeRaf = requestAnimationFrame(composeDrawLoop);
          if (hideBubbleChk.checked && state.camera.enabled) {
            bubble.style.visibility = "hidden";
          }
        } else if (hideBubbleChk.checked && state.camera.enabled) {
          bubble.style.visibility = "hidden";
        }
        if (state.tele.hideWhileRecording && state.tele.open) {
          tele.style.visibility = "hidden";
        }

        var mime = pickMimeType();
        var options = { mimeType: mime, videoBitsPerSecond: 8000000 };
        if (mime.indexOf("mp4") === -1) {
          options.audioBitsPerSecond = 128000;
          if (formatSel.value === "video/mp4") {
            toast("当前浏览器不支持 MP4 录制，已降级为 WebM");
          }
        }
        var recorder;
        try {
          recorder = new MediaRecorder(outputStream, options);
        } catch (e) {
          recorder = new MediaRecorder(outputStream);
        }
        recorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size > 0) {
            state.rec.chunks.push(ev.data);
          }
        };
        recorder.onstop = function () {
          var ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";
          state.rec.lastBlob = new Blob(state.rec.chunks, {
            type: mime.split(";")[0],
          });
          markBrowserRecordingComplete(ext, mime.split(";")[0]);
          v011EndSession();
          if (state.rec.timer) clearInterval(state.rec.timer);
          state.rec.timer = null;
          state.rec.active = false;
          setRecUI(false, false);
          updateRecordingTimers();
          stopComposeLoop();
          bubble.style.visibility = "visible";
          tele.style.visibility = "visible";
          updateV011ProjectStatus("原始录制已就绪；可保存录制或播放原始录制。");
          updateOutputActions();
          toast("原始录制已就绪（" + ext.toUpperCase() + "），可保存录制或播放");
        };
        recorder.start(1000);
        state.rec.recorder = recorder;
        state.rec.active = true;
        v011BeginSession();
        state.rec.timer = setInterval(tickTimer, 1000);
        setRecUI(true, false);
        startMicPolling();
        if (cursorHighlightChk.checked) cursorHighlight.style.display = "block";
        toast("正在录制…");
      })
      .catch(function (err) {
        toast("无法开始录制：" + (err && err.message ? err.message : err));
      });
  }

  function pauseRecording() {
    if (state.rec.nativeActive) {
      var bridge = nativeBridge();
      if (!bridge) return;
      var action = state.rec.paused ? bridge.resume() : bridge.pause();
      action
        .then(function () {
          state.rec.paused = !state.rec.paused;
          v011PauseSession(state.rec.paused);
          setRecUI(true, state.rec.paused);
          nativeStatusEl.textContent = state.rec.paused
            ? "桌面录制已暂停"
            : "桌面录制中 · 浏览器可最小化";
        })
        .catch(function (error) {
          toast("桌面录制控制失败：" + (error.message || error));
        });
      return;
    }
    if (!state.rec.recorder) return;
    if (state.rec.paused) {
      state.rec.recorder.resume();
      state.rec.paused = false;
    } else {
      state.rec.recorder.pause();
      state.rec.paused = true;
    }
    v011PauseSession(state.rec.paused);
    setRecUI(true, state.rec.paused);
  }

  function recoverNativeStopFailure(error) {
    var bridge = nativeBridge();
    var message = error && error.message ? error.message : String(error || "");
    if (!bridge) {
      recStop.disabled = false;
      nativeStatusEl.textContent = "停止失败 · 桌面录制服务未连接";
      toast("无法停止桌面录制：" + message);
      return;
    }
    bridge.health(true)
      .then(function () { return bridge.status(); })
      .then(function (status) {
        var backendState = status && status.state ? status.state : "unknown";
        var stillRecording =
          backendState === "recording" ||
          backendState === "paused" ||
          backendState === "stopping";
        if (stillRecording) {
          recStop.disabled = false;
          nativeStatusEl.textContent = "停止失败 · 后台仍在录制";
          toast("无法停止桌面录制：" + message);
          return;
        }
        if (state.rec.timer) clearInterval(state.rec.timer);
        state.rec.timer = null;
        v011EndSession();
        state.rec.nativeActive = false;
        state.rec.active = false;
        state.rec.paused = false;
        state.rec.nativeRecordingReady = !!(status && status.outputPath);
        state.rec.nativeOutputPath = (status && status.outputPath) || state.rec.nativeOutputPath || "";
        if (state.rec.nativeRecordingReady) {
          finalizeSavedRecording(state.rec.nativeOutputPath, state.rec.nativeOutputPath.split("/").pop(), "video/mp4", state.rec.seconds)
            .catch(function (metadataError) { toast("会话元数据未保存：" + (metadataError.message || metadataError)); });
        }
        setRecUI(false, false);
        tele.style.visibility = "visible";
        nativeStatusEl.textContent = state.rec.nativeRecordingReady
          ? "原始录制已停止 · 已保存 MP4"
          : "当前没有桌面录制 · 已重置";
        toast(state.rec.nativeRecordingReady
          ? "原始录制已停止，已保存到项目文件夹"
          : "当前没有桌面录制，已重置录制状态");
        if (state.rec.restoreCameraAfterNative && camEnable.checked) {
          startCamera({ silentSuccess: true, silentError: true });
        }
      })
      .catch(function (statusError) {
        recStop.disabled = false;
        nativeStatusEl.textContent = "停止失败 · 后台状态未知";
        toast("无法停止桌面录制：" + (statusError.message || message || statusError));
      });
  }

  function stopRecording() {
    if (state.rec.nativeActive) {
      var bridge = nativeBridge();
      if (!bridge) return;
      nativeStatusEl.textContent = "正在完成 MP4…";
      recStop.disabled = true;
      bridge.stop()
        .then(function (response) {
          if (state.rec.timer) clearInterval(state.rec.timer);
          state.rec.timer = null;
          v011EndSession();
          state.rec.nativeActive = false;
          state.rec.active = false;
          state.rec.paused = false;
          state.rec.nativeOutputPath = response && response.outputPath || state.rec.nativeOutputPath || "";
          state.rec.nativeRecordingReady = !!state.rec.nativeOutputPath;
          if (state.rec.nativeRecordingReady) {
            finalizeSavedRecording(state.rec.nativeOutputPath, state.rec.nativeOutputPath.split("/").pop(), "video/mp4", state.rec.seconds)
              .catch(function (metadataError) { toast("会话元数据未保存：" + (metadataError.message || metadataError)); });
          }
          setRecUI(false, false);
          tele.style.visibility = "visible";
          nativeStatusEl.textContent = state.rec.nativeRecordingReady
            ? "原始录制已就绪 · 已保存 MP4"
            : "原始录制未就绪 · 未找到输出文件";
          toast(state.rec.nativeRecordingReady
            ? "原始录制已保存到项目文件夹的 recordings 文件夹"
            : "录制已停止，但输出文件尚未就绪");
          refreshProjectFolderStatus();
          if (state.rec.restoreCameraAfterNative && camEnable.checked) {
            startCamera({ silentSuccess: true, silentError: true });
          }
        })
        .catch(function (error) {
          recoverNativeStopFailure(error);
        });
      return;
    }
    if (state.rec.recorder && state.rec.recorder.state !== "inactive") {
      state.rec.recorder.stop();
    }
    state.rec.active = false;
  }

  function exportRecording() {
    if (state.rec.nativeRecordingReady) {
      var bridge = nativeBridge();
      if (!bridge) {
        toast("桌面录制服务未连接；原始录制仍保存在项目文件夹的 recordings 文件夹");
        return;
      }
      recExport.disabled = true;
      var openFolder = bridge.openProjectFolder || bridge.openSaveFolder;
      var openFolderRequest = openFolder
        ? openFolder()
        : Promise.reject(new Error("桌面录制服务不支持打开保存位置"));
      openFolderRequest
        .then(function (folder) {
          setNativeProjectFolder(folder);
          updateProjectFolderStatus();
          recExport.disabled = false;
          toast("原始录制已保存，已打开保存位置");
        })
        .catch(function (error) {
          recExport.disabled = false;
          toast("打开保存位置失败：" + (error.message || error));
        });
      return;
    }
    if (!state.rec.lastBlob) {
      toast("还没有可保存的原始录制，先录制一段");
      return;
    }
    var fileName = outputFileName(state.rec.lastExt);
    if (state.rec.nativeAvailable) {
      recExport.disabled = true;
      saveBlobViaNative(state.rec.lastBlob, fileName)
        .then(function (saved) {
          recExport.disabled = false;
          if (saved) {
            refreshProjectFolderStatus();
            toast((saved.overwritten ? "已有保存，已覆盖：" : "原始录制已保存：") + shortPath(saved.path || saved.fileName || fileName));
            return;
          }
          toast("桌面录制服务暂不可用，改用浏览器保存");
          if (state.rec.projectFolder.handle) return saveBlobToBrowserFolder(state.rec.lastBlob, fileName);
          throw new Error("未选择项目文件夹");
        })
        .then(function (saved) {
          if (!saved || saved.path) return;
          toast((saved.overwritten ? "已有保存，已覆盖：" : "原始录制已保存到：") + projectFolderLabel());
        })
        .catch(function (error) {
          recExport.disabled = false;
      toast("原始录制未保存：" + (error.message || error));
        });
      return;
    }
    if (state.rec.projectFolder.handle) {
      recExport.disabled = true;
      saveBlobToBrowserFolder(state.rec.lastBlob, fileName)
        .then(function (saved) {
          recExport.disabled = false;
          if (saved) {
            toast((saved.overwritten ? "已有保存，已覆盖：" : "原始录制已保存到：") + projectFolderLabel());
          }
        })
        .catch(function (error) {
          recExport.disabled = false;
          toast("原始录制未保存：" + (error.message || error));
        });
      return;
    }
    toast("请先设置项目文件夹，再保存录制");
  }

  function openRecording() {
    if (state.rec.nativeRecordingReady) {
      var bridge = nativeBridge();
      if (!bridge) {
        toast("桌面录制服务未连接，无法直接播放原始录制");
        return;
      }
      recOpen.disabled = true;
      var openFile = bridge.openLastRecording
        ? bridge.openLastRecording()
        : Promise.reject(new Error("桌面录制服务不支持直接播放原始录制"));
      openFile
        .then(function () {
          recOpen.disabled = false;
          toast("已播放最后的 MP4 原始录制");
        })
        .catch(function (error) {
          recOpen.disabled = false;
          toast("播放原始录制失败：" + (error.message || error));
        });
      return;
    }
    if (!state.rec.lastBlob) {
      toast("还没有可播放的原始录制，先录制一段");
      return;
    }
    var bridge = nativeBridge();
    if (bridge && state.rec.nativeAvailable && bridge.openLastRecording) {
      var fileName = outputFileName(state.rec.lastExt);
      recOpen.disabled = true;
      var ensureSaved = state.rec.lastSavedViaNative && state.rec.lastSavedPath
        ? Promise.resolve({ ok: true, path: state.rec.lastSavedPath, overwritten: true })
        : saveBlobViaNative(state.rec.lastBlob, fileName);
      ensureSaved
        .then(function () {
          return bridge.openLastRecording();
        })
        .then(function () {
          recOpen.disabled = false;
          toast("已用默认播放器播放原始录制");
        })
        .catch(function (error) {
          recOpen.disabled = false;
          toast("默认播放器播放失败，改用浏览器播放：" + (error.message || error));
          openRecordingPreview();
        });
      return;
    }
    openRecordingPreview();
  }

  function openRecordingPreview() {
    if (state.rec.lastPreviewUrl) {
      URL.revokeObjectURL(state.rec.lastPreviewUrl);
      state.rec.lastPreviewUrl = "";
    }
    state.rec.lastPreviewUrl = URL.createObjectURL(state.rec.lastBlob);
    var opened = window.open(state.rec.lastPreviewUrl, "_blank", "noopener");
    if (!opened) {
      toast("浏览器阻止了新窗口，请允许弹窗或先点击「保存录制」");
      return;
    }
    toast("桌面录制服务未连接，已用浏览器播放原始录制");
  }

  recStart.addEventListener("click", startRecording);
  recPause.addEventListener("click", pauseRecording);
  recStop.addEventListener("click", stopRecording);
  if (miniStart) miniStart.addEventListener("click", startRecording);
  if (miniPause) miniPause.addEventListener("click", pauseRecording);
  if (miniStop) miniStop.addEventListener("click", stopRecording);
  recExport.addEventListener("click", exportRecording);
  recOpen.addEventListener("click", openRecording);

  /* ============ Teleprompter ============ */
  var teleToggle = shadow.getElementById("ec-tele-toggle");
  var teleHide = shadow.getElementById("ec-tele-hide");
  var teleText = tele.querySelector(".ec-tele-text");
  var teleSpeed = tele.querySelector(".ec-tele-speed");
  var teleFs = tele.querySelector(".ec-tele-fs");
  var teleOpacity = tele.querySelector(".ec-tele-opacity");
  var teleScrollBtn = tele.querySelector(".ec-tele-scroll");
  var teleClose = tele.querySelector(".ec-tele-close");
  var teleResize = tele.querySelector(".ec-tele-resize");
  var teleSaveScript = tele.querySelector('[data-action="save-script"]');
  var teleLoadScript = tele.querySelector('[data-action="load-script"]');
  teleText.value = state.tele.text || "";
  var projectWhiteboardOpenBtn = shadow.getElementById("ec-project-whiteboard-open");
  var projectWhiteboardSaveBtn = shadow.getElementById("ec-project-whiteboard-save");
  var projectFolderChooseBtn = shadow.getElementById("ec-project-folder-choose");
  var projectFolderOpenBtn = shadow.getElementById("ec-project-folder-open");
  var projectFileOpenBtn = shadow.getElementById("ec-project-file-open");
  var projectFileInput = shadow.getElementById("ec-project-file-input");
  var projectStatus = shadow.getElementById("ec-project-status");
  var scriptImportBtn = shadow.getElementById("ec-script-import");
  var scriptImportFileInput = shadow.getElementById("ec-script-import-file");
  var scriptStatus = shadow.getElementById("ec-script-status");

  function updateV011ProjectStatus(message) {
    if (projectStatus) projectStatus.textContent = message;
  }

  function updateScriptStatus(message) {
    if (scriptStatus) scriptStatus.textContent = message || "讲稿在提词器面板内载入或编辑；录后的逐字稿和字幕仍以实际音频为准。";
  }

  function applyLoadedV011Project() {
    teleText.value = state.tele.text || "";
    restoreV011RecordingSettings();
    if (bgInput) bgInput.value = state.settings.background || "#f4f1ea";
    if (bgStyleSel) bgStyleSel.value = state.settings.backgroundStyle || "warm-gradient";
    if (micDeviceSel) micDeviceSel.value = state.mic.deviceId || "";
    if (screenLightToggle) screenLightToggle.checked = !!state.camera.screenLightEnabled;
    if (screenLightIntensity) screenLightIntensity.value = String(Number.isFinite(Number(state.camera.screenLightIntensity)) ? state.camera.screenLightIntensity : 0.55);
    updateScreenLight();
    updateCursorSettingsUI();
    smartCameraChk.checked = !!state.smartCamera.enabled;
    if (smartSlideFocusChk) smartSlideFocusChk.checked = state.smartCamera.slideFocus !== false;
    if (smartMouseFocusChk) smartMouseFocusChk.checked = state.smartCamera.mouseFocus !== false;
    if (smartClickFocusChk) smartClickFocusChk.checked = state.smartCamera.clickFocus !== false;
    smartCameraStrength.value = state.smartCamera.strength || "gentle";
    smartCameraSpeed.value = state.smartCamera.speed || "standard";
    updateSmartCameraUI();
    updateV011ProjectStatus("已载入项目 " + state.v011.projectId + "；录制媒体按项目内相对路径关联。");
  }

  function selectedProjectFolderAvailable() {
    return state.rec.projectFolder.mode === "native" || !!state.rec.projectFolder.handle;
  }

  function setProjectActionBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.idleText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.idleText || button.textContent;
    button.disabled = false;
    delete button.dataset.idleText;
  }

  projectWhiteboardSaveBtn.addEventListener("click", function () {
    if (!selectedProjectFolderAvailable()) {
      toast("请先设置项目文件夹");
      updateV011ProjectStatus("保存白板失败：尚未设置项目文件夹。");
      return;
    }
    var project = v011SaveProject("manual");
    if (!project) { toast("白板项目缓存保存失败"); return; }
    setProjectActionBusy(projectWhiteboardSaveBtn, true, "保存中…");
    saveProjectAssets(project).then(function (scene) {
      state.rec.projectFolder.loadedOnce = true;
      var elementCount = scene && Array.isArray(scene.elements) ? scene.elements.length : 0;
      var fileCount = scene && isPlainObject(scene.files) ? Object.keys(scene.files).length : 0;
      updateV011ProjectStatus("已保存白板：" + elementCount + " 个元素、" + fileCount + " 个附件；项目内容已同步。");
      toast("白板及全部项目内容已保存");
    }).catch(function (error) {
      updateV011ProjectStatus("白板未写入项目文件夹：" + error.message);
      toast("保存白板失败：" + (error.message || error));
    }).finally(function () {
      setProjectActionBusy(projectWhiteboardSaveBtn, false);
    });
  });
  projectFolderChooseBtn.addEventListener("click", function () {
    if (state.rec.active || state.countdown.active) {
      toast("请先停止录制，再切换项目文件夹");
      return;
    }
    chooseProjectFolder().then(function (chosen) {
      if (!chosen) return false;
      state.rec.projectFolder.loadedOnce = false;
      state.rec.projectSceneFiles = {};
      v011BeginProjectAtNewRoot();
      resetCompletedRecordingState();
      applyLoadedV011Project();
      renderProjectFolderPath();
      updateV011ProjectStatus("项目文件夹已设置：" + projectFolderLabel() + "；当前白板和讲稿尚未写入，请点击“保存白板”。");
      toast("项目文件夹已设置；旧项目录制和编辑内容未带入");
      return true;
    });
  });
  if (projectWhiteboardOpenBtn) {
    projectWhiteboardOpenBtn.addEventListener("click", function () {
      if (state.rec.active || state.countdown.active) {
        toast("请先停止录制，再打开其他项目");
        return;
      }
      if (!window.confirm("读取项目文件夹可能替换当前画布。未保存的修改可能丢失，是否继续？")) {
        return;
      }
      setProjectActionBusy(projectWhiteboardOpenBtn, true, "打开中…");
      chooseProjectFolder().then(function (chosen) {
        if (!chosen) return false;
        state.rec.projectFolder.loadedOnce = false;
        state.rec.projectSceneFiles = {};
        /* Detach the previous project's relative assets before probing the new
         * folder. A valid manifest replaces this fresh context below; an empty or
         * incomplete folder can never inherit stale recording paths. */
        v011BeginProjectAtNewRoot();
        resetCompletedRecordingState();
        applyLoadedV011Project();
        renderProjectFolderPath();
        var loader = state.rec.projectFolder.mode === "native"
          ? loadProjectFromNativeFolder
          : loadProjectFromBrowserFolder;
        return loader({ initializeIfMissing: false, requireScene: true, explicitOpen: true });
      })
        .finally(function () { setProjectActionBusy(projectWhiteboardOpenBtn, false); });
    });
  }
  projectFolderOpenBtn.addEventListener("click", openProjectFolder);
  projectFileOpenBtn.addEventListener("click", function () {
    projectFileInput.value = "";
    projectFileInput.click();
  });
  projectFileInput.addEventListener("change", function () {
    var file = projectFileInput.files && projectFileInput.files[0];
    if (!file) return;
    if (file.size > 128 * 1024 * 1024) {
      updateV011ProjectStatus("单文件打开失败：文件超过 128 MB，当前画布未改变。");
      toast("Excalidraw 文件超过 128 MB，未打开");
      return;
    }
    var currentElements = readElementsSafe().filter(function (element) { return element && !element.isDeleted; });
    if (currentElements.length && !window.confirm("打开单个 Excalidraw 文件会替换当前画布。未保存的修改可能丢失，是否继续？")) {
      updateV011ProjectStatus("已取消打开单文件；项目文件夹和当前画布未改变。");
      return;
    }
    setProjectActionBusy(projectFileOpenBtn, true, "打开中…");
    file.text().then(parseProjectScene).then(function (scene) {
      applyLoadedProjectFiles(null, scene);
      state.rec.projectFolder.loadedOnce = false;
      updateV011ProjectStatus("已打开单个 Excalidraw 文件；项目文件夹保持不变。保存白板可写入当前项目。");
      toast("Excalidraw 文件已打开；项目文件夹未改变");
    }).catch(function (error) {
      updateV011ProjectStatus("单文件打开失败：" + (error.message || error) + "；当前画布未改变。");
      toast("打开 Excalidraw 文件失败：" + (error.message || error));
    }).finally(function () {
      setProjectActionBusy(projectFileOpenBtn, false);
    });
  });
  renderProjectFolderPath();

  function parseProjectManifest(text) {
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024) {
      throw new Error("项目清单为空或超过 8 MB");
    }
    var raw = JSON.parse(text);
    var core = requireEditorCore();
    if (!isPlainObject(raw)) throw new Error("项目清单不是有效对象");
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== PROJECT_FILE_SCHEMA) {
      throw new Error("不支持的项目版本：" + String(raw.schemaVersion == null ? "未知" : raw.schemaVersion));
    }
    var project = raw.schemaVersion === 1
      ? core.normalizeProject(core.migrateV1(raw))
      : core.normalizeProject(raw);
    if (project.schemaVersion !== PROJECT_FILE_SCHEMA) {
      throw new Error("项目清单未转换为 schema v2");
    }
    return project;
  }

  function parseProjectScene(text) {
    if (typeof text !== "string" || text.length > 128 * 1024 * 1024) {
      throw new Error("白板场景为空或超过 128 MB");
    }
    var scene = JSON.parse(text);
    if (!isPlainObject(scene) || !Array.isArray(scene.elements)) {
      throw new Error("scene.excalidraw 缺少有效的 elements");
    }
    if (scene.appState != null && !isPlainObject(scene.appState)) {
      throw new Error("scene.excalidraw 的 appState 无效");
    }
    if (scene.files != null && !isPlainObject(scene.files)) {
      throw new Error("scene.excalidraw 的 files 无效");
    }
    scene.appState = sanitizeProjectAppState(scene.appState);
    return scene;
  }

  function isMissingProjectAsset(error) {
    return !!(error && (error.name === "NotFoundError" || /not found|不存在/i.test(error.message || "")));
  }

  function applyLoadedProjectFiles(manifest, scene) {
    var api = null;
    var files = {};
    var fileEntries = [];
    if (scene) {
      api = getLiveExcalidrawAPI();
      if (!api || typeof api.updateScene !== "function") {
        throw new Error("白板尚未准备好，请稍后再试");
      }
      files = isPlainObject(scene.files) ? scene.files : {};
      fileEntries = Object.keys(files).map(function (fileId) { return files[fileId]; }).filter(function (file) {
        return isPlainObject(file) && typeof file.id === "string";
      });
      if (fileEntries.length && typeof api.addFiles !== "function") {
        throw new Error("当前白板不支持恢复图片附件，请刷新页面后重试");
      }
    }
    if (manifest) {
      var core = requireEditorCore();
      var normalizedManifest = core.normalizeProject(manifest);
      var legacyRuntime = core.projectV2ToLegacyRuntime(normalizedManifest);
      state.v011.projectV2 = normalizedManifest;
      localStorage.setItem(V011_PROJECT_KEY, JSON.stringify(v011NormalizeProject(legacyRuntime, true)));
      v011ApplyLegacyRuntime(legacyRuntime);
      applyLoadedV011Project();
    }
    if (scene) {
      if (fileEntries.length) api.addFiles(fileEntries);
      try { localStorage.setItem(ELEMENTS_KEY, JSON.stringify(scene.elements)); } catch (err) {}
      try {
        if (scene.appState) localStorage.setItem(APP_STATE_KEY, JSON.stringify(scene.appState));
      } catch (err) {}
      var update = { elements: scene.elements };
      if (scene.appState) update.appState = scene.appState;
      api.updateScene(update);
      state.rec.projectSceneFiles = files;
    }
  }

  function finishProjectFolderLoad(manifest, scene, options) {
    options = options || {};
    if (!manifest && !scene) {
      if (!options.initializeIfMissing) {
        state.rec.projectFolder.loadedOnce = true;
        updateV011ProjectStatus("项目文件夹中尚无可打开的白板；可点击“保存白板”创建完整项目。");
        if (!options.silent) toast("该项目文件夹中尚无白板");
        return Promise.resolve(false);
      }
      return saveProjectAssets(v011ProjectSnapshot()).then(function () {
        state.rec.projectFolder.loadedOnce = true;
        updateV011ProjectStatus("已在 " + projectFolderLabel() + " 创建项目");
        if (!options.silent) toast("已创建项目文件夹结构");
        return true;
      });
    }
    if (options.requireScene && !scene) {
      state.rec.projectFolder.loadedOnce = true;
      updateV011ProjectStatus("项目文件夹中没有 scene.excalidraw，当前画布未改变。");
      if (!options.silent) toast("未找到可打开的白板文件");
      return Promise.resolve(false);
    }
    applyLoadedProjectFiles(manifest, scene);
    state.rec.projectFolder.loadedOnce = true;
    if (!manifest || !scene) {
      if (!options.initializeIfMissing) {
        var partialMessage = scene
          ? "已打开白板及附件；项目清单缺失，点击“保存白板”即可补全。"
          : "已载入项目清单；白板文件缺失。";
        updateV011ProjectStatus(partialMessage);
        if (!options.silent) toast(scene ? "白板已打开，保存后可补全项目" : "项目清单已载入");
        return Promise.resolve(!!scene || !!manifest);
      }
      return saveProjectAssets(v011ProjectSnapshot()).then(function () {
        updateV011ProjectStatus("已载入并补全项目：" + projectFolderLabel());
        if (!options.silent) toast("已载入并补全项目文件夹");
        return true;
      });
    }
    var loadedFiles = scene && isPlainObject(scene.files) ? Object.keys(scene.files).length : 0;
    updateV011ProjectStatus("已打开白板：" + scene.elements.length + " 个元素、" + loadedFiles + " 个附件；项目内容已载入。");
    if (!options.silent) toast("白板及全部项目内容已打开");
    return Promise.resolve(true);
  }

  function loadProjectFromNativeFolder(options) {
    options = options || {};
    var bridge = nativeBridge();
    if (!bridge || !bridge.readProjectFile) return Promise.resolve(false);
    function readOptional(path, parser) {
      return bridge.readProjectFile(path)
        .then(function (response) {
          if (!response || response.found === false || typeof response.content !== "string") return null;
          return parser(response.content);
        })
        .catch(function (error) {
          if (isMissingProjectAsset(error)) return null;
          throw error;
        });
    }
    return Promise.all([
      readOptional("project.excalicord.json", parseProjectManifest),
      readOptional("scene.excalidraw", parseProjectScene),
    ]).then(function (files) {
      return finishProjectFolderLoad(files[0], files[1], options);
    }).catch(function (error) {
      updateV011ProjectStatus("项目载入失败：" + (error.message || error));
      if (!options.silent) toast("项目载入失败：" + (error.message || error));
      return false;
    });
  }

  function loadProjectFromBrowserFolder(options) {
    options = options || {};
    var root = state.rec.projectFolder.handle;
    if (!root) return Promise.resolve(false);
    function readOptional(path, parser, maxBytes) {
      return root.getFileHandle(path, { create: false })
        .then(function (handle) { return handle.getFile(); })
        .then(function (file) {
          if (file.size > maxBytes) throw new Error(path + " 超过允许大小");
          return file.text();
        })
        .then(parser)
        .catch(function (error) {
          if (isMissingProjectAsset(error)) return null;
          throw error;
        });
    }
    return Promise.all([
      readOptional("project.excalicord.json", parseProjectManifest, 8 * 1024 * 1024),
      readOptional("scene.excalidraw", parseProjectScene, 128 * 1024 * 1024),
    ]).then(function (files) {
      return finishProjectFolderLoad(files[0], files[1], options);
    }).catch(function (error) {
      updateV011ProjectStatus("项目载入失败：" + (error.message || error));
      if (!options.silent) toast("项目载入失败：" + (error.message || error));
      return false;
    });
  }
  function updateSubtitleStatus(message) {
    if (!scriptStatus) return;
    var segments = state.v011.text.subtitles && Array.isArray(state.v011.text.subtitles.segments)
      ? state.v011.text.subtitles.segments
      : [];
    scriptStatus.textContent = message || ("讲稿在提词器面板内载入或编辑；录后的逐字稿和字幕仍以实际音频为准。");
  }

  function exportSubtitleTrack() {
    var segments = state.v011.text.subtitles && Array.isArray(state.v011.text.subtitles.segments)
      ? state.v011.text.subtitles.segments
      : [];
    if (!segments.length) {
      toast("当前没有可导出的字幕");
      return;
    }
    var project = v011SaveProject("subtitle-save");
    if (!project) {
      toast("字幕缓存保存失败");
      return;
    }
    saveProjectAssets(project).then(function () {
      updateSubtitleStatus("已保存 " + segments.length + " 条字幕到 text/subtitles.srt。");
      toast("字幕已保存到项目文件夹");
    }).catch(function (error) {
      updateSubtitleStatus("字幕尚未写入项目文件夹：" + (error.message || error));
      toast("请先选择项目文件夹，再保存字幕");
    });
  }

  function scriptTextFromFile(file, rawText) {
    var name = (file && file.name || "").toLowerCase();
    var text = String(rawText || "").replace(/\r\n/g, "\n");
    var looksLikeSubtitle = /\.(srt|vtt)$/.test(name) || /^WEBVTT/m.test(text) || /^\d+\s*\n\d{2}:\d{2}:/m.test(text);
    if (!looksLikeSubtitle) return text.trim();
    var segments = v011ParseSubtitleFile(text);
    if (!segments.length) return text.trim();
    return segments.map(function (segment) { return segment.text; }).join("\n").trim();
  }

  function openScriptImportPicker() {
    scriptImportFileInput.value = "";
    scriptImportFileInput.click();
  }

  if (scriptImportBtn) scriptImportBtn.addEventListener("click", openScriptImportPicker);
  scriptImportFileInput.addEventListener("change", function () {
    var file = scriptImportFileInput.files && scriptImportFileInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast("讲稿文件过大，请选择 2 MB 以内的 md/txt/srt/vtt 文件");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var text = scriptTextFromFile(file, reader.result);
      if (!text) {
        updateScriptStatus("未识别到有效讲稿；请选择 md、txt、srt 或 vtt 文件。");
        toast("讲稿载入失败：文件没有可用文本");
        return;
      }
      teleText.value = text;
      state.tele.text = text;
      state.v011.text.script.sourceText = text;
      v011SaveProject("script-import");
      updateScriptStatus("已载入讲稿：" + (file.name || "未命名文件") + "。录后逐字稿仍以实际音频为准。");
      toast("讲稿已载入并保存");
    };
    reader.onerror = function () { toast("讲稿文件读取失败"); };
    reader.readAsText(file);
  });
  updateScriptStatus();

  function setTeleScrolling(on) {
    state.tele.scrolling = on;
    teleScrollBtn.textContent = on ? "⏸" : "▶";
    if (on) {
      state.tele.scrollCarry = 0;
      state.tele.scrollTimer = setInterval(function () {
        state.tele.scrollCarry += state.tele.speed / 20;
        var px = Math.floor(state.tele.scrollCarry + 1e-9);
        if (px > 0) {
          teleText.scrollTop += px;
          state.tele.scrollCarry -= px;
        }
      }, 50);
    } else {
      if (state.tele.scrollTimer) clearInterval(state.tele.scrollTimer);
      state.tele.scrollTimer = null;
    }
  }

  teleToggle.addEventListener("click", function () {
    state.tele.open = !state.tele.open;
    tele.classList.toggle("ec-open", state.tele.open);
    teleToggle.textContent = state.tele.open ? "关闭提词器" : "打开提词器";
  });
  teleClose.addEventListener("click", function () {
    state.tele.open = false;
    tele.classList.remove("ec-open");
    teleToggle.textContent = "打开提词器";
    setTeleScrolling(false);
  });
  teleScrollBtn.addEventListener("click", function () {
    setTeleScrolling(!state.tele.scrolling);
  });
  teleHide.addEventListener("change", function () {
    state.tele.hideWhileRecording = teleHide.checked;
  });
  teleText.addEventListener("input", function () {
    state.tele.text = teleText.value;
    state.v011.text.script.sourceText = teleText.value;
    v011ScheduleSave("script-edit");
  });
  teleSaveScript.addEventListener("click", function () {
    state.tele.text = teleText.value;
    state.v011.text.script.sourceText = teleText.value;
    v011SaveProject("script-save");
    toast("讲稿已保存，可在后续录制中继续使用");
  });
  teleLoadScript.addEventListener("click", openScriptImportPicker);
  teleSpeed.addEventListener("input", function () {
    state.tele.speed = parseInt(teleSpeed.value, 10);
  });
  teleFs.addEventListener("input", function () {
    state.tele.fontSize = parseInt(teleFs.value, 10);
    teleText.style.fontSize = state.tele.fontSize + "px";
  });
  teleOpacity.addEventListener("input", function () {
    state.tele.opacity = parseInt(teleOpacity.value, 10) / 100;
    tele.style.opacity = state.tele.opacity;
  });
  teleResize.addEventListener("pointerdown", function (ev) {
    beginGesture("resize", tele, ev);
  });
  tele
    .querySelector(".ec-tele-bar")
    .addEventListener("pointerdown", function (ev) {
      if (
        ev.target.classList.contains("ec-tele-close") ||
        ev.target.classList.contains("ec-tele-scroll")
      ) {
        return;
      }
      beginGesture("drag", tele, ev);
    });

  /* Space / arrow keys while teleprompter is open */
  window.addEventListener(
    "keydown",
    function (ev) {
      if (!state.tele.open) return;
      var t = ev.target;
      var editing =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable);
      if (ev.key === " ") {
        if (editing) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        setTeleScrolling(!state.tele.scrolling);
        return;
      }
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        if (editing) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        teleText.scrollTop += ev.key === "ArrowDown" ? 72 : -72;
      }
    },
    true,
  );

  /* ============ Cursor highlight ============ */
  function updateCursorSettingsUI() {
    if (cursorHighlightChk) cursorHighlightChk.checked = state.cursor.highlight !== false;
    if (cursorHighlightStyleSel) cursorHighlightStyleSel.value = state.cursor.highlightStyle || "halo";
    if (cursorShapeSel) cursorShapeSel.value = state.cursor.pointerShape || "system";
    if (cursorSoundSel) cursorSoundSel.value = state.cursor.sound || "off";
    if (cursorOptions) cursorOptions.style.display = state.cursor.highlight === false ? "none" : "block";
    cursorHighlight.classList.remove(
      "ec-cursor-style-halo",
      "ec-cursor-style-spotlight",
      "ec-cursor-style-ring",
      "ec-cursor-style-dot",
      "ec-cursor-shape-system",
      "ec-cursor-shape-dot",
      "ec-cursor-shape-crosshair",
      "ec-cursor-shape-none",
    );
    cursorHighlight.classList.add("ec-cursor-style-" + (state.cursor.highlightStyle || "halo"));
    cursorHighlight.classList.add("ec-cursor-shape-" + (state.cursor.pointerShape || "system"));
    if (!state.rec.active || state.cursor.highlight === false) cursorHighlight.style.display = "none";
  }

  function saveCursorSettings(reason) {
    updateCursorSettingsUI();
    v011ScheduleSave(reason || "cursor-setting");
  }

  function playCursorClickSound() {
    if (!state.rec.active || state.cursor.sound === "off") return;
    try {
      var ac = state.cursor.soundContext || new (window.AudioContext || window.webkitAudioContext)();
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      var now = ac.currentTime;
      osc.type = state.cursor.sound === "click" ? "square" : "sine";
      osc.frequency.value = state.cursor.sound === "click" ? 920 : 620;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(state.cursor.sound === "click" ? 0.045 : 0.025, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (state.cursor.sound === "click" ? 0.075 : 0.12));
      osc.connect(gain);
      if (state.cursor.soundDestination) {
        gain.connect(state.cursor.soundDestination);
      } else {
        gain.connect(ac.destination);
      }
      osc.start(now);
      osc.stop(now + 0.14);
      if (!state.cursor.soundContext) {
        setTimeout(function () { ac.close().catch(function () {}); }, 220);
      }
    } catch (e) {}
  }

  updateCursorSettingsUI();

  document.addEventListener("mousemove", function (ev) {
    state.cursor.x = ev.clientX;
    state.cursor.y = ev.clientY;
    v011RecordPointer(ev);
    if (cursorHighlight.style.display === "block") {
      cursorHighlight.style.left = ev.clientX + "px";
      cursorHighlight.style.top = ev.clientY + "px";
    }
  });

  document.addEventListener("click", function (ev) {
    if (!state.rec.active) return;
    var point = v011CanvasPoint(ev);
    var screenScope = scopeSel && scopeSel.value === "screen";
    var eventPoint = screenScope
      ? {
        x: clamp((Number(ev && ev.clientX) || 0) / Math.max(1, window.innerWidth || 1), 0, 1),
        y: clamp((Number(ev && ev.clientY) || 0) / Math.max(1, window.innerHeight || 1), 0, 1),
        inside: true,
      }
      : point;
    v011RecordEvent("click", {
      x: Number(eventPoint.x.toFixed(4)),
      y: Number(eventPoint.y.toFixed(4)),
      insideCanvas: screenScope ? true : point.inside,
      sourceScope: scopeSel ? scopeSel.value : "screen",
      button: Number(ev.button) || 0,
    });
    cursorHighlight.classList.add("ec-cursor-clicking");
    setTimeout(function () { cursorHighlight.classList.remove("ec-cursor-clicking"); }, 180);
    playCursorClickSound();
  }, true);

  cursorHighlightChk.addEventListener("change", function () {
    state.cursor.highlight = cursorHighlightChk.checked;
    if (state.rec.active) cursorHighlight.style.display = cursorHighlightChk.checked ? "block" : "none";
    saveCursorSettings("cursor-highlight");
  });
  cursorHighlightStyleSel.addEventListener("change", function () {
    state.cursor.highlightStyle = cursorHighlightStyleSel.value || "halo";
    saveCursorSettings("cursor-highlight-style");
  });
  cursorShapeSel.addEventListener("change", function () {
    state.cursor.pointerShape = cursorShapeSel.value || "system";
    saveCursorSettings("cursor-shape");
  });
  cursorSoundSel.addEventListener("change", function () {
    state.cursor.sound = cursorSoundSel.value || "off";
    saveCursorSettings("cursor-sound");
  });

  /* ============ Keyboard shortcuts ============ */
  window.addEventListener("keydown", function (ev) {
    if (presentationState.active) {
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "PageDown" || ev.key === " ") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        stepPresentation(1);
        return;
      }
      if (ev.key === "ArrowLeft" || ev.key === "ArrowUp" || ev.key === "PageUp") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        stepPresentation(-1);
        return;
      }
      if (ev.key === "Home") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        presentFrameAt(0, true);
        return;
      }
      if (ev.key === "End") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        presentFrameAt(getFrames().length - 1, true);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        exitPresentation(false);
        return;
      }
    }
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement) return;
    var code = ev.code || "";
    var key = (ev.key || "").toLowerCase();
    var primaryShortcut = ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey;
    var legacyShortcut = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
    var isShortcut = primaryShortcut || legacyShortcut;
    if (isShortcut && (code === "KeyR" || key === "r")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (state.countdown.active) return;
      if (state.rec.active) {
        toast("正在录制中；停止请按 " + shortcutLabel("S") + "，暂停/继续请按 " + shortcutLabel("P"));
        return;
      }
      startRecording();
      return;
    }
    if (isShortcut && (code === "KeyP" || key === "p")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (state.rec.active) pauseRecording();
      return;
    }
    if (isShortcut && (code === "KeyS" || key === "s")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (state.rec.active) stopRecording();
      return;
    }
    if (ev.key === "Escape" && isSlideOverviewOpen()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closeSlideOverview();
      return;
    }
    if (ev.key === "Escape" && panel.classList.contains("ec-open")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setPanelOpen(false);
    }
  }, true);

  /* ============ Panel open/close ============ */
  var launcher = shadow.querySelector(".ec-launcher");
  var panel = shadow.querySelector(".ec-panel");
  var panelCollapse = shadow.getElementById("ec-panel-collapse");
  function setPanelOpen(open) {
    if (open) closeSlideOverview();
    panel.classList.toggle("ec-open", !!open);
    launcher.classList.toggle("ec-panel-open", !!open);
  }
  launcher.addEventListener("click", function () {
    setPanelOpen(!panel.classList.contains("ec-open"));
  });
  panelCollapse.addEventListener("click", function () {
    setPanelOpen(false);
  });

  if (new URLSearchParams(window.location.search).get("excalicordPanel") === "open") {
    setTimeout(function () { setPanelOpen(true); }, 500);
  }

  /* ============ Page unload safety ============ */
  window.addEventListener("beforeunload", function () {
    if (state.v011.session && !state.v011.session.endedAt) v011EndSession();
    else if (state.v011.sessionDirty) v011SaveProject("beforeunload");
    stopCamera();
    if (state.rec.recorder && state.rec.recorder.state !== "inactive") {
      try {
        state.rec.recorder.stop();
      } catch (e) {}
    }
    if (state.rec.timer) clearInterval(state.rec.timer);
    if (slideAutosaveTimer) clearInterval(slideAutosaveTimer);
    setTeleScrolling(false);
  });

  function getProjectV2ForEditor() {
    return JSON.parse(JSON.stringify(projectFileSnapshot()));
  }

  function saveEditorProject(project, reason) {
    var core = requireEditorCore();
    if (!isPlainObject(project) || project.schemaVersion !== PROJECT_FILE_SCHEMA) {
      return Promise.reject(new Error("录后编辑项目必须是 schema v2"));
    }
    var normalized = core.normalizeProject(project);
    if (normalized.schemaVersion !== PROJECT_FILE_SCHEMA) {
      return Promise.reject(new Error("录后编辑项目未通过 schema v2 校验"));
    }
    normalized = JSON.parse(JSON.stringify(normalized));
    var legacyRuntime = core.projectV2ToLegacyRuntime(normalized);
    state.v011.projectV2 = normalized;
    localStorage.setItem(V011_PROJECT_KEY, JSON.stringify(v011NormalizeProject(legacyRuntime, true)));
    v011ApplyLegacyRuntime(legacyRuntime);
    if (typeof teleText !== "undefined" && teleText) applyLoadedV011Project();
    window.dispatchEvent(new CustomEvent("excalicord:project-saved", {
      detail: { projectId: normalized.projectId, reason: reason || "editor-save" },
    }));

    var bridge = nativeBridge();
    var content = JSON.stringify(normalized, null, 2);
    if (!selectedProjectFolderAvailable()) {
      return Promise.resolve({ ok: true, localOnly: true, projectId: normalized.projectId });
    }
    if (state.rec.projectFolder.mode === "native") {
      if (!bridge || typeof bridge.writeProjectFile !== "function") {
        return Promise.reject(new Error("原生项目目录已设置，但项目写入服务不可用"));
      }
      return bridge.writeProjectFile("project.excalicord.json", content)
        .then(function () { return { ok: true, projectId: normalized.projectId }; });
    }
    return saveProjectAssetBrowser("project.excalicord.json", content)
      .then(function () { return { ok: true, projectId: normalized.projectId }; });
  }

  function saveProjectTextAsset(path, content) {
    var allowed = {
      "text/subtitles.srt": true,
      "text/subtitles.vtt": true,
      "text/transcript.raw.json": true,
      "text/transcript.corrected.json": true,
      "text/transcript.corrections.json": true,
    };
    if (typeof path !== "string" || !allowed[path]) {
      return Promise.reject(new Error("不允许写入该项目文本路径"));
    }
    if (typeof content !== "string") {
      return Promise.reject(new Error("项目文本内容必须是字符串"));
    }
    if (!selectedProjectFolderAvailable()) return Promise.resolve({ ok: true, localOnly: true });
    var bridge = nativeBridge();
    if (state.rec.projectFolder.mode === "native") {
      if (!bridge || typeof bridge.writeProjectFile !== "function") {
        return Promise.reject(new Error("原生项目目录已设置，但文本资产写入服务不可用"));
      }
      return bridge.writeProjectFile(path, content).then(function () { return { ok: true, path: path }; });
    }
    return saveProjectAssetBrowser(path, content).then(function () { return { ok: true, path: path }; });
  }

  function getAsrContextTerms() {
    var frames = typeof getFrames === "function" ? getFrames() : [];
    var activeId = typeof currentFrameId === "function" ? currentFrameId(frames) : "";
    var elements = readElementsSafe().filter(function (element) {
      return element && !element.isDeleted && element.type === "text";
    });
    elements.sort(function (left, right) {
      var leftActive = activeId && left.frameId === activeId ? 1 : 0;
      var rightActive = activeId && right.frameId === activeId ? 1 : 0;
      return rightActive - leftActive;
    });
    var seen = {};
    var terms = [];
    elements.forEach(function (element) {
      var text = String(element.originalText || element.text || "").trim();
      if (!text) return;
      [text].concat(text.split(/[\s，。！？、；：,.!?;:()（）【】\[\]]+/)).forEach(function (term) {
        term = String(term || "").trim();
        if (term.length < 2 || term.length > 100 || seen[term]) return;
        seen[term] = true;
        terms.push(term);
      });
    });
    return terms.slice(0, 200);
  }

  /* debug hooks for automated verification */
  window.__excalicordLocalDebug = {
    faceApiState: faceApiState,
    applySlim: applySlim,
    beautyCanvas: beautyCanvas,
    initFaceApi: initFaceApi,
    pickMimeType: pickMimeType,
    getFrames: getFrameDebugState,
    addFrame: addFrame,
    switchFrame: switchFrame,
    reorderFrame: reorderFrame,
    getRecordingState: function () {
      return {
        active: state.rec.active,
        paused: state.rec.paused,
        seconds: state.rec.seconds,
        recorderState: state.rec.recorder ? state.rec.recorder.state : "none",
        lastBlobSize: state.rec.lastBlob ? state.rec.lastBlob.size : 0,
        lastExt: state.rec.lastExt,
        selectedDisplaySurface: state.rec.selectedDisplaySurface,
        usingDirectDisplay: state.rec.usingDirectDisplay,
        nativeActive: state.rec.nativeActive,
        nativeAvailable: state.rec.nativeAvailable,
        nativeRecordingReady: state.rec.nativeRecordingReady,
        nativeOutputPath: state.rec.nativeOutputPath,
      };
    },
    startRecordingNow: _startRecordingInner,
    startRecording: startRecording,
    pauseRecording: pauseRecording,
    stopRecording: stopRecording,
    getV011Project: function () {
      return v011ProjectSnapshot();
    },
    getProjectV2: getProjectV2ForEditor,
    saveEditorProject: saveEditorProject,
    getLastRecordingBlob: function () { return state.rec.lastBlob || null; },
    saveProjectTextAsset: saveProjectTextAsset,
    getAsrContextTerms: getAsrContextTerms,
    getProjectFolderState: function () {
      return {
        mode: state.rec.projectFolder.mode,
        path: state.rec.projectFolder.path,
        name: state.rec.projectFolder.name,
        hasBrowserHandle: !!state.rec.projectFolder.handle,
        loadedOnce: !!state.rec.projectFolder.loadedOnce,
      };
    },
    setPanelOpen: setPanelOpen,
    saveV011Project: function (reason) {
      return v011SaveProject(reason || "debug");
    },
    saveV011ProjectToFolder: function (reason) {
      var project = v011SaveProject(reason || "debug-folder");
      return project ? saveProjectAssets(project) : Promise.reject(new Error("项目缓存保存失败"));
    },
    openProjectWhiteboardFromFolder: function () {
      if (!selectedProjectFolderAvailable()) return Promise.resolve(false);
      var loader = state.rec.projectFolder.mode === "native"
        ? loadProjectFromNativeFolder
        : loadProjectFromBrowserFolder;
      return loader({ initializeIfMissing: false, requireScene: true, explicitOpen: true, silent: true });
    },
    getProjectSceneSnapshot: function () {
      return JSON.parse(JSON.stringify(projectSceneSnapshot()));
    },
    getV011Session: function () {
      return state.v011.session ? JSON.parse(JSON.stringify(state.v011.session)) : null;
    },
    getSmartCameraState: function () {
      return JSON.parse(JSON.stringify(state.smartCamera));
    },
    getSubtitleTrack: function () {
      return JSON.parse(JSON.stringify(state.v011.text.subtitles.segments || []));
    },
    setSubtitleTrack: function (segments) {
      return JSON.parse(JSON.stringify(v011SetSubtitleTrack(segments, "debug")));
    },
  };
})();
