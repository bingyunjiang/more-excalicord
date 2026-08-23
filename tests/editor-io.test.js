"use strict";

var assert = require("assert");
var io = require("../src/editor-io.js");

var parsed = io.parseSubtitleText("WEBVTT\n\n00:00:01.000 --> 00:00:02.250\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句\n");
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].startMs, 1000);
assert.strictEqual(parsed[0].endMs, 2250);
assert.strictEqual(parsed[1].text, "第二句");
assert.ok(io.subtitlesToSrt(parsed).indexOf("00:00:01,000 --> 00:00:02,250") >= 0);
assert.ok(io.subtitlesToVtt(parsed).indexOf("WEBVTT") === 0);

var transcript = io.normalizeTranscript({
  language: "zh-CN",
  segments: [{
    text: "你好，世界。",
    start: 0,
    end: 2,
    words: [
      { word: "你好，", start: 0, end: 0.8 },
      { word: "世界。", start: 0.9, end: 2 },
    ],
  }],
});
assert.strictEqual(transcript.segments[0].words[1].endMs, 2000);
var subtitles = io.transcriptToSubtitles(transcript, { maxChars: 20 });
assert.strictEqual(subtitles.length, 1);
assert.strictEqual(subtitles[0].text, "你好，世界。");
var correctedSubtitles = io.transcriptToSubtitles({
  language: "zh-CN",
  segments: [{
    id: "corrected",
    text: "这里改成校正版字幕。",
    textEdited: true,
    startMs: 1000,
    endMs: 4000,
    words: [{ text: "原始识别", startMs: 1000, endMs: 4000 }],
  }],
});
assert.strictEqual(correctedSubtitles[0].text, "这里改成校正版字幕。");
assert.strictEqual(correctedSubtitles[0].source, "transcript-corrected");
assert.strictEqual(io.safeExportName("项目 / demo", "mp4"), "demo-final.mp4");

console.log("editor io tests ok");
