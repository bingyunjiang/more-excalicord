(function (root, factory) {
  "use strict";
  var core = root && root.ExcalicordEditorCore;
  if (!core && typeof module === "object" && module.exports) core = require("./editor-core.js");
  var api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExcalicordEditorStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";

  if (!core) throw new Error("ExcalicordEditorCore is required");

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function makeId(prefix) {
    return String(prefix || "item") + "-" + Date.now().toString(36) + "-"
      + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createEditorStore(initialProject, options) {
    var config = isObject(options) ? options : {};
    var historyLimit = Math.max(1, Math.min(500, Number(config.historyLimit) || 100));
    var autosaveDelayMs = Math.max(0, Number(config.autosaveDelayMs) || 500);
    var persist = typeof config.persist === "function" ? config.persist : null;
    var project = core.normalizeProject(initialProject);
    var undoStack = [];
    var redoStack = [];
    var listeners = [];
    var dirty = false;
    var saveTimer = null;
    var savePromise = null;

    function emit(type, detail) {
      listeners.slice().forEach(function (listener) {
        try { listener({ type: type, detail: detail || {}, project: clone(project) }); } catch (error) {}
      });
    }

    function scheduleSave(reason) {
      if (!persist) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        flush(reason || "autosave");
      }, autosaveDelayMs);
    }

    function commit(label, mutator) {
      var before = clone(project);
      var next = clone(project);
      mutator(next);
      next.updatedAt = nowIso();
      project = core.normalizeProject(next);
      undoStack.push({ label: label || "edit", project: before });
      if (undoStack.length > historyLimit) undoStack.shift();
      redoStack = [];
      dirty = true;
      emit("change", { label: label || "edit" });
      scheduleSave(label || "edit");
      return clone(project);
    }

    function activeEdit(nextProject) {
      var target = nextProject || project;
      var edit = target.edits.find(function (item) { return item.id === target.activeEditId; });
      if (!edit) throw new Error("No active edit");
      return edit;
    }

    function activeRecording(nextProject) {
      var target = nextProject || project;
      var edit = activeEdit(target);
      var recording = target.recordings.find(function (item) { return item.id === edit.recordingId; });
      if (!recording) throw new Error("Active edit has no recording");
      return recording;
    }

    function addRecording(recordingInput, createEdit) {
      var recording = core.createRecording(recordingInput);
      return commit("add-recording", function (next) {
        if (next.recordings.some(function (item) { return item.id === recording.id; })) {
          throw new Error("Recording already exists: " + recording.id);
        }
        next.recordings.push(recording);
        next.activeRecordingId = recording.id;
        if (createEdit !== false) {
          var edit = core.createEdit({
            id: makeId("edit"),
            recordingId: recording.id,
            durationMs: recording.durationMs,
          });
          next.edits.push(edit);
          next.activeEditId = edit.id;
        }
      });
    }

    function createEdit(recordingId, editOptions) {
      var recording = project.recordings.find(function (item) { return item.id === recordingId; });
      if (!recording) throw new Error("Recording not found: " + recordingId);
      var source = Object.assign({}, isObject(editOptions) ? editOptions : {}, {
        recordingId: recording.id,
        durationMs: recording.durationMs,
      });
      var edit = core.createEdit(source);
      return commit("create-edit", function (next) {
        next.edits.push(edit);
        next.activeRecordingId = recording.id;
        next.activeEditId = edit.id;
      });
    }

    function setActiveEdit(editId) {
      return commit("set-active-edit", function (next) {
        var edit = next.edits.find(function (item) { return item.id === editId; });
        if (!edit) throw new Error("Edit not found: " + editId);
        next.activeEditId = edit.id;
        next.activeRecordingId = edit.recordingId;
      });
    }

    function updateActiveRecording(patch) {
      return commit("update-recording", function (next) {
        var recording = activeRecording(next);
        var changes = isObject(patch) ? clone(patch) : {};
        if (Number.isFinite(Number(changes.durationMs))) {
          recording.durationMs = Math.max(0, Number(changes.durationMs));
        }
        if (typeof changes.state === "string") recording.state = changes.state;
        if (typeof changes.scope === "string") recording.scope = changes.scope;
        if (typeof changes.ratio === "string") recording.ratio = changes.ratio;
        if (isObject(changes.assets)) recording.assets = Object.assign({}, recording.assets, changes.assets);
        recording.updatedAt = nowIso();
        var edit = activeEdit(next);
        edit.timeline = core.normalizeTimeline(edit.timeline, recording.durationMs);
        edit.updatedAt = nowIso();
      });
    }

    function addCut(startMs, endMs, metadata) {
      return commit("add-cut", function (next) {
        var edit = activeEdit(next);
        edit.timeline = core.addCut(edit.timeline, startMs, endMs, metadata);
        edit.updatedAt = nowIso();
      });
    }

    function removeCut(cutId) {
      return commit("remove-cut", function (next) {
        var edit = activeEdit(next);
        edit.timeline = core.removeCut(edit.timeline, cutId);
        edit.updatedAt = nowIso();
      });
    }

    function replaceSpeedRegions(regions) {
      return commit("replace-speed-regions", function (next) {
        var edit = activeEdit(next);
        edit.timeline.speedRegions = Array.isArray(regions) ? clone(regions) : [];
        edit.timeline = core.normalizeTimeline(edit.timeline, edit.timeline.durationMs);
        edit.updatedAt = nowIso();
      });
    }

    function replaceSubtitleSegments(segments) {
      return commit("replace-subtitles", function (next) {
        var edit = activeEdit(next);
        edit.subtitles.segments = Array.isArray(segments) ? clone(segments) : [];
        edit.updatedAt = nowIso();
      });
    }

    function replaceTranscript(transcript, metadata) {
      return commit("replace-transcript", function (next) {
        var edit = activeEdit(next);
        edit.transcript.embedded = isObject(transcript) ? clone(transcript) : null;
        edit.transcript.embeddedCorrected = null;
        edit.transcript.corrections = [];
        edit.transcript.status = edit.transcript.embedded ? "ready" : "empty";
        if (isObject(metadata)) {
          if (typeof metadata.rawPath === "string") edit.transcript.rawPath = metadata.rawPath;
          if (typeof metadata.correctedPath === "string") edit.transcript.correctedPath = metadata.correctedPath;
          if (typeof metadata.correctionsPath === "string") edit.transcript.correctionsPath = metadata.correctionsPath;
        }
        edit.updatedAt = nowIso();
      });
    }

    function correctTranscriptSegment(segmentId, text) {
      return commit("correct-transcript", function (next) {
        var edit = activeEdit(next);
        if (!edit.transcript.embedded) throw new Error("No raw transcript");
        if (!edit.transcript.embeddedCorrected) {
          edit.transcript.embeddedCorrected = clone(edit.transcript.embedded);
        }
        var segment = edit.transcript.embeddedCorrected.segments.find(function (item) { return item.id === segmentId; });
        var rawSegment = edit.transcript.embedded.segments.find(function (item) { return item.id === segmentId; });
        if (!segment || !rawSegment) throw new Error("Transcript segment not found: " + segmentId);
        var correctedText = typeof text === "string" ? text.replace(/\r/g, "").trim() : "";
        if (!correctedText) throw new Error("Corrected transcript text is empty");
        segment.text = correctedText;
        segment.textEdited = correctedText !== rawSegment.text;
        edit.transcript.embeddedCorrected.text = edit.transcript.embeddedCorrected.segments
          .map(function (item) { return item.text; }).join(" ");
        edit.transcript.corrections = edit.transcript.corrections.filter(function (item) {
          return item.segmentId !== segmentId;
        });
        if (correctedText !== rawSegment.text) {
          edit.transcript.corrections.push({
            id: makeId("correction"),
            segmentId: segmentId,
            rawText: rawSegment.text,
            correctedText: correctedText,
            correctedAt: nowIso(),
          });
        } else {
          delete segment.textEdited;
        }
        edit.transcript.correctedPath = edit.transcript.correctedPath || "text/transcript.corrected.json";
        edit.transcript.correctionsPath = edit.transcript.correctionsPath || "text/transcript.corrections.json";
        edit.transcript.status = edit.transcript.corrections.length ? "corrected" : "ready";
        edit.updatedAt = nowIso();
      });
    }

    function replaceCameraKeyframes(keyframes) {
      return commit("replace-camera", function (next) {
        var edit = activeEdit(next);
        edit.camera.keyframes = Array.isArray(keyframes) ? clone(keyframes) : [];
        edit.updatedAt = nowIso();
      });
    }

    function updateCamera(patch) {
      return commit("update-camera", function (next) {
        var edit = activeEdit(next);
        edit.camera = Object.assign({}, edit.camera, isObject(patch) ? clone(patch) : {});
        edit.updatedAt = nowIso();
      });
    }

    function updateCursor(patch) {
      return commit("update-cursor", function (next) {
        var edit = activeEdit(next);
        edit.cursor = Object.assign({}, edit.cursor, isObject(patch) ? clone(patch) : {});
        edit.updatedAt = nowIso();
      });
    }

    function updateWebcam(patch) {
      return commit("update-webcam", function (next) {
        var edit = activeEdit(next);
        edit.webcam = Object.assign({}, edit.webcam, isObject(patch) ? clone(patch) : {});
        edit.updatedAt = nowIso();
      });
    }

    function updateAppearance(patch) {
      return commit("update-appearance", function (next) {
        var edit = activeEdit(next);
        edit.appearance = Object.assign({}, edit.appearance, isObject(patch) ? clone(patch) : {});
        edit.updatedAt = nowIso();
      });
    }

    function updateAudio(patch) {
      return commit("update-audio", function (next) {
        var edit = activeEdit(next);
        edit.audio = Object.assign({}, edit.audio, isObject(patch) ? clone(patch) : {});
        edit.updatedAt = nowIso();
      });
    }

    function setSuggestions(suggestions) {
      return commit("set-suggestions", function (next) {
        var edit = activeEdit(next);
        var previousById = {};
        edit.suggestions.forEach(function (item) {
          if (item && item.id) previousById[item.id] = item;
        });
        var acceptedCutIds = {};
        edit.timeline.cuts.forEach(function (cut) {
          if (cut && cut.suggestionId) acceptedCutIds[cut.suggestionId] = true;
        });
        edit.suggestions = (Array.isArray(suggestions) ? suggestions : []).map(function (item) {
          var suggestion = isObject(item) ? clone(item) : {};
          suggestion.id = typeof suggestion.id === "string" && suggestion.id ? suggestion.id : makeId("suggestion");
          var previous = previousById[suggestion.id];
          var sameDecision = previous
            && previous.type === suggestion.type
            && previous.category === suggestion.category
            && Number(previous.startMs) === Number(suggestion.startMs)
            && Number(previous.endMs) === Number(suggestion.endMs);
          if (suggestion.type === "cut" && acceptedCutIds[suggestion.id]) {
            suggestion.status = "accepted";
            suggestion.resolvedAt = previous && previous.resolvedAt || nowIso();
          } else if (sameDecision && (previous.status === "rejected" || (suggestion.type !== "cut" && previous.status === "accepted"))) {
            suggestion.status = previous.status;
            suggestion.resolvedAt = previous.resolvedAt;
          } else {
            suggestion.status = "pending";
            delete suggestion.resolvedAt;
          }
          return suggestion;
        });
        edit.updatedAt = nowIso();
      });
    }

    function resolveSuggestion(suggestionId, accepted) {
      return commit(accepted ? "accept-suggestion" : "reject-suggestion", function (next) {
        var edit = activeEdit(next);
        var suggestion = edit.suggestions.find(function (item) { return item.id === suggestionId; });
        if (!suggestion) throw new Error("Suggestion not found: " + suggestionId);
        if (suggestion.status === "accepted" && accepted) return;
        suggestion.status = accepted ? "accepted" : "rejected";
        suggestion.resolvedAt = nowIso();
        if (accepted && suggestion.type === "cut") {
          edit.timeline = core.addCut(
            edit.timeline,
            suggestion.startMs,
            suggestion.endMs,
            {
              id: "cut-" + suggestion.id,
              reason: suggestion.reason || suggestion.label || "AI suggestion",
              origin: "ai",
              suggestionId: suggestion.id,
            }
          );
        }
        edit.updatedAt = nowIso();
      });
    }

    function undo() {
      if (!undoStack.length) return false;
      var entry = undoStack.pop();
      redoStack.push({ label: entry.label, project: clone(project) });
      project = core.normalizeProject(entry.project);
      dirty = true;
      emit("change", { label: "undo:" + entry.label });
      scheduleSave("undo");
      return true;
    }

    function redo() {
      if (!redoStack.length) return false;
      var entry = redoStack.pop();
      undoStack.push({ label: entry.label, project: clone(project) });
      project = core.normalizeProject(entry.project);
      dirty = true;
      emit("change", { label: "redo:" + entry.label });
      scheduleSave("redo");
      return true;
    }

    function flush(reason) {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!persist) {
        dirty = false;
        return Promise.resolve(clone(project));
      }
      var snapshot = clone(project);
      savePromise = Promise.resolve(persist(snapshot, reason || "manual"))
        .then(function () {
          dirty = false;
          emit("saved", { reason: reason || "manual" });
          return clone(project);
        })
        .catch(function (error) {
          dirty = true;
          emit("save-error", { reason: reason || "manual", error: error });
          throw error;
        });
      return savePromise;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") return function () {};
      listeners.push(listener);
      return function () {
        listeners = listeners.filter(function (item) { return item !== listener; });
      };
    }

    function destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      listeners = [];
    }

    return {
      getProject: function () { return clone(project); },
      getActiveEdit: function () { return clone(activeEdit()); },
      getActiveRecording: function () { return clone(activeRecording()); },
      isDirty: function () { return dirty; },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      addRecording: addRecording,
      createEdit: createEdit,
      setActiveEdit: setActiveEdit,
      updateActiveRecording: updateActiveRecording,
      addCut: addCut,
      removeCut: removeCut,
      replaceSpeedRegions: replaceSpeedRegions,
      replaceTranscript: replaceTranscript,
      correctTranscriptSegment: correctTranscriptSegment,
      replaceSubtitleSegments: replaceSubtitleSegments,
      replaceCameraKeyframes: replaceCameraKeyframes,
      updateCamera: updateCamera,
      updateCursor: updateCursor,
      updateWebcam: updateWebcam,
      updateAppearance: updateAppearance,
      updateAudio: updateAudio,
      setSuggestions: setSuggestions,
      acceptSuggestion: function (id) { return resolveSuggestion(id, true); },
      rejectSuggestion: function (id) { return resolveSuggestion(id, false); },
      undo: undo,
      redo: redo,
      flush: flush,
      subscribe: subscribe,
      destroy: destroy,
    };
  }

  return { createEditorStore: createEditorStore };
});
