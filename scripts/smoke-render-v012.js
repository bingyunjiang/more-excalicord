#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const render = require("../server/render-core.js");

const ffmpeg = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const ffprobe = fs.existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "more-excalicord-render-"));
const source = path.join(root, "source.mp4");
const webcam = path.join(root, "webcam.mp4");
const output = path.join(root, "final.mp4");
const captionConfig = path.join(root, "captions.json");
const captionDir = path.join(root, "captions");
const pointerDir = path.join(root, "pointer");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || command + " failed").trim());
  return result.stdout.trim();
}

function runFfmpeg(args, fallbackArgs) {
  try {
    return run(ffmpeg, args);
  } catch (error) {
    if (!fallbackArgs || !/h264_videotoolbox|compression session|hardware encoder|allow_sw/i.test(error.message || "")) {
      throw error;
    }
    return run(ffmpeg, fallbackArgs);
  }
}

runFfmpeg(
  ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "3000k", "-c:a", "aac", "-shortest", "-y", source],
  ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-shortest", "-y", source],
);
runFfmpeg(
  ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "1000k", "-an", "-y", webcam],
  ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-an", "-y", webcam],
);

const manifest = {
  schemaVersion: 1,
  projectId: "smoke-project",
  editId: "smoke-edit",
  source: {
    durationMs: 4000,
    ratio: "16:9",
    legacyComposite: false,
    assets: {
      screen: { path: "recordings/smoke/source.mp4" },
      webcam: { path: "recordings/smoke/webcam.mp4" },
    },
    embeddedEvents: Array.from({ length: 80 }, (_, index) => ({
      type: "pointer",
      timeMs: 120 + index * 46,
      x: 0.5 + Math.sin(index / 8) * 0.32,
      y: 0.5 + Math.cos(index / 9) * 0.24,
      insideCanvas: true,
    })).concat([{ type: "click", timeMs: 1900, x: 0.66, y: 0.55, insideCanvas: true }]),
  },
  timeMap: {
    sourceDurationMs: 4000,
    outputDurationMs: 3600,
    segments: [
      { sourceStartMs: 0, sourceEndMs: 1200, outputStartMs: 0, outputEndMs: 1200, rate: 1, deleted: false },
      { sourceStartMs: 1200, sourceEndMs: 1600, outputStartMs: 1200, outputEndMs: 1200, rate: 1, deleted: true },
      { sourceStartMs: 1600, sourceEndMs: 4000, outputStartMs: 1200, outputEndMs: 3600, rate: 1, deleted: false },
    ],
  },
  tracks: {
    subtitles: { segments: [{ id: "caption", startMs: 1700, endMs: 3300, text: "字幕、光标与摄像头导出测试" }] },
    camera: { enabled: true, keyframes: [
      { timeMs: 0, x: 0.5, y: 0.5, scale: 1, transitionMs: 0 },
      { timeMs: 2300, x: 0.65, y: 0.55, scale: 1.25, transitionMs: 350 },
    ] },
    cursor: { visible: true, clickEffect: true, size: 1.1, smoothing: 0.45 },
    webcam: { visible: true, position: "bottom-right", scale: 0.22, mirror: true },
    audio: { volume: 0.65, fadeInMs: 150, fadeOutMs: 180 },
  },
  appearance: { background: "#20242b", padding: 28, cornerRadius: 18, shadow: true },
};

const plan = render.createRenderPlan(manifest, { width: 960, height: 540, fps: 30, hasAudio: true, durationMs: 4000 });
fs.writeFileSync(captionConfig, JSON.stringify({ captions: plan.subtitles }), "utf8");
const captionResult = JSON.parse(run("python3", [path.join(__dirname, "../server/render_caption_overlays.py"), captionConfig, captionDir, String(plan.width), String(plan.height)]));
const pointerResult = JSON.parse(run("python3", [path.join(__dirname, "../server/render_caption_overlays.py"), "--pointer-assets", pointerDir, String(Math.round(42 * plan.cursor.size))]));
const args = render.buildFfmpegArgs(plan, source, captionResult.files, output, {
  cursorPath: pointerResult.files[0],
  clickPath: pointerResult.files[1],
  webcamPath: webcam,
});
try {
  run(ffmpeg, args);
} catch (error) {
  if (!/h264_videotoolbox|compression session|hardware encoder|allow_sw/i.test(error.message || "")) throw error;
  run(ffmpeg, render.buildFfmpegArgs(plan, source, captionResult.files, output, {
    cursorPath: pointerResult.files[0],
    clickPath: pointerResult.files[1],
    webcamPath: webcam,
  }, { videoEncoder: "libx264" }));
}
const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", output]));
process.stdout.write(JSON.stringify({ ok: true, root, output, probe: probe.format, plan: {
  outputDurationMs: plan.outputDurationMs,
  subtitleCount: plan.subtitles.length,
  cursorEventCount: plan.cursor.events.length,
  clickCount: plan.cursor.clicks.length,
  webcamVisible: plan.webcam.visible,
} }, null, 2) + "\n");
