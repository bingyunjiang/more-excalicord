"use strict";

var assert = require("assert");
var core = require("../src/editor-core.js");
var storeApi = require("../src/editor-store.js");

(async function () {
  var saved = [];
  var project = core.createProject({ projectId: "store-test" });
  var store = storeApi.createEditorStore(project, {
    autosaveDelayMs: 100000,
    persist: function (snapshot, reason) {
      saved.push({ snapshot: snapshot, reason: reason });
    },
  });

  store.addRecording({
    id: "recording-1",
    durationMs: 12000,
    assets: { screen: { path: "recordings/recording-1/screen.mp4", type: "video/mp4" } },
  });
  assert.strictEqual(store.getProject().recordings.length, 1);
  assert.strictEqual(store.getProject().edits.length, 1);

  store.addCut(1000, 2000, { id: "cut-one", reason: "前摇" });
  assert.strictEqual(store.getActiveEdit().timeline.cuts.length, 1);
  assert.strictEqual(store.canUndo(), true);
  assert.strictEqual(store.undo(), true);
  assert.strictEqual(store.getActiveEdit().timeline.cuts.length, 0);
  assert.strictEqual(store.redo(), true);
  assert.strictEqual(store.getActiveEdit().timeline.cuts.length, 1);

  store.replaceSubtitleSegments([{ id: "subtitle-1", startMs: 2000, endMs: 3000, text: "字幕" }]);
  assert.strictEqual(store.getActiveEdit().subtitles.segments[0].text, "字幕");
  store.replaceTranscript({ language: "zh-CN", segments: [] });
  assert.strictEqual(store.getActiveEdit().transcript.status, "ready");
  store.replaceTranscript({ language: "zh-CN", text: "原始", segments: [{ id: "segment-1", text: "原始", words: [] }] });
  store.correctTranscriptSegment("segment-1", "校正");
  assert.strictEqual(store.getActiveEdit().transcript.embedded.segments[0].text, "原始");
  assert.strictEqual(store.getActiveEdit().transcript.embeddedCorrected.segments[0].text, "校正");
  assert.strictEqual(store.getActiveEdit().transcript.embeddedCorrected.segments[0].textEdited, true);
  assert.strictEqual(store.getActiveEdit().transcript.corrections.length, 1);
  store.updateCamera({ enabled: false, strength: "strong" });
  assert.strictEqual(store.getActiveEdit().camera.enabled, false);
  assert.strictEqual(store.getActiveEdit().camera.strength, "strong");
  store.updateAudio({ volume: 0.8 });
  assert.strictEqual(store.getActiveEdit().audio.volume, 0.8);
  store.updateActiveRecording({ durationMs: 12000 });
  assert.strictEqual(store.getActiveRecording().durationMs, 12000);
  assert.strictEqual(store.getActiveEdit().timeline.durationMs, 12000);

  store.setSuggestions([{
    id: "suggestion-1",
    type: "cut",
    startMs: 4000,
    endMs: 5000,
    reason: "作废 take",
  }]);
  assert.strictEqual(store.getActiveEdit().suggestions[0].status, "pending");
  store.acceptSuggestion("suggestion-1");
  assert.strictEqual(store.getActiveEdit().suggestions[0].status, "accepted");
  assert.strictEqual(store.getActiveEdit().timeline.cuts.length, 2);
  store.setSuggestions([{
    id: "suggestion-1",
    type: "cut",
    startMs: 4000,
    endMs: 5000,
    reason: "重新分析后的同一建议",
  }]);
  assert.strictEqual(store.getActiveEdit().suggestions[0].status, "accepted");
  store.removeCut("cut-suggestion-1");
  store.setSuggestions([{
    id: "suggestion-1",
    type: "cut",
    startMs: 4000,
    endMs: 5000,
    reason: "恢复后重新分析",
  }]);
  assert.strictEqual(store.getActiveEdit().suggestions[0].status, "pending");

  store.updateCursor({ size: 1.5, smoothing: 0.8, highlightStyle: "ring", pointerShape: "crosshair", sound: "soft" });
  store.updateWebcam({ position: "top-left", scale: 0.3 });
  assert.strictEqual(store.getActiveEdit().cursor.size, 1.5);
  assert.strictEqual(store.getActiveEdit().cursor.highlightStyle, "ring");
  assert.strictEqual(store.getActiveEdit().cursor.pointerShape, "crosshair");
  assert.strictEqual(store.getActiveEdit().cursor.sound, "soft");
  assert.strictEqual(store.getActiveEdit().webcam.position, "top-left");

  await store.flush("test");
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].reason, "test");
  assert.strictEqual(store.isDirty(), false);
  store.destroy();

  console.log("editor store tests ok");
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
