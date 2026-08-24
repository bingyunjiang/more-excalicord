"use strict";

var assert = require("assert");
var core = require("../src/editor-core.js");

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.001, message + ": " + actual + " !== " + expected);
}

var project = core.createProject({ projectId: "project-test" });
assert.strictEqual(project.schemaVersion, 2);
assert.strictEqual(project.scene.path, "scene.excalidraw");
assert.strictEqual(project.text.script.path, "text/script.md");
assert.strictEqual(core.safeRelativePath("recordings/session/video.mp4", ""), "recordings/session/video.mp4");
assert.strictEqual(core.safeRelativePath("../outside.mp4", "fallback"), "fallback");
assert.strictEqual(core.safeRelativePath("/tmp/outside.mp4", "fallback"), "fallback");

var focusedViewport = core.calculateFrameFocusViewport(
  { x: 0, y: 0, width: 1600, height: 900 },
  { w: 1494, h: 792 }
);
close(focusedViewport.zoom.value, 0.6952, "focused slide zoom matches desktop safe area");
close(focusedViewport.scrollX, 306.7462600690451, "focused slide horizontal position");
close(focusedViewport.scrollY, 148.10126582278485, "focused slide vertical position");
var focusedLeft = focusedViewport.zoom.value * focusedViewport.scrollX;
var focusedTop = focusedViewport.zoom.value * focusedViewport.scrollY;
close(focusedLeft, 213.25, "focused slide visible left edge");
close(focusedTop, 102.96, "focused slide visible top edge");
var portraitViewport = core.calculateFrameFocusViewport(
  { x: 20, y: 30, width: 900, height: 1600 },
  { width: 900, height: 1000 }
);
assert.ok(portraitViewport.zoom.value > 0.49 && portraitViewport.zoom.value < 0.5,
  "non-16:9 frames must also fit the adaptive safe area");
var rootA = core.projectRootFingerprint({ mode: "native", path: "/Users/Bing/Movies/Project A/" });
var rootASame = core.projectRootFingerprint({ mode: "native", path: "/Users/Bing/Movies/Project A" });
var rootB = core.projectRootFingerprint({ mode: "native", path: "/Users/Bing/Movies/Project B" });
assert.strictEqual(rootA, rootASame, "trailing slash must not change project-root identity");
assert.notStrictEqual(rootA, rootB, "different project roots must not share a cache identity");

var migrated = core.normalizeProject({
  schemaVersion: 1,
  projectId: "legacy-project",
  recording: {
    scope: "frame",
    ratio: "16:9",
    media: [{
      path: "recordings/legacy.mp4",
      type: "video/mp4",
      recordedAt: "2026-08-23T00:00:00.000Z",
      duration: 10,
    }],
  },
  events: [{ type: "frame-change", at: 1 }],
  text: {
    script: { sourceText: "讲稿" },
    transcript: { raw: [{ text: "实际口播" }] },
    subtitles: { segments: [{ start: 0, end: 1, text: "字幕" }] },
  },
  edits: {
    cuts: [{ start: 2, end: 3 }],
    camera: { enabled: false, strength: "dynamic", keyframes: [] },
    cursor: { color: "#3b82f6", size: 1.4 },
    webcam: { screenLightEnabled: true, screenLightIntensity: 0.7 },
  },
});
assert.strictEqual(migrated.schemaVersion, 2);
assert.strictEqual(migrated.recordings.length, 1);
assert.strictEqual(migrated.recordings[0].legacyComposite, true);
assert.strictEqual(migrated.recordings[0].assets.screen.path, "recordings/legacy.mp4");
assert.strictEqual(migrated.recordings[0].embeddedEvents.length, 1);
assert.strictEqual(migrated.text.script.sourceText, "讲稿");
assert.strictEqual(migrated.text.transcript.raw[0].text, "实际口播");
assert.strictEqual(migrated.edits.length, 1);
assert.strictEqual(migrated.edits[0].subtitles.segments[0].text, "字幕");
assert.strictEqual(migrated.edits[0].subtitles.segments[0].startMs, 0);
assert.strictEqual(migrated.edits[0].subtitles.segments[0].endMs, 1000);
assert.strictEqual(migrated.edits[0].camera.enabled, false);
assert.strictEqual(migrated.edits[0].camera.strength, "dynamic");
assert.strictEqual(migrated.edits[0].cursor.color, "#3b82f6");
assert.strictEqual(migrated.edits[0].cursor.size, 1.4);
assert.strictEqual(migrated.edits[0].webcam.screenLightEnabled, true);
assert.strictEqual(migrated.edits[0].webcam.screenLightIntensity, 0.7);
var legacyRoundTrip = core.projectV2ToLegacyRuntime(migrated);
assert.strictEqual(legacyRoundTrip.schemaVersion, 1);
assert.strictEqual(legacyRoundTrip.recording.media[0].path, "recordings/legacy.mp4");
assert.strictEqual(legacyRoundTrip.text.script.sourceText, "讲稿");
assert.strictEqual(legacyRoundTrip.text.subtitles.segments[0].start, 0);
assert.strictEqual(legacyRoundTrip.text.subtitles.segments[0].end, 1);
assert.strictEqual(legacyRoundTrip.edits.camera.enabled, false);
assert.strictEqual(legacyRoundTrip.edits.camera.strength, "dynamic");
assert.strictEqual(legacyRoundTrip.edits.cursor.color, "#3b82f6");
assert.strictEqual(legacyRoundTrip.edits.webcam.screenLightEnabled, true);
var mergedRoundTrip = core.mergeLegacyRuntimeIntoProjectV2(migrated, legacyRoundTrip);
assert.strictEqual(mergedRoundTrip.schemaVersion, 2);
assert.strictEqual(mergedRoundTrip.recordings.length, 1);
assert.strictEqual(mergedRoundTrip.edits.length, 1);

var emptyLegacyProject = core.normalizeProject({
  schemaVersion: 1,
  projectId: "empty-project",
  recording: { scope: "screen", ratio: "16:9", duration: 0, media: [] },
  session: null,
  events: [],
  text: { script: { sourceText: "保留的讲稿" } },
  edits: {},
});
assert.strictEqual(emptyLegacyProject.recordings.length, 0, "empty event arrays must not create fake recordings");
assert.strictEqual(emptyLegacyProject.edits.length, 0, "a fresh project has no edit track before recording");
assert.strictEqual(emptyLegacyProject.activeRecordingId, "");
assert.strictEqual(emptyLegacyProject.activeEditId, "");
assert.strictEqual(emptyLegacyProject.text.script.sourceText, "保留的讲稿");

var metadataOnly = core.normalizeProject({
  schemaVersion: 1,
  projectId: "recording-in-progress",
  recording: { scope: "screen", ratio: "16:9", duration: 5, media: [] },
  session: { id: "session-new", durationMs: 5000 },
  events: [{ type: "session-start", timeMs: 0 }],
});
var completed = core.mergeLegacyRuntimeIntoProjectV2(metadataOnly, {
  schemaVersion: 1,
  projectId: "recording-in-progress",
  recording: {
    scope: "screen",
    ratio: "16:9",
    duration: 8,
    media: [{
      path: "recordings/session-new/screen.mp4",
      type: "video/mp4",
      duration: 8,
    }],
  },
  session: { id: "session-new", durationMs: 8000 },
  events: [{ type: "session-stop", timeMs: 8000 }],
  text: {},
  edits: {},
});
assert.strictEqual(completed.recordings.length, 1, "finished media replaces its metadata-only placeholder");
assert.strictEqual(completed.recordings[0].assets.screen.path, "recordings/session-new/screen.mp4");
assert.strictEqual(completed.activeRecordingId, completed.recordings[0].id);
assert.strictEqual(completed.edits.length, 1);
assert.strictEqual(completed.edits[0].recordingId, completed.activeRecordingId);
assert.strictEqual(completed.activeEditId, completed.edits[0].id);

var timeline = core.normalizeTimeline({
  durationMs: 10000,
  cuts: [{ id: "cut-a", startMs: 2000, endMs: 3000 }],
  speedRegions: [{ id: "speed-a", startMs: 5000, endMs: 7000, rate: 2 }],
}, 10000);
var timeMap = core.buildTimeMap(timeline);
close(timeMap.outputDurationMs, 8000, "output duration");
close(core.sourceToOutput(timeMap, 1000).timeMs, 1000, "source before cut");
assert.strictEqual(core.sourceToOutput(timeMap, 2500).deleted, true);
close(core.sourceToOutput(timeMap, 4000).timeMs, 3000, "source after cut");
close(core.sourceToOutput(timeMap, 6000).timeMs, 4500, "source inside speed region");
close(core.outputToSource(timeMap, 4500).timeMs, 6000, "output inside speed region");

var mapped = core.mapSourceRange(timeMap, 1500, 3500);
assert.strictEqual(mapped.length, 2);
close(mapped[0].sourceStartMs, 1500, "range first start");
close(mapped[0].sourceEndMs, 2000, "range first end");
close(mapped[1].sourceStartMs, 3000, "range second start");
close(mapped[1].outputStartMs, 2000, "range output resumes at cut boundary");

var withCut = core.addCut({ durationMs: 10000, cuts: [], speedRegions: [] }, 1000, 2000, { id: "new-cut" });
assert.strictEqual(withCut.cuts.length, 1);
assert.strictEqual(withCut.cuts[0].id, "new-cut");
assert.strictEqual(core.removeCut(withCut, "new-cut").cuts.length, 0);

var recording = core.createRecording({
  id: "recording-1",
  durationMs: 10000,
  assets: { screen: { path: "recordings/recording-1/screen.mp4", type: "video/mp4" } },
});
var edit = core.createEdit({ id: "edit-1", recordingId: recording.id, durationMs: recording.durationMs });
project.recordings.push(recording);
project.edits.push(edit);
project.activeRecordingId = recording.id;
project.activeEditId = edit.id;
var manifest = core.createCompositionManifest(project);
assert.strictEqual(manifest.recordingId, "recording-1");
assert.strictEqual(manifest.timeMap.outputDurationMs, 10000);
assert.strictEqual(core.validateProject(project).valid, true);
var boundCache = core.createBoundProjectCache(project, rootA);
assert.strictEqual(core.readBoundProjectCache(boundCache, rootA).projectId, "project-test");
assert.strictEqual(core.readBoundProjectCache(boundCache, rootB), null, "stale cache from another root must be rejected");
assert.strictEqual(core.readBoundProjectCache(project, rootA), null, "unbound legacy cache must be rejected");
assert.strictEqual(core.activeRecordingAssetPath(project), "recordings/recording-1/screen.mp4");
assert.strictEqual(core.canOpenEditorProject(project, {}, false), false, "a manifest path is not proof that its MP4 exists");
assert.strictEqual(core.canOpenEditorProject(project, { "recordings/recording-1/screen.mp4": true }, false), true);
assert.strictEqual(core.canOpenEditorProject(project, {}, true), true, "a valid in-memory Blob may open the editor");
var missingAssetProject = JSON.parse(JSON.stringify(project));
missingAssetProject.recordings[0].assets.screen = null;
assert.strictEqual(core.activeRecordingAssetPath(missingAssetProject), "");
assert.strictEqual(core.canOpenEditorProject(missingAssetProject, {}, false), false, "an empty project cannot open the editor");

console.log("editor core tests ok");
