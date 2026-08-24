(function () {
  "use strict";

  if (window.__excalicordPostEditorLoaded) return;
  window.__excalicordPostEditorLoaded = true;

  var core = window.ExcalicordEditorCore;
  var storeApi = window.ExcalicordEditorStore;
  var io = window.ExcalicordEditorIO;
  var roughCut = window.ExcalicordRoughCutCore;
  var smartCamera = window.ExcalicordSmartCameraCore;
  var session = null;
  var launcherTimer = null;

  function dependenciesReady() {
    return !!(core && storeApi && io && roughCut && smartCamera);
  }

  function studioDebug() {
    return window.__excalicordLocalDebug || null;
  }

  function nativeBridge() {
    return window.ExcalicordNativeBridge || null;
  }

  function nativeProjectFolderSelected() {
    var debug = studioDebug();
    var folder = debug && typeof debug.getProjectFolderState === "function" ? debug.getProjectFolderState() : null;
    return !!(folder && folder.mode === "native" && folder.path);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatClock(timeMs) {
    var total = Math.max(0, Math.floor(finite(timeMs, 0) / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    function pad(value) { return String(value).padStart(2, "0"); }
    return hours ? pad(hours) + ":" + pad(minutes) + ":" + pad(seconds) : pad(minutes) + ":" + pad(seconds);
  }

  function recordingEventTimeMs(event) {
    if (event && Number.isFinite(Number(event.timeMs))) return Math.max(0, Number(event.timeMs));
    if (event && Number.isFinite(Number(event.tMs))) return Math.max(0, Number(event.tMs));
    return Math.max(0, finite(event && event.t, 0) * 1000);
  }

  function activeEdit(project) {
    return project.edits.find(function (item) { return item.id === project.activeEditId; }) || null;
  }

  function activeRecording(project) {
    var edit = activeEdit(project);
    return edit && project.recordings.find(function (item) { return item.id === edit.recordingId; }) || null;
  }

  function getCurrentProject() {
    var debug = studioDebug();
    if (!debug) throw new Error("录制工作台尚未准备好");
    var raw = typeof debug.getProjectV2 === "function"
      ? debug.getProjectV2()
      : (typeof debug.getV011Project === "function" ? debug.getV011Project() : null);
    if (!raw) throw new Error("当前没有可编辑的项目");
    var project = core.normalizeProject(raw);
    if (!project.recordings.length || !project.edits.length) throw new Error("先完成并保存一段原始录制，再进入录后编辑");
    return project;
  }

  function canOpenEditor() {
    var debug = studioDebug();
    if (!debug || typeof debug.getRecordingState !== "function") return false;
    var recording = debug.getRecordingState();
    if (recording && recording.lastBlobSize > 0) return true;
    try {
      var project = getCurrentProject();
      var path = typeof core.activeRecordingAssetPath === "function"
        ? core.activeRecordingAssetPath(project)
        : "";
      var verified = !!(path && typeof debug.hasVerifiedProjectMedia === "function" && debug.hasVerifiedProjectMedia(path));
      return typeof core.canOpenEditorProject === "function"
        ? core.canOpenEditorProject(project, verified && path ? (function () { var map = {}; map[path] = true; return map; })() : {}, false)
        : verified;
    } catch (error) {
      return false;
    }
  }

  function ensureLauncher() {
    var host = document.getElementById("excalicord-local");
    var shadow = host && host.shadowRoot;
    if (!shadow) return;
    var existing = shadow.getElementById("ec-open-post-editor");
    var available = canOpenEditor();
    if (existing) {
      existing.hidden = !available;
      existing.disabled = !available;
      return;
    }
    var anchor = shadow.querySelector(".ec-export-row");
    if (!anchor) return;
    var row = document.createElement("div");
    row.id = "ec-post-editor-launch-row";
    row.style.cssText = "display:flex;margin-top:8px";
    var button = document.createElement("button");
    button.type = "button";
    button.id = "ec-open-post-editor";
    button.className = "ec-btn ec-btn-primary";
    button.style.cssText = "width:100%;min-height:38px";
    button.textContent = "进入录后编辑";
    button.hidden = !available;
    button.disabled = !available;
    button.addEventListener("click", openEditor);
    row.appendChild(button);
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
  }

  function editorMarkup() {
    return [
      '<div class="ec-editor-shell" role="dialog" aria-modal="true" aria-label="录后编辑工作台">',
      '  <header class="ec-editor-topbar">',
      '    <button class="ec-editor-back-button" type="button" data-action="close" aria-label="返回白板"><span aria-hidden="true">←</span><span>返回白板</span></button>',
      '    <div class="ec-editor-brand"><span class="ec-editor-brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7.4 6.4h5.9c1 0 1.9.6 2.3 1.5l.4.9h.8a2.7 2.7 0 0 1 2.7 2.7v4.4a2.7 2.7 0 0 1-2.7 2.7H7a2.7 2.7 0 0 1-2.7-2.7v-4.4A2.7 2.7 0 0 1 7 8.8h.5l.6-1.2c.3-.8 1-1.2 1.9-1.2Z"/><circle cx="12" cy="13.8" r="3.2"/><path d="M17.2 10.8h.1"/></svg></span><span class="ec-editor-brand-copy"><span class="ec-editor-kicker">more-excalicord</span><strong>录后编辑</strong></span><span id="ec-editor-project-name"></span></div>',
      '    <div class="ec-editor-top-actions">',
      '      <span class="ec-editor-save-state" id="ec-editor-save-state">已载入</span>',
      '      <button class="ec-editor-icon-button" type="button" data-action="undo" title="撤销" aria-label="撤销">↶</button>',
      '      <button class="ec-editor-icon-button" type="button" data-action="redo" title="重做" aria-label="重做">↷</button>',
      '      <button class="ec-editor-button" type="button" data-action="open-export">打开成片</button>',
      '      <button class="ec-editor-button ec-editor-button-export" type="button" data-action="export">导出成片</button>',
      '    </div>',
      '  </header>',
      '  <main class="ec-editor-main">',
      '    <nav class="ec-editor-tools" aria-label="编辑工具">',
      '      <button class="is-active" data-tool="cut" type="button"><span>✂</span>剪辑</button>',
      '      <button data-tool="transcript" type="button"><span>文</span>逐字稿</button>',
      '      <button data-tool="roughcut" type="button"><span>AI</span>智能粗剪</button>',
      '      <button data-tool="subtitle" type="button"><span>字</span>字幕</button>',
      '      <button data-tool="camera" type="button"><span>⌖</span>镜头</button>',
      '      <button data-tool="cursor" type="button"><span>↖</span>光标</button>',
      '      <button data-tool="webcam" type="button"><span>◉</span>摄像头</button>',
      '      <button data-tool="appearance" type="button"><span>◇</span>画面</button>',
      '      <button data-tool="audio" type="button"><span>♪</span>音频</button>',
      '    </nav>',
      '    <section class="ec-editor-stage-column">',
      '      <div class="ec-editor-stage" id="ec-editor-stage">',
      '        <div class="ec-editor-video-viewport" id="ec-editor-video-viewport">',
      '          <video id="ec-editor-video" playsinline preload="metadata"></video>',
      '          <video class="ec-editor-webcam-overlay" id="ec-editor-webcam" playsinline preload="metadata" muted hidden></video>',
      '          <div class="ec-editor-subtitle-overlay" id="ec-editor-subtitle-overlay"></div>',
      '          <div class="ec-editor-cursor-overlay" id="ec-editor-cursor-overlay"></div>',
      '          <div class="ec-editor-stage-empty" id="ec-editor-stage-empty"><strong>正在载入原始录制</strong><span>项目数据仍可先编辑</span></div>',
      '        </div>',
      '      </div>',
      '      <div class="ec-editor-transport">',
      '        <button class="ec-editor-play" type="button" data-action="play">▶</button>',
      '        <span id="ec-editor-current-time">00:00</span><span class="ec-editor-time-divider">/</span><span id="ec-editor-duration">00:00</span>',
      '        <span class="ec-editor-source-time" id="ec-editor-source-time">原片 00:00</span>',
      '        <button class="ec-editor-transport-action" type="button" data-action="mark-in">设为入点</button>',
      '        <button class="ec-editor-transport-action" type="button" data-action="mark-out">设为出点</button>',
      '        <span class="ec-editor-mark-state" id="ec-editor-mark-state">尚未选择剪辑区间</span>',
      '      </div>',
      '    </section>',
      '    <aside class="ec-editor-inspector" id="ec-editor-inspector"></aside>',
      '  </main>',
      '  <section class="ec-editor-timeline-section">',
      '    <div class="ec-editor-timeline-head"><strong>时间线</strong><span id="ec-editor-timeline-summary"></span><button type="button" data-action="fit-timeline">适合窗口</button></div>',
      '    <div class="ec-editor-timeline-scroll">',
      '      <div class="ec-editor-time-ruler" id="ec-editor-time-ruler"></div>',
      '      <div class="ec-editor-track-list" id="ec-editor-track-list"></div>',
      '      <div class="ec-editor-playhead" id="ec-editor-playhead"></div>',
      '    </div>',
      '  </section>',
      '  <input type="file" id="ec-editor-transcript-file" accept="application/json,.json" hidden>',
      '  <input type="file" id="ec-editor-subtitle-file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden>',
      '  <div class="ec-editor-toast" id="ec-editor-toast" role="status"></div>',
      '</div>',
    ].join("");
  }

  function createHost(project) {
    var host = document.createElement("div");
    host.id = "excalicord-post-editor";
    host.className = "ec-editor-host";
    host.innerHTML = editorMarkup();
    document.body.appendChild(host);
    host.querySelector("#ec-editor-project-name").textContent = project.projectId;
    return host;
  }

  function showToast(message, kind) {
    if (!session || !session.host) return;
    var toast = session.host.querySelector("#ec-editor-toast");
    toast.textContent = String(message || "");
    toast.dataset.kind = kind || "info";
    toast.classList.add("is-visible");
    clearTimeout(session.toastTimer);
    session.toastTimer = setTimeout(function () { toast.classList.remove("is-visible"); }, 3000);
  }

  function setSaveState(message, stateName) {
    if (!session) return;
    var target = session.host.querySelector("#ec-editor-save-state");
    target.textContent = message;
    target.dataset.state = stateName || "saved";
  }

  function activeEditFromProject(project) {
    if (!project || !Array.isArray(project.edits)) return null;
    return project.edits.find(function (edit) { return edit.id === project.activeEditId; }) || project.edits[0] || null;
  }

  function persistCorrectedTranscriptAssets(project) {
    var edit = activeEditFromProject(project);
    if (!edit || !edit.transcript || !edit.transcript.embeddedCorrected) return Promise.resolve();
    var debug = studioDebug();
    if (!debug || typeof debug.saveProjectTextAsset !== "function") return Promise.resolve();
    var correctedPath = edit.transcript.correctedPath || "text/transcript.corrected.json";
    var correctionsPath = edit.transcript.correctionsPath || "text/transcript.corrections.json";
    return Promise.all([
      Promise.resolve(debug.saveProjectTextAsset(correctedPath, JSON.stringify(edit.transcript.embeddedCorrected, null, 2))),
      Promise.resolve(debug.saveProjectTextAsset(correctionsPath, JSON.stringify({
        schemaVersion: 1,
        rawPath: edit.transcript.rawPath || "text/transcript.raw.json",
        correctedPath: correctedPath,
        corrections: edit.transcript.corrections || [],
      }, null, 2))),
    ]);
  }

  function persistProject(project, reason) {
    var debug = studioDebug();
    if (debug && typeof debug.saveEditorProject === "function") {
      return Promise.resolve(debug.saveEditorProject(project, reason)).then(function (result) {
        return persistCorrectedTranscriptAssets(project).then(function () { return result; });
      });
    }
    var bridge = nativeBridge();
    var folder = debug && typeof debug.getProjectFolderState === "function" ? debug.getProjectFolderState() : null;
    if (bridge && bridge.writeProjectFile && folder && folder.mode === "native") {
      return bridge.writeProjectFile("project.excalicord.json", JSON.stringify(project, null, 2));
    }
    return Promise.resolve({ ok: true, localOnly: true });
  }

  function createStore(project) {
    return storeApi.createEditorStore(project, {
      autosaveDelayMs: 700,
      persist: function (nextProject, reason) {
        setSaveState("正在保存…", "saving");
        return persistProject(nextProject, reason).then(function (result) {
          setSaveState(result && result.localOnly ? "已保存到本机缓存" : "项目已保存", "saved");
          return result;
        });
      },
    });
  }

  function loadRecordingMedia() {
    var debug = studioDebug();
    var project = session && session.store && session.store.getProject();
    var recording = project && activeRecording(project);
    var sourceAsset = recording && recording.assets && recording.assets.screen;
    var folder = debug && typeof debug.getProjectFolderState === "function" ? debug.getProjectFolderState() : null;
    var verified = !!(sourceAsset && sourceAsset.path && debug
      && typeof debug.hasVerifiedProjectMedia === "function"
      && debug.hasVerifiedProjectMedia(sourceAsset.path));
    if (verified && folder && folder.mode === "native") {
      return Promise.resolve({
        url: "/api/project-media?path=" + encodeURIComponent(sourceAsset.path),
        fileName: sourceAsset.path.split("/").pop(),
      });
    }
    if (verified && folder && folder.mode === "browser"
      && debug && typeof debug.readProjectMediaBlob === "function") {
      return Promise.resolve(debug.readProjectMediaBlob(sourceAsset.path)).then(function (blob) {
        return { blob: blob, fileName: sourceAsset.path.split("/").pop() };
      });
    }
    if (debug && typeof debug.getLastRecordingBlob === "function") {
      var blob = debug.getLastRecordingBlob();
      if (blob) return Promise.resolve({ blob: blob, fileName: "recording.webm" });
    }
    if (folder && folder.mode !== "none") {
      return Promise.reject(new Error("当前项目的原始录制不存在或尚未验证"));
    }
    var bridge = nativeBridge();
    if (bridge && typeof bridge.downloadLastRecording === "function") {
      return bridge.downloadLastRecording();
    }
    return Promise.reject(new Error("当前无法从项目文件夹读取视频预览"));
  }

  function installMedia() {
    var video = session.video;
    var empty = session.host.querySelector("#ec-editor-stage-empty");
    return loadRecordingMedia().then(function (media) {
      if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
      session.objectUrl = media.blob ? URL.createObjectURL(media.blob) : "";
      video.src = media.url || session.objectUrl;
      empty.hidden = true;
      return new Promise(function (resolve, reject) {
        function loaded() {
          video.removeEventListener("loadedmetadata", loaded);
          video.removeEventListener("error", failed);
          var durationMs = Math.max(0, Math.round(video.duration * 1000));
          if (durationMs) session.store.hydrateActiveRecording({ durationMs: durationMs });
          resolve(media);
        }
        function failed() {
          video.removeEventListener("loadedmetadata", loaded);
          video.removeEventListener("error", failed);
          reject(new Error("原始录制无法解码"));
        }
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.load();
      });
    }).catch(function (error) {
      empty.hidden = false;
      empty.querySelector("strong").textContent = "暂时无法预览原始录制";
      empty.querySelector("span").textContent = error.message || String(error);
      showToast("项目已打开，但视频预览暂不可用", "warning");
      return null;
    });
  }

  function installWebcamMedia() {
    var project = session.store.getProject();
    var recording = activeRecording(project);
    var asset = recording && recording.assets && recording.assets.webcam;
    var webcam = session.webcamVideo;
    if (!asset || !asset.path || recording.legacyComposite) {
      webcam.hidden = true;
      webcam.removeAttribute("src");
      return;
    }
    webcam.src = "/api/project-media?path=" + encodeURIComponent(asset.path);
    webcam.hidden = false;
    webcam.load();
  }

  function sourceDurationMs() {
    if (!session) return 0;
    var recording = session.store.getActiveRecording();
    return Math.max(0, recording.durationMs || (session.video.duration || 0) * 1000);
  }

  function sourceTimeMs() {
    return session ? Math.max(0, finite(session.video.currentTime, 0) * 1000) : 0;
  }

  function timeMap() {
    return core.buildTimeMap(session.store.getActiveEdit().timeline);
  }

  function seekSource(timeMs) {
    if (!session) return;
    var duration = sourceDurationMs();
    session.video.currentTime = clamp(finite(timeMs, 0), 0, duration) / 1000;
    updatePlaybackUi();
  }

  function setPlaybackRate(sourceMs) {
    var regions = session.store.getActiveEdit().timeline.speedRegions;
    var region = regions.find(function (item) { return sourceMs >= item.startMs && sourceMs < item.endMs; });
    session.video.playbackRate = region ? region.rate : 1;
  }

  function skipDeletedRange(sourceMs) {
    var cut = session.store.getActiveEdit().timeline.cuts.find(function (item) {
      return sourceMs >= item.startMs && sourceMs < item.endMs;
    });
    if (!cut) return false;
    session.video.currentTime = Math.min(sourceDurationMs(), cut.endMs + 2) / 1000;
    return true;
  }

  function activeSubtitle(sourceMs) {
    return session.store.getActiveEdit().subtitles.segments.find(function (item) {
      return sourceMs >= item.startMs && sourceMs < item.endMs;
    }) || null;
  }

  function effectiveTranscript(edit) {
    return edit && edit.transcript && (edit.transcript.embeddedCorrected || edit.transcript.embedded) || null;
  }

  function activeRecordingEvents() {
    if (!session || !session.store) return [];
    var recording = session.store.getActiveRecording();
    if (!recording) return [];
    if (Array.isArray(recording.embeddedEvents)) return recording.embeddedEvents;
    if (recording.embeddedSession && Array.isArray(recording.embeddedSession.events)) return recording.embeddedSession.events;
    return [];
  }

  function updatePreviewEffects(sourceMs) {
    var edit = session.store.getActiveEdit();
    var subtitle = activeSubtitle(sourceMs);
    var subtitleOverlay = session.host.querySelector("#ec-editor-subtitle-overlay");
    subtitleOverlay.textContent = subtitle ? subtitle.text : "";
    subtitleOverlay.hidden = !subtitle;
    var cameraState = edit.camera.enabled === false
      ? { x: 0.5, y: 0.5, scale: 1, motionMode: "2d", tiltX: 0, tiltY: 0, overscan: 1 }
      : (typeof smartCamera.motionAt === "function"
        ? smartCamera.motionAt(edit.camera.keyframes, sourceMs, {
          motionMode: edit.camera.motionMode,
          strength: edit.camera.strength,
        })
        : smartCamera.evaluate(edit.camera.keyframes, sourceMs));
    session.video.style.transformOrigin = (cameraState.x * 100).toFixed(2) + "% " + (cameraState.y * 100).toFixed(2) + "%";
    session.video.style.transform = cameraState.motionMode === "3d"
      ? "perspective(1200px) rotateX(" + cameraState.tiltX.toFixed(3) + "deg) rotateY(" + cameraState.tiltY.toFixed(3) + "deg) scale(" + (cameraState.scale * cameraState.overscan).toFixed(4) + ")"
      : "scale(" + cameraState.scale.toFixed(4) + ")";
    var cursor = session.host.querySelector("#ec-editor-cursor-overlay");
    var recording = session.store.getActiveRecording();
    var events = recording.embeddedEvents || recording.embeddedSession && recording.embeddedSession.events || [];
    var pointer = null;
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var event = events[i];
      if ((event.type === "pointer" || event.type === "click") && recordingEventTimeMs(event) <= sourceMs) {
        pointer = event;
        break;
      }
    }
    cursor.hidden = edit.cursor.visible === false || !pointer || pointer.insideCanvas === false;
    if (!cursor.hidden) {
      cursor.style.left = (clamp(pointer.x, 0, 1) * 100) + "%";
      cursor.style.top = (clamp(pointer.y, 0, 1) * 100) + "%";
      cursor.style.setProperty("--cursor-size", String(edit.cursor.size || 1));
      var cursorColor = /^#[0-9a-f]{6}$/i.test(edit.cursor.color || "") ? edit.cursor.color : "#ef4444";
      cursor.style.setProperty("--cursor-rgb", [1, 3, 5].map(function (index) {
        return parseInt(cursorColor.slice(index, index + 2), 16);
      }).join(" "));
      cursor.classList.remove(
        "ec-cursor-style-halo",
        "ec-cursor-style-spotlight",
        "ec-cursor-style-ring",
        "ec-cursor-style-dot",
        "ec-cursor-shape-system",
        "ec-cursor-shape-dot",
        "ec-cursor-shape-crosshair",
        "ec-cursor-shape-none",
      );
      cursor.classList.add("ec-cursor-style-" + (edit.cursor.highlightStyle || "halo"));
      cursor.classList.add("ec-cursor-shape-" + (edit.cursor.pointerShape || "system"));
      cursor.classList.toggle("has-click", edit.cursor.clickEffect !== false && pointer.type === "click" && sourceMs - recordingEventTimeMs(pointer) < 360);
    }
    var webcam = session.webcamVideo;
    var recordingHasWebcam = recording.assets && recording.assets.webcam && recording.assets.webcam.path && !recording.legacyComposite;
    webcam.hidden = !recordingHasWebcam || edit.webcam.visible === false;
    if (!webcam.hidden) {
      webcam.dataset.position = edit.webcam.position || "bottom-right";
      webcam.style.setProperty("--webcam-scale", String(edit.webcam.scale || 0.2));
      webcam.style.transform = edit.webcam.mirror === false ? "none" : "scaleX(-1)";
      if (Math.abs(finite(webcam.currentTime, 0) - finite(session.video.currentTime, 0)) > 0.12) {
        webcam.currentTime = session.video.currentTime;
      }
    }
    var viewport = session.host.querySelector("#ec-editor-video-viewport");
    viewport.style.background = edit.appearance.background || "#17191d";
    viewport.style.borderRadius = Math.max(0, finite(edit.appearance.cornerRadius, 14)) + "px";
    viewport.style.perspective = cameraState.motionMode === "3d" ? "1200px" : "none";
  }

  function updatePlaybackUi() {
    if (!session) return;
    var sourceMs = sourceTimeMs();
    if (!session.video.paused && skipDeletedRange(sourceMs)) return;
    setPlaybackRate(sourceMs);
    var map = timeMap();
    var mapped = core.sourceToOutput(map, sourceMs);
    session.host.querySelector("#ec-editor-current-time").textContent = formatClock(mapped.timeMs);
    session.host.querySelector("#ec-editor-duration").textContent = formatClock(map.outputDurationMs);
    session.host.querySelector("#ec-editor-source-time").textContent = "原片 " + formatClock(sourceMs);
    var duration = Math.max(1, sourceDurationMs());
    session.host.querySelector("#ec-editor-playhead").style.left = (sourceMs / duration * 100) + "%";
    session.host.querySelector('[data-action="play"]').textContent = session.video.paused ? "▶" : "❚❚";
    updatePreviewEffects(sourceMs);
  }

  function timelineBlock(className, startMs, endMs, durationMs, label) {
    var block = document.createElement("span");
    block.className = "ec-editor-timeline-block " + className;
    block.style.left = (startMs / Math.max(1, durationMs) * 100) + "%";
    block.style.width = (Math.max(6, endMs - startMs) / Math.max(1, durationMs) * 100) + "%";
    block.title = label || "";
    if (label) block.setAttribute("aria-label", label);
    return block;
  }

  function renderRuler(durationMs) {
    var ruler = session.host.querySelector("#ec-editor-time-ruler");
    ruler.innerHTML = "";
    var count = 8;
    for (var index = 0; index <= count; index += 1) {
      var tick = document.createElement("span");
      tick.style.left = (index / count * 100) + "%";
      tick.textContent = formatClock(durationMs * index / count);
      ruler.appendChild(tick);
    }
  }

  function createTrack(label, tone) {
    var row = document.createElement("div");
    row.className = "ec-editor-track-row";
    var name = document.createElement("div");
    name.className = "ec-editor-track-name";
    name.textContent = label;
    var lane = document.createElement("div");
    lane.className = "ec-editor-track-lane";
    lane.dataset.tone = tone || "neutral";
    row.appendChild(name);
    row.appendChild(lane);
    return { row: row, lane: lane };
  }

  function renderTimeline() {
    if (!session) return;
    var duration = Math.max(1, sourceDurationMs());
    var edit = session.store.getActiveEdit();
    var recording = session.store.getActiveRecording();
    var list = session.host.querySelector("#ec-editor-track-list");
    list.innerHTML = "";
    renderRuler(duration);

    var videoTrack = createTrack("视频", "video");
    videoTrack.lane.appendChild(timelineBlock("is-source", 0, duration, duration, "原始录制"));
    edit.timeline.cuts.forEach(function (cut) {
      var block = timelineBlock("is-cut", cut.startMs, cut.endMs, duration, cut.reason || "删除区间");
      block.addEventListener("click", function (event) { event.stopPropagation(); seekSource(cut.startMs); });
      videoTrack.lane.appendChild(block);
    });
    list.appendChild(videoTrack.row);

    var cameraTrack = createTrack("镜头", "camera");
    edit.camera.keyframes.forEach(function (frame) {
      cameraTrack.lane.appendChild(timelineBlock("is-keyframe", frame.timeMs, frame.timeMs + 30, duration, frame.source || "镜头关键帧"));
    });
    list.appendChild(cameraTrack.row);

    var cursorTrack = createTrack("光标", "cursor");
    var events = recording.embeddedEvents || recording.embeddedSession && recording.embeddedSession.events || [];
    events.filter(function (event) { return event.type === "click"; }).forEach(function (event) {
      var at = recordingEventTimeMs(event);
      cursorTrack.lane.appendChild(timelineBlock("is-click", at, at + 80, duration, "点击"));
    });
    list.appendChild(cursorTrack.row);

    var transcriptTrack = createTrack("逐字稿", "transcript");
    var transcript = effectiveTranscript(edit);
    (transcript && transcript.segments || []).forEach(function (segment) {
      transcriptTrack.lane.appendChild(timelineBlock("is-transcript", segment.startMs, segment.endMs, duration, segment.text));
    });
    list.appendChild(transcriptTrack.row);

    var subtitleTrack = createTrack("字幕", "subtitle");
    edit.subtitles.segments.forEach(function (segment) {
      subtitleTrack.lane.appendChild(timelineBlock("is-subtitle", segment.startMs, segment.endMs, duration, segment.text));
    });
    list.appendChild(subtitleTrack.row);

    Array.prototype.forEach.call(list.querySelectorAll(".ec-editor-track-lane"), function (lane) {
      lane.addEventListener("click", function (event) {
        var rect = lane.getBoundingClientRect();
        seekSource((event.clientX - rect.left) / Math.max(1, rect.width) * duration);
      });
    });
    var map = timeMap();
    session.host.querySelector("#ec-editor-timeline-summary").textContent = edit.timeline.cuts.length
      ? "原片 " + formatClock(duration) + " · 成片 " + formatClock(map.outputDurationMs) + " · 非破坏剪辑"
      : "原片 " + formatClock(duration) + " · 尚未剪切";
    updatePlaybackUi();
  }

  function sectionTitle(title, hint) {
    var wrap = document.createElement("div");
    wrap.className = "ec-editor-inspector-head";
    var heading = document.createElement("h2");
    heading.textContent = title;
    var copy = document.createElement("p");
    copy.textContent = hint || "";
    wrap.appendChild(heading);
    wrap.appendChild(copy);
    return wrap;
  }

  function inspectorButton(label, action, primary) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ec-editor-button" + (primary ? " is-primary" : "");
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }

  function emptyState(message) {
    var box = document.createElement("div");
    box.className = "ec-editor-empty-card";
    box.textContent = message;
    return box;
  }

  function renderCutInspector(target, edit) {
    target.appendChild(sectionTitle("剪辑", "所有删除都只写入时间线，原始录制保持不变。"));
    var mark = document.createElement("div");
    mark.className = "ec-editor-mark-card";
    mark.innerHTML = '<span>入点 <strong id="ec-editor-inspector-in">未设</strong></span><span>出点 <strong id="ec-editor-inspector-out">未设</strong></span>';
    var add = inspectorButton("剪掉所选区间", "add-cut", true);
    mark.appendChild(add);
    target.appendChild(mark);
    var list = document.createElement("div");
    list.className = "ec-editor-item-list";
    if (!edit.timeline.cuts.length) list.appendChild(emptyState("尚无剪切。播放到需要删除的位置，设置入点和出点。"));
    edit.timeline.cuts.forEach(function (cut) {
      var item = document.createElement("div");
      item.className = "ec-editor-list-item";
      var text = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = formatClock(cut.startMs) + " — " + formatClock(cut.endMs);
      var reason = document.createElement("span");
      reason.textContent = cut.reason || (cut.origin === "ai" ? "智能粗剪" : "手工剪辑");
      text.appendChild(title);
      text.appendChild(reason);
      var remove = inspectorButton("恢复", "remove-cut", false);
      remove.dataset.id = cut.id;
      item.appendChild(text);
      item.appendChild(remove);
      list.appendChild(item);
    });
    target.appendChild(list);
  }

  function renderTranscriptInspector(target, edit) {
    target.appendChild(sectionTitle("逐字稿", "原始逐字稿始终保留；这里的校对只写入独立校正版。提词稿与白板文字仅作术语参考。"));
    var controls = document.createElement("div");
    controls.className = "ec-editor-button-row";
    controls.appendChild(inspectorButton(edit.transcript.embedded ? "重新分析实际录音" : "根据录音生成逐字稿", "transcribe-recording", true));
    controls.appendChild(inspectorButton(edit.transcript.embedded ? "重新导入 JSON" : "导入逐字稿 JSON", "import-transcript", false));
    if (edit.transcript.embedded) controls.appendChild(inspectorButton("按校正版更新字幕", "transcript-to-subtitles", false));
    target.appendChild(controls);
    var transcript = effectiveTranscript(edit);
    if (!transcript) {
      target.appendChild(emptyState("尚未生成逐字稿。可导入 Whisper 等工具输出的带 words 时间戳 JSON；不会使用提词稿冒充实际讲话。"));
      return;
    }
    var meta = document.createElement("div");
    meta.className = "ec-editor-metric-card";
    var wordCount = transcript.segments.reduce(function (total, segment) { return total + segment.words.length; }, 0);
    var correctionCount = edit.transcript.corrections && edit.transcript.corrections.length || 0;
    meta.textContent = transcript.segments.length + " 段 · " + wordCount + " 词 · " + formatClock(transcript.durationMs)
      + (correctionCount ? " · 已校对 " + correctionCount + " 段（原稿保留）" : " · 尚未修改原始识别");
    target.appendChild(meta);
    var list = document.createElement("div");
    list.className = "ec-editor-transcript-list";
    transcript.segments.forEach(function (segment) {
      var item = document.createElement("div");
      item.className = "ec-editor-transcript-row";
      if (segment.reviewRequired) item.classList.add("needs-review");
      var time = document.createElement("button");
      time.type = "button";
      time.dataset.seek = String(segment.startMs);
      time.textContent = formatClock(segment.startMs);
      time.title = "定位并试听原音";
      var text = document.createElement("textarea");
      text.rows = 2;
      text.value = segment.text;
      text.dataset.transcriptSegment = segment.id;
      text.setAttribute("aria-label", formatClock(segment.startMs) + " 的逐字稿校对");
      item.appendChild(time);
      item.appendChild(text);
      if (segment.reviewRequired) item.title = "这段识别置信度较低，请结合原音校对";
      list.appendChild(item);
    });
    target.appendChild(list);
  }

  function renderRoughCutInspector(target, edit) {
    target.appendChild(sectionTitle("智能粗剪", "AI 只提出建议；拿不准的内容一律保留，接受前可定位试听。"));
    var transcript = effectiveTranscript(edit);
    if (!transcript) {
      target.appendChild(emptyState("先在“逐字稿”中导入带词级时间戳的真实录音转写，再分析前摇、长停顿、重说和重复表达。"));
      return;
    }
    var run = inspectorButton(edit.suggestions.length ? "重新分析" : "分析剪辑建议", "analyze-roughcut", true);
    target.appendChild(run);
    var summary = roughCut.summarizeSuggestions(edit.suggestions);
    if (edit.suggestions.length) {
      var metric = document.createElement("div");
      metric.className = "ec-editor-metric-grid";
      [["建议", summary.total], ["可直接剪", summary.directCuts], ["需复核", summary.requiresReview]].forEach(function (entry) {
        var cell = document.createElement("div");
        var value = document.createElement("strong");
        value.textContent = String(entry[1]);
        var label = document.createElement("span");
        label.textContent = entry[0];
        cell.appendChild(value);
        cell.appendChild(label);
        metric.appendChild(cell);
      });
      target.appendChild(metric);
    }
    var list = document.createElement("div");
    list.className = "ec-editor-suggestion-list";
    edit.suggestions.forEach(function (suggestion) {
      var item = document.createElement("article");
      item.className = "ec-editor-suggestion";
      item.dataset.status = suggestion.status;
      var heading = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = suggestion.label || "剪辑建议";
      var time = document.createElement("button");
      time.type = "button";
      time.dataset.seek = String(suggestion.startMs);
      time.textContent = formatClock(suggestion.startMs) + "–" + formatClock(suggestion.endMs);
      heading.appendChild(title);
      heading.appendChild(time);
      var reason = document.createElement("p");
      reason.textContent = suggestion.reason || "";
      item.appendChild(heading);
      item.appendChild(reason);
      if (suggestion.note) {
        var note = document.createElement("small");
        note.textContent = suggestion.note;
        item.appendChild(note);
      }
      if (suggestion.status === "pending") {
        var actions = document.createElement("div");
        var reject = inspectorButton("保留", "reject-suggestion", false);
        reject.dataset.id = suggestion.id;
        var accept = inspectorButton(suggestion.type === "cut" ? "接受剪切" : "标记已检查", "accept-suggestion", true);
        accept.dataset.id = suggestion.id;
        actions.appendChild(reject);
        actions.appendChild(accept);
        item.appendChild(actions);
      } else {
        var resolved = document.createElement("em");
        resolved.textContent = suggestion.status === "accepted"
          ? (suggestion.type === "cut" ? "已剪切" : "已检查")
          : "已保留";
        item.appendChild(resolved);
      }
      list.appendChild(item);
    });
    if (!edit.suggestions.length) list.appendChild(emptyState("尚未分析剪辑建议。"));
    target.appendChild(list);
    var audit = roughCut.auditAcceptedSuggestions(transcript, edit.suggestions, { events: activeRecordingEvents() });
    if (audit.findings.length) {
      var warning = document.createElement("div");
      warning.className = "ec-editor-audit-warning";
      warning.textContent = "信息损失审计：有 " + audit.findings.length + " 处已删内容包含数字、术语或逻辑信息，请逐段复核。";
      target.appendChild(warning);
    }
  }

  function renderSubtitleInspector(target, edit) {
    target.appendChild(sectionTitle("字幕", "字幕来自实际录音逐字稿，可逐条校对；导出时再决定烧录或输出 SRT/VTT。"));
    var controls = document.createElement("div");
    controls.className = "ec-editor-button-row";
    controls.appendChild(inspectorButton("新增字幕", "add-subtitle", true));
    controls.appendChild(inspectorButton("导入 SRT/VTT", "import-subtitle", false));
    controls.appendChild(inspectorButton("导出 SRT", "export-srt", false));
    controls.appendChild(inspectorButton("导出 VTT", "export-vtt", false));
    target.appendChild(controls);
    var list = document.createElement("div");
    list.className = "ec-editor-subtitle-list";
    if (!edit.subtitles.segments.length) list.appendChild(emptyState("当前没有字幕。可从逐字稿生成，或导入 SRT/VTT 后校对。"));
    edit.subtitles.segments.forEach(function (segment) {
      var row = document.createElement("div");
      row.className = "ec-editor-subtitle-row";
      var times = document.createElement("div");
      var start = document.createElement("input");
      start.type = "number";
      start.step = "0.1";
      start.min = "0";
      start.value = (segment.startMs / 1000).toFixed(2);
      start.dataset.subtitleField = "startMs";
      start.dataset.id = segment.id;
      var end = start.cloneNode();
      end.value = (segment.endMs / 1000).toFixed(2);
      end.dataset.subtitleField = "endMs";
      times.appendChild(start);
      times.appendChild(document.createTextNode("→"));
      times.appendChild(end);
      var text = document.createElement("textarea");
      text.value = segment.text;
      text.dataset.subtitleField = "text";
      text.dataset.id = segment.id;
      var remove = inspectorButton("删除", "delete-subtitle", false);
      remove.dataset.id = segment.id;
      row.appendChild(times);
      row.appendChild(text);
      row.appendChild(remove);
      list.appendChild(row);
    });
    target.appendChild(list);
  }

  function controlRow(label, control, hint) {
    var row = document.createElement("label");
    row.className = "ec-editor-control-row";
    var text = document.createElement("span");
    text.textContent = label;
    row.appendChild(text);
    row.appendChild(control);
    if (hint) {
      var note = document.createElement("small");
      note.textContent = hint;
      row.appendChild(note);
    }
    return row;
  }

  function checkbox(value, field) {
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value !== false;
    input.dataset.setting = field;
    return input;
  }

  function range(value, min, max, step, field) {
    var input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.dataset.setting = field;
    return input;
  }

  function selectControl(value, options, field) {
    var select = document.createElement("select");
    select.dataset.setting = field;
    options.forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry[0];
      option.textContent = entry[1];
      select.appendChild(option);
    });
    select.value = value;
    return select;
  }

  function renderCameraInspector(target, edit, recording) {
    var scope = recording && recording.scope || "";
    var canSlideFocus = scope === "canvas" || scope === "frame";
    target.appendChild(sectionTitle("智能镜头", "幻灯片聚焦是白板专属；鼠标、点击和打字线索适用于屏幕、窗口和白板录制，都会写成可编辑镜头轨。"));
    target.appendChild(controlRow("启用镜头轨", checkbox(edit.camera.enabled, "camera.enabled")));
    var slideFocusBox = checkbox(canSlideFocus && edit.camera.slideFocus !== false, "camera.slideFocus");
    if (!canSlideFocus) slideFocusBox.disabled = true;
    target.appendChild(controlRow("幻灯片聚焦", slideFocusBox, canSlideFocus ? "根据幻灯片切换回到全景或聚焦" : "当前录制范围没有幻灯片上下文"));
    target.appendChild(controlRow("鼠标智能聚焦", checkbox(edit.camera.mouseFocus !== false, "camera.mouseFocus"), "根据停留和移动区域生成镜头建议"));
    target.appendChild(controlRow("点击时聚焦", checkbox(edit.camera.clickFocus !== false, "camera.clickFocus"), "点击比普通移动拥有更高聚焦优先级"));
    target.appendChild(controlRow("打字自动缩放", checkbox(edit.camera.typingFocus !== false, "camera.typingFocus"), "打字时根据当前鼠标位置生成短暂聚焦建议"));
    target.appendChild(controlRow("运镜模式", selectControl(edit.camera.motionMode === "3d" ? "3d" : "2d", [["2d", "2D 缩放"], ["3d", "3D 运镜"]], "camera.motionMode"), "2D 只平移缩放；3D 会根据焦点方向增加受控透视与俯仰"));
    target.appendChild(controlRow("镜头强度", selectControl(edit.camera.strength || "gentle", [["gentle", "轻微"], ["medium", "适中"], ["strong", "明显"]], "camera.strength")));
    target.appendChild(controlRow("镜头速度", selectControl(edit.camera.speed || "standard", [["slow", "慢"], ["standard", "标准"], ["fast", "快"]], "camera.speed")));
    var buttons = document.createElement("div");
    buttons.className = "ec-editor-button-row";
    buttons.appendChild(inspectorButton("重算智能镜头", "generate-camera", true));
    buttons.appendChild(inspectorButton("在当前位置添加关键帧", "add-camera-keyframe", false));
    target.appendChild(buttons);
    var metric = document.createElement("div");
    metric.className = "ec-editor-metric-card";
    metric.textContent = edit.camera.keyframes.length + " 个镜头关键帧";
    target.appendChild(metric);
    if (recording.legacyComposite) {
      var warning = document.createElement("div");
      warning.className = "ec-editor-capability-note";
      warning.textContent = "这段旧录制已经把摄像头或部分画面效果写入原片；可做整体镜头调整，但无法把已烧录图层重新拆开。";
      target.appendChild(warning);
    }
  }

  function renderCursorInspector(target, edit) {
    target.appendChild(sectionTitle("光标", "使用录制事件重放光标，样式调整不会改写原始视频。"));
    target.appendChild(controlRow("显示光标", checkbox(edit.cursor.visible, "cursor.visible")));
    var cursorColor = document.createElement("input");
    cursorColor.type = "color";
    cursorColor.value = /^#[0-9a-f]{6}$/i.test(edit.cursor.color || "") ? edit.cursor.color : "#ef4444";
    cursorColor.dataset.setting = "cursor.color";
    target.appendChild(controlRow("高亮颜色", cursorColor));
    target.appendChild(controlRow("点击强调", checkbox(edit.cursor.clickEffect, "cursor.clickEffect")));
    target.appendChild(controlRow("高亮形式", selectControl(edit.cursor.highlightStyle || "halo", [["halo", "光环"], ["spotlight", "聚光"], ["ring", "圆环"], ["dot", "圆点"]], "cursor.highlightStyle")));
    target.appendChild(controlRow("鼠标形状", selectControl(edit.cursor.pointerShape || "system", [["system", "系统指针"], ["dot", "圆点指针"], ["crosshair", "十字指针"], ["none", "不显示指针形状"]], "cursor.pointerShape")));
    target.appendChild(controlRow("鼠标声音", selectControl(edit.cursor.sound || "off", [["off", "关闭"], ["soft", "轻提示音"], ["click", "清脆点击音"]], "cursor.sound"), "保存为项目偏好；录制时由录制面板播放提示音"));
    target.appendChild(controlRow("光标大小", range(edit.cursor.size || 1, 0.5, 2.5, 0.05, "cursor.size")));
    target.appendChild(controlRow("移动平滑", range(edit.cursor.smoothing || 0.55, 0, 1, 0.05, "cursor.smoothing")));
  }

  function renderWebcamInspector(target, edit, recording) {
    target.appendChild(sectionTitle("摄像头", "独立摄像头轨可在录后改变位置、大小和形状；已合成进原片的旧录制仅能整体处理。"));
    target.appendChild(controlRow("显示摄像头", checkbox(edit.webcam.visible, "webcam.visible")));
    target.appendChild(controlRow("位置", selectControl(edit.webcam.position || "bottom-right", [["top-left", "左上"], ["bottom-left", "左下"], ["top-right", "右上"], ["bottom-right", "右下"]], "webcam.position")));
    target.appendChild(controlRow("大小", range(edit.webcam.scale || 0.2, 0.08, 0.45, 0.01, "webcam.scale")));
    target.appendChild(controlRow("镜像", checkbox(edit.webcam.mirror, "webcam.mirror")));
    if (recording.legacyComposite) target.appendChild(emptyState("当前原始录制是合成视频，摄像头位置可能已经固定；设置会保留到项目，但只有独立摄像头素材才能完整生效。"));
  }

  function renderAppearanceInspector(target, edit) {
    target.appendChild(sectionTitle("画面包装", "背景、圆角和留白只属于成片样式，不影响白板文件。"));
    var color = document.createElement("input");
    color.type = "color";
    color.value = edit.appearance.background || "#17191d";
    color.dataset.setting = "appearance.background";
    target.appendChild(controlRow("背景色", color));
    target.appendChild(controlRow("圆角", range(finite(edit.appearance.cornerRadius, 14), 0, 36, 1, "appearance.cornerRadius")));
    target.appendChild(controlRow("画面留白", range(finite(edit.appearance.padding, 0), 0, 80, 2, "appearance.padding")));
    target.appendChild(controlRow("阴影", checkbox(edit.appearance.shadow !== false, "appearance.shadow")));
  }

  function renderAudioInspector(target, edit) {
    target.appendChild(sectionTitle("音频", "音量设置作用于导出成片；逐字稿分析始终基于原始录音。"));
    target.appendChild(controlRow("主音量", range(finite(edit.audio.volume, 1), 0, 2, 0.05, "audio.volume")));
    target.appendChild(controlRow("静音", checkbox(edit.audio.muted === true, "audio.muted-inverted"), "开启后导出视频不包含音频"));
    target.appendChild(controlRow("淡入（秒）", range(finite(edit.audio.fadeInMs, 0) / 1000, 0, 5, 0.1, "audio.fadeInSeconds")));
    target.appendChild(controlRow("淡出（秒）", range(finite(edit.audio.fadeOutMs, 0) / 1000, 0, 5, 0.1, "audio.fadeOutSeconds")));
  }

  function renderInspector() {
    if (!session) return;
    var target = session.host.querySelector("#ec-editor-inspector");
    target.innerHTML = "";
    var edit = session.store.getActiveEdit();
    var recording = session.store.getActiveRecording();
    if (session.activeTool === "cut") renderCutInspector(target, edit);
    else if (session.activeTool === "transcript") renderTranscriptInspector(target, edit);
    else if (session.activeTool === "roughcut") renderRoughCutInspector(target, edit);
    else if (session.activeTool === "subtitle") renderSubtitleInspector(target, edit);
    else if (session.activeTool === "camera") renderCameraInspector(target, edit, recording);
    else if (session.activeTool === "cursor") renderCursorInspector(target, edit);
    else if (session.activeTool === "webcam") renderWebcamInspector(target, edit, recording);
    else if (session.activeTool === "appearance") renderAppearanceInspector(target, edit);
    else if (session.activeTool === "audio") renderAudioInspector(target, edit);
    updateMarkState();
  }

  function updateMarkState() {
    if (!session) return;
    var inText = session.markInMs == null ? "未设" : formatClock(session.markInMs);
    var outText = session.markOutMs == null ? "未设" : formatClock(session.markOutMs);
    var status = session.host.querySelector("#ec-editor-mark-state");
    status.textContent = "入点 " + inText + " · 出点 " + outText;
    var inspectorIn = session.host.querySelector("#ec-editor-inspector-in");
    var inspectorOut = session.host.querySelector("#ec-editor-inspector-out");
    if (inspectorIn) inspectorIn.textContent = inText;
    if (inspectorOut) inspectorOut.textContent = outText;
  }

  function setActiveTool(tool) {
    session.activeTool = tool;
    Array.prototype.forEach.call(session.host.querySelectorAll("[data-tool]"), function (button) {
      button.classList.toggle("is-active", button.dataset.tool === tool);
    });
    renderInspector();
  }

  function asrContextTerms() {
    var project = session.store.getProject();
    var terms = [];
    var debug = studioDebug();
    if (debug && typeof debug.getAsrContextTerms === "function") {
      terms = terms.concat(debug.getAsrContextTerms() || []);
    }
    terms = terms.concat(project.text && project.text.dictionary || []);
    var script = project.text && project.text.script && project.text.script.sourceText || "";
    terms = terms.concat(script.split(/[\s，。！？、；：,.!?;:()（）【】\[\]]+/).filter(function (term) {
      return term.length >= 2 && term.length <= 40;
    }));
    var seen = {};
    return terms.map(function (term) { return String(term || "").trim(); }).filter(function (term) {
      if (!term || term.length > 100 || seen[term]) return false;
      seen[term] = true;
      return true;
    }).slice(0, 200);
  }

  function downloadText(content, fileName, type) {
    var blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function saveSubtitleAsset(path, content) {
    var debug = studioDebug();
    if (debug && typeof debug.saveProjectTextAsset === "function") {
      return Promise.resolve(debug.saveProjectTextAsset(path, content));
    }
    var bridge = nativeBridge();
    var folder = debug && typeof debug.getProjectFolderState === "function" ? debug.getProjectFolderState() : null;
    if (bridge && bridge.writeProjectFile && folder && folder.mode === "native") {
      return bridge.writeProjectFile(path, content);
    }
    return Promise.resolve({ localOnly: true });
  }

  function updateSubtitleField(input) {
    var edit = session.store.getActiveEdit();
    var segments = edit.subtitles.segments.map(function (segment) {
      if (segment.id !== input.dataset.id) return segment;
      var next = clone(segment);
      if (input.dataset.subtitleField === "text") next.text = input.value;
      else next[input.dataset.subtitleField] = Math.max(0, finite(input.value, 0) * 1000);
      return next;
    });
    session.store.replaceSubtitleSegments(segments);
  }

  function updateTranscriptSegment(input) {
    try {
      session.store.correctTranscriptSegment(input.dataset.transcriptSegment, input.value);
      showToast("校正版已更新；原始逐字稿未改动");
    } catch (error) {
      showToast(error.message || error, "warning");
      renderInspector();
    }
  }

  function applySetting(input) {
    var path = input.dataset.setting;
    var value = input.type === "checkbox" ? input.checked : (input.type === "range" ? Number(input.value) : input.value);
    if (path === "camera.enabled") session.store.updateCamera({ enabled: value });
    else if (path.indexOf("camera.") === 0) session.store.updateCamera((function () { var patch = {}; patch[path.slice(7)] = value; return patch; })());
    else if (path.indexOf("cursor.") === 0) session.store.updateCursor((function () { var patch = {}; patch[path.slice(7)] = value; return patch; })());
    else if (path.indexOf("webcam.") === 0) session.store.updateWebcam((function () { var patch = {}; patch[path.slice(7)] = value; return patch; })());
    else if (path === "appearance.background") session.store.updateAppearance({ background: value });
    else if (path === "appearance.cornerRadius") session.store.updateAppearance({ cornerRadius: value });
    else if (path === "appearance.padding") session.store.updateAppearance({ padding: value });
    else if (path === "appearance.shadow") session.store.updateAppearance({ shadow: value });
    else if (path === "audio.volume") session.store.updateAudio({ volume: value });
    else if (path === "audio.muted-inverted") session.store.updateAudio({ muted: value });
    else if (path === "audio.fadeInSeconds") session.store.updateAudio({ fadeInMs: value * 1000 });
    else if (path === "audio.fadeOutSeconds") session.store.updateAudio({ fadeOutMs: value * 1000 });
  }

  function handleAction(action, button) {
    var edit = session.store.getActiveEdit();
    if (action === "close") return closeEditor();
    if (action === "play") {
      if (!session.video.src) return showToast("当前没有可播放的视频预览", "warning");
      if (session.video.paused) {
        session.video.play().then(function () {
          if (!session.webcamVideo.hidden) session.webcamVideo.play().catch(function () {});
        }).catch(function (error) { showToast(error.message || error, "warning"); });
      } else {
        session.video.pause();
        session.webcamVideo.pause();
      }
      return;
    }
    if (action === "undo") { session.store.undo(); return; }
    if (action === "redo") { session.store.redo(); return; }
    if (action === "mark-in") session.markInMs = sourceTimeMs();
    else if (action === "mark-out") session.markOutMs = sourceTimeMs();
    else if (action === "add-cut") {
      if (session.markInMs == null || session.markOutMs == null) return showToast("请先设置入点和出点", "warning");
      var start = Math.min(session.markInMs, session.markOutMs);
      var end = Math.max(session.markInMs, session.markOutMs);
      if (end - start < 80) return showToast("剪辑区间太短", "warning");
      session.store.addCut(start, end, { reason: "手工剪辑", origin: "manual" });
      session.markInMs = null;
      session.markOutMs = null;
      showToast("已加入非破坏剪切");
    } else if (action === "remove-cut") session.store.removeCut(button.dataset.id);
    else if (action === "transcribe-recording") {
      var transcribeBridge = nativeBridge();
      var recordingForAsr = session.store.getActiveRecording();
      var sourceAsset = recordingForAsr.assets && recordingForAsr.assets.screen;
      if (!transcribeBridge || typeof transcribeBridge.transcribeRecording !== "function") {
        return showToast("本地逐字稿服务尚未连接，可先导入带词级时间戳的 JSON", "warning");
      }
      if (!nativeProjectFolderSelected()) {
        return showToast("自动逐字稿需要使用本地项目文件夹；浏览器授权目录可先导入转写 JSON", "warning");
      }
      if (!sourceAsset || !sourceAsset.path) return showToast("当前项目没有可分析的原始录制", "warning");
      button.disabled = true;
      button.textContent = "正在分析实际录音…";
      setSaveState("正在生成逐字稿…", "saving");
      transcribeBridge.transcribeRecording(sourceAsset.path, "zh", asrContextTerms()).then(function (result) {
        var transcript = io.normalizeTranscript(result.transcript);
        session.store.replaceTranscript(transcript, { rawPath: result.relativePath || "text/transcript.raw.json" });
        session.store.replaceSubtitleSegments(io.transcriptToSubtitles(transcript));
        setSaveState("逐字稿与字幕已生成", "saved");
        showToast("已根据实际录音生成词级逐字稿和字幕");
      }).catch(function (error) {
        setSaveState("逐字稿生成失败", "error");
        showToast("逐字稿生成失败：" + (error.message || error), "warning");
      }).finally(function () {
        if (!session) return;
        button.disabled = false;
        renderInspector();
      });
    }
    else if (action === "import-transcript") session.host.querySelector("#ec-editor-transcript-file").click();
    else if (action === "transcript-to-subtitles") {
      session.store.replaceSubtitleSegments(io.transcriptToSubtitles(effectiveTranscript(edit)));
      setActiveTool("subtitle");
      showToast("已按实际录音的校正版逐字稿更新字幕");
    } else if (action === "analyze-roughcut") {
      var result = roughCut.analyzeTranscript(effectiveTranscript(edit), { events: activeRecordingEvents() });
      if (!result.ok) return showToast(result.errors.join("；"), "warning");
      session.store.setSuggestions(result.suggestions);
      showToast("已生成 " + result.suggestions.length + " 条剪辑建议");
    } else if (action === "accept-suggestion") {
      var suggestion = edit.suggestions.find(function (item) { return item.id === button.dataset.id; });
      if (suggestion && suggestion.type === "cut" && suggestion.requiresReview && !window.confirm("这条建议可能包含有效信息或画面操作。请先试听并预览，仍要接受剪切吗？")) return;
      session.store.acceptSuggestion(button.dataset.id);
    } else if (action === "reject-suggestion") session.store.rejectSuggestion(button.dataset.id);
    else if (action === "add-subtitle") {
      var at = sourceTimeMs();
      var segments = edit.subtitles.segments.concat([{ startMs: at, endMs: Math.min(sourceDurationMs(), at + 2500), text: "新字幕", source: "manual" }]);
      session.store.replaceSubtitleSegments(segments);
    } else if (action === "delete-subtitle") {
      session.store.replaceSubtitleSegments(edit.subtitles.segments.filter(function (item) { return item.id !== button.dataset.id; }));
    } else if (action === "import-subtitle") session.host.querySelector("#ec-editor-subtitle-file").click();
    else if (action === "export-srt" || action === "export-vtt") {
      var isSrt = action === "export-srt";
      var content = isSrt ? io.subtitlesToSrt(edit.subtitles.segments) : io.subtitlesToVtt(edit.subtitles.segments);
      var path = "text/subtitles." + (isSrt ? "srt" : "vtt");
      saveSubtitleAsset(path, content).catch(function () {});
      downloadText(content, path.split("/").pop(), isSrt ? "application/x-subrip" : "text/vtt");
      showToast("字幕已导出并保存到项目（目录可用时）");
    } else if (action === "generate-camera") {
      var recording = session.store.getActiveRecording();
      var events = recording.embeddedEvents || recording.embeddedSession && recording.embeddedSession.events || [];
      var track = smartCamera.planFromEvents(events, {
        durationMs: recording.durationMs,
        strength: edit.camera.strength,
        speed: edit.camera.speed || "standard",
        slideFocus: (recording.scope === "canvas" || recording.scope === "frame") && edit.camera.slideFocus !== false,
        mouseFocus: edit.camera.mouseFocus !== false,
        clickFocus: edit.camera.clickFocus !== false,
        typingFocus: edit.camera.typingFocus !== false,
        motionMode: edit.camera.motionMode === "3d" ? "3d" : "2d",
        allowOutsideCanvas: recording.scope === "screen",
        initialFrameId: recording.embeddedSession && recording.embeddedSession.initialFrameId,
      });
      session.store.replaceCameraKeyframes(track);
      showToast("已重算智能镜头轨");
    } else if (action === "add-camera-keyframe") {
      var cameraState = smartCamera.evaluate(edit.camera.keyframes, sourceTimeMs());
      var frames = edit.camera.keyframes.concat([{
        timeMs: sourceTimeMs(), x: cameraState.x, y: cameraState.y,
        scale: Math.max(1.15, cameraState.scale), transitionMs: 380, source: "manual", locked: true,
      }]);
      session.store.replaceCameraKeyframes(smartCamera.mergeManualKeyframes(edit.camera.keyframes, frames.filter(function (item) { return item.locked; })));
    } else if (action === "fit-timeline") renderTimeline();
    else if (action === "open-export") {
      var bridge = nativeBridge();
      if (!bridge || typeof bridge.openLastExport !== "function") return showToast("本地成片服务尚未连接", "warning");
      if (!nativeProjectFolderSelected()) return showToast("打开成片需要使用本地项目文件夹", "warning");
      bridge.openLastExport().then(function () { showToast("已在 Finder 中显示成片"); })
        .catch(function (error) { showToast(error.message || error, "warning"); });
    } else if (action === "export") exportComposition();
    updateMarkState();
  }

  function handleTranscriptFile(file) {
    if (!file) return;
    file.text().then(io.normalizeTranscript).then(function (transcript) {
      var rawPath = "text/transcript.raw.json";
      session.store.replaceTranscript(transcript, { rawPath: rawPath });
      return saveSubtitleAsset(rawPath, JSON.stringify(transcript, null, 2)).then(function () {
        showToast("逐字稿已载入；原始识别已单独保存");
      });
    }).catch(function (error) { showToast("逐字稿导入失败：" + (error.message || error), "warning"); });
  }

  function handleSubtitleFile(file) {
    if (!file) return;
    file.text().then(function (text) {
      var segments = io.parseSubtitleText(text);
      if (!segments.length) throw new Error("未找到有效字幕段");
      session.store.replaceSubtitleSegments(segments);
      showToast("已导入 " + segments.length + " 条字幕");
    }).catch(function (error) { showToast("字幕导入失败：" + (error.message || error), "warning"); });
  }

  function exportComposition() {
    setSaveState("正在准备导出…", "saving");
    session.store.flush("before-export").then(function (project) {
      var manifest = core.createCompositionManifest(project);
      var bridge = nativeBridge();
      if (bridge && typeof bridge.renderComposition === "function" && nativeProjectFolderSelected()) {
        return bridge.renderComposition(manifest).then(function (result) {
          setSaveState("成片已导出", "saved");
          showToast("MP4 已导出到项目 exports 文件夹");
          return result;
        });
      }
      downloadText(JSON.stringify(manifest, null, 2), "composition.excalicord.json", "application/json");
      setSaveState("项目已保存", "saved");
      showToast("当前项目文件夹不能直接调用本地渲染；已导出成片配置，原始录制未改动", "warning");
      return null;
    }).catch(function (error) {
      setSaveState("导出失败", "error");
      showToast("导出失败：" + (error.message || error), "warning");
    });
  }

  function bindEditorEvents() {
    session.host.addEventListener("click", function (event) {
      var tool = event.target.closest("[data-tool]");
      if (tool) return setActiveTool(tool.dataset.tool);
      var seek = event.target.closest("[data-seek]");
      if (seek) return seekSource(Number(seek.dataset.seek));
      var action = event.target.closest("[data-action]");
      if (action) handleAction(action.dataset.action, action);
    });
    session.host.addEventListener("change", function (event) {
      if (event.target.dataset.subtitleField) updateSubtitleField(event.target);
      else if (event.target.dataset.transcriptSegment) updateTranscriptSegment(event.target);
      else if (event.target.dataset.setting) applySetting(event.target);
    });
    session.host.addEventListener("input", function (event) {
      if (event.target.dataset.setting && event.target.type === "range") applySetting(event.target);
    });
    session.host.querySelector("#ec-editor-transcript-file").addEventListener("change", function (event) {
      handleTranscriptFile(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
    session.host.querySelector("#ec-editor-subtitle-file").addEventListener("change", function (event) {
      handleSubtitleFile(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
    session.video.addEventListener("timeupdate", updatePlaybackUi);
    session.video.addEventListener("play", updatePlaybackUi);
    session.video.addEventListener("pause", updatePlaybackUi);
    session.video.addEventListener("ended", updatePlaybackUi);
    session.unsubscribe = session.store.subscribe(function (event) {
      if (!session) return;
      if (event.type === "change") {
        setSaveState("有未保存修改", "dirty");
        renderTimeline();
        renderInspector();
      } else if (event.type === "save-error") {
        setSaveState("保存失败", "error");
      }
    });
    window.addEventListener("keydown", editorKeydown, true);
  }

  function editorKeydown(event) {
    if (!session) return;
    var editable = /INPUT|TEXTAREA|SELECT/.test(event.target && event.target.tagName || "");
    if (event.key === "Escape" && !editable) { event.preventDefault(); closeEditor(); }
    if (event.code === "Space" && !editable) {
      event.preventDefault();
      handleAction("play", session.host.querySelector('[data-action="play"]'));
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !editable) {
      event.preventDefault();
      if (event.shiftKey) session.store.redo(); else session.store.undo();
    }
  }

  function openEditor() {
    if (session) return;
    if (!dependenciesReady()) {
      window.alert("录后编辑模块尚未完整加载，请刷新页面后重试。");
      return;
    }
    var project;
    try { project = getCurrentProject(); } catch (error) {
      window.alert(error.message || String(error));
      return;
    }
    var debug = studioDebug();
    if (debug && typeof debug.setPanelOpen === "function") debug.setPanelOpen(false);
    var host = createHost(project);
    var store = createStore(project);
    session = {
      host: host,
      store: store,
      video: host.querySelector("#ec-editor-video"),
      webcamVideo: host.querySelector("#ec-editor-webcam"),
      objectUrl: "",
      activeTool: "cut",
      markInMs: null,
      markOutMs: null,
      unsubscribe: null,
      toastTimer: null,
    };
    document.documentElement.classList.add("ec-editor-open");
    bindEditorEvents();
    renderTimeline();
    renderInspector();
    installMedia().then(function () {
      if (!session) return;
      installWebcamMedia();
      renderTimeline();
      renderInspector();
    });
  }

  function closeEditor() {
    if (!session) return;
    var closing = session;
    closing.video.pause();
    closing.webcamVideo.pause();
    var finalizeClose = function () {
      if (closing.unsubscribe) closing.unsubscribe();
      closing.store.destroy();
      if (closing.objectUrl) URL.revokeObjectURL(closing.objectUrl);
      closing.host.remove();
      window.removeEventListener("keydown", editorKeydown, true);
      document.documentElement.classList.remove("ec-editor-open");
      if (session === closing) session = null;
      ensureLauncher();
    };
    if (!closing.store.isDirty()) {
      finalizeClose();
      return;
    }
    closing.store.flush("close-editor").catch(function () {}).finally(finalizeClose);
  }

  window.ExcalicordPostEditor = {
    open: openEditor,
    close: closeEditor,
    isOpen: function () { return !!session; },
  };

  window.addEventListener("excalicord:project-saved", ensureLauncher);
  window.addEventListener("excalicord:recording-ready", ensureLauncher);
  window.addEventListener("excalicord:project-context-changed", ensureLauncher);
  launcherTimer = window.setInterval(ensureLauncher, 1200);
  window.addEventListener("beforeunload", function () {
    if (launcherTimer) clearInterval(launcherTimer);
  });
  ensureLauncher();
})();
