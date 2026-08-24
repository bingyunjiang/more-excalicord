"use strict";

const assert = require("assert");
const render = require("../server/render-core.js");

assert.strictEqual(render.safeRelativePath("recordings/session/video.mp4"), "recordings/session/video.mp4");
assert.strictEqual(render.safeRelativePath("../outside.mp4"), "");
assert.strictEqual(render.safeRelativePath("/tmp/outside.mp4"), "");
assert.strictEqual(render.isProjectRecordingAssetPath("recordings/session/video.mp4"), true);
assert.strictEqual(render.isProjectRecordingAssetPath("excalicord-20260818-091336.mp4"), true, "legacy root recording remains readable without moving it");
assert.strictEqual(render.isProjectRecordingAssetPath("assets/unrelated.mp4"), false);

const manifest = {
  schemaVersion: 1,
  projectId: "project-test",
  editId: "edit-1",
  source: {
    durationMs: 10000,
    ratio: "16:9",
    legacyComposite: false,
    assets: {
      screen: { path: "recordings/session/video.mp4" },
      webcam: { path: "recordings/session/webcam.mp4" },
    },
    embeddedEvents: [
      { type: "pointer", timeMs: 1000, x: 0.2, y: 0.3, insideCanvas: true },
      { type: "click", timeMs: 5000, x: 0.7, y: 0.6, insideCanvas: true },
    ],
  },
  timeMap: {
    sourceDurationMs: 10000,
    outputDurationMs: 8000,
    segments: [
      { sourceStartMs: 0, sourceEndMs: 2000, outputStartMs: 0, outputEndMs: 2000, rate: 1, deleted: false },
      { sourceStartMs: 2000, sourceEndMs: 4000, outputStartMs: 2000, outputEndMs: 2000, rate: 1, deleted: true },
      { sourceStartMs: 4000, sourceEndMs: 10000, outputStartMs: 2000, outputEndMs: 8000, rate: 1, deleted: false },
    ],
  },
  tracks: {
    subtitles: { segments: [{ id: "sub-1", startMs: 1000, endMs: 5000, text: "跨过剪切" }] },
    camera: { enabled: true, keyframes: [
      { timeMs: 0, x: 0.5, y: 0.5, scale: 1 },
      { timeMs: 6000, x: 0.7, y: 0.6, scale: 1.4, transitionMs: 400 },
    ] },
    cursor: { visible: true, clickEffect: true }, webcam: { visible: true, position: "bottom-right" }, audio: { volume: 0.8 },
  },
  appearance: { background: "#17191d", padding: 20 },
};

const plan = render.createRenderPlan(manifest, { width: 1920, height: 1080, fps: 30, hasAudio: true, durationMs: 10000 });
assert.strictEqual(plan.retained.length, 2);
assert.strictEqual(plan.outputDurationMs, 8000);
assert.strictEqual(plan.subtitles.length, 2, "subtitle crossing a cut must split into retained fragments");
assert.strictEqual(plan.subtitles[1].startMs, 2000);
assert.strictEqual(plan.camera[1].timeMs, 4000);
assert.strictEqual(plan.cursor.events.length, 2);
assert.strictEqual(plan.cursor.events[1].timeMs, 3000, "cursor time must follow non-destructive time map");
assert.strictEqual(plan.webcam.visible, true);
assert.deepStrictEqual(render.atempoFilters(4), ["atempo=2", "atempo=2"]);
assert.deepStrictEqual(render.atempoFilters(0.25), ["atempo=0.5", "atempo=0.5"]);
const graph = render.buildFilterGraph(plan, 1);
assert.ok(graph.graph.includes("concat=n=2:v=1:a=1"));
assert.ok(graph.graph.includes("zoompan"));
assert.ok(graph.graph.includes("overlay=0:0"));
assert.ok(graph.graph.includes("volume=0.8000"));
const args = render.buildFfmpegArgs(plan, "/tmp/source.mp4", ["/tmp/sub-1.png", "/tmp/sub-2.png"], "/tmp/out.mp4");
assert.ok(args.includes("h264_videotoolbox"));
assert.ok(args.includes("-allow_sw"));
assert.strictEqual(args[args.length - 1], "/tmp/out.mp4");
const softwareArgs = render.buildFfmpegArgs(plan, "/tmp/source.mp4", [], "/tmp/out.mp4", {}, { videoEncoder: "libx264" });
assert.ok(softwareArgs.includes("libx264"));
assert.ok(softwareArgs.includes("veryfast"));
const layeredArgs = render.buildFfmpegArgs(plan, "/tmp/source.mp4", ["/tmp/sub-1.png", "/tmp/sub-2.png"], "/tmp/out.mp4", {
  cursorPath: "/tmp/cursor.png",
  clickPath: "/tmp/click.png",
  webcamPath: "/tmp/webcam.mp4",
});
const layeredGraph = layeredArgs[layeredArgs.indexOf("-filter_complex") + 1];
assert.ok(layeredGraph.includes("[wcat]scale="));
assert.ok(layeredGraph.includes("[cursorasset]overlay="));
assert.ok(layeredGraph.includes("[click0]overlay="));

const threeDManifest = JSON.parse(JSON.stringify(manifest));
threeDManifest.tracks.camera.motionMode = "3d";
threeDManifest.tracks.camera.strength = "medium";
const threeDPlan = render.createRenderPlan(threeDManifest, { width: 1920, height: 1080, fps: 30, hasAudio: true, durationMs: 10000 });
assert.strictEqual(threeDPlan.cameraMotionMode, "3d");
assert.ok(Math.abs(threeDPlan.camera[1].tiltX) > 0 || Math.abs(threeDPlan.camera[1].tiltY) > 0);
const threeDGraph = render.buildFilterGraph(threeDPlan, 1).graph;
assert.ok(threeDGraph.includes("perspective="));
assert.ok(threeDGraph.includes("eval=frame"));

console.log("render core tests ok");
