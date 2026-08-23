"use strict";

var assert = require("assert");
var rough = require("../src/rough-cut-core.js");

var transcript = {
  language: "zh-CN",
  durationMs: 15000,
  segments: [
    {
      id: "s1",
      text: "今天介绍 Excalidraw 自动缩放",
      startMs: 2000,
      endMs: 5000,
      words: [
        { text: "今天", startMs: 2000, endMs: 2400 },
        { text: "介绍", startMs: 2500, endMs: 2900 },
        { text: "Excalidraw", startMs: 3000, endMs: 3800 },
        { text: "自动缩放", startMs: 3900, endMs: 5000 }
      ]
    },
    {
      id: "s2",
      text: "嗯 不对 我重说",
      startMs: 9000,
      endMs: 10500,
      words: [
        { text: "嗯", startMs: 9000, endMs: 9200 },
        { text: "不对", startMs: 9300, endMs: 9700 },
        { text: "我重说", startMs: 9800, endMs: 10500 }
      ]
    },
    {
      id: "s3",
      text: "这里设置 1.5 倍缩放",
      startMs: 10800,
      endMs: 12500,
      words: [
        { text: "这里", startMs: 10800, endMs: 11100 },
        { text: "设置", startMs: 11200, endMs: 11500 },
        { text: "1.5", startMs: 11600, endMs: 11900 },
        { text: "倍缩放", startMs: 12000, endMs: 12500 }
      ]
    }
  ]
};

var result = rough.analyzeTranscript(transcript, { longSilenceMs: 3000, targetSilenceMs: 800 });
assert.strictEqual(result.ok, true);
assert.ok(result.suggestions.some(function (item) { return item.category === "lead-in" && item.type === "cut"; }));
assert.ok(result.suggestions.some(function (item) { return item.category === "long-silence" && item.type === "cut"; }));
assert.ok(result.suggestions.some(function (item) { return item.category === "filler" && item.requiresReview; }));
assert.ok(result.suggestions.some(function (item) { return item.category === "restart-cue" && item.requiresReview; }));
assert.ok(result.suggestions.some(function (item) { return item.category === "tail-out" && item.type === "cut"; }));
assert.ok(result.summary.directCuts >= 3);

var telemetryAware = rough.analyzeTranscript(transcript, {
  longSilenceMs: 3000,
  targetSilenceMs: 800,
  events: [
    { type: "pointer", timeMs: 7000, x: 0.4, y: 0.4 },
    { type: "click", timeMs: 7100, x: 0.4, y: 0.4 },
    { type: "frame-change", timeMs: 7200, frameId: "frame-2" }
  ]
});
var activeSilence = telemetryAware.suggestions.find(function (item) {
  return item.category === "long-silence" && item.startMs < 7100 && item.endMs > 7100;
});
assert.ok(activeSilence);
assert.strictEqual(activeSilence.requiresReview, true);
assert.ok(activeSilence.activitySignals.indexOf("Frame 切换") !== -1);
assert.ok(activeSilence.activitySignals.indexOf("点击操作") !== -1);
assert.ok(telemetryAware.summary.directCuts < result.summary.directCuts);

var invalid = rough.validateTranscript({ segments: [{ text: "没有词级时间" }] });
assert.strictEqual(invalid.valid, false);

assert.ok(rough.informationSignals("这里设置 1.5 kW，必须保留").length >= 2);
assert.ok(rough.similarity("这里介绍项目结构", "这里介绍一下项目结构") > 0.5);

var audit = rough.auditAcceptedSuggestions(transcript, [{
  id: "accepted-cut",
  type: "cut",
  category: "possible-duplicate",
  startMs: 10800,
  endMs: 12500,
  status: "accepted"
}]);
assert.strictEqual(audit.valid, false);
assert.ok(audit.findings[0].signals.indexOf("数字") !== -1);

var visualAudit = rough.auditAcceptedSuggestions(transcript, [{
  id: "visual-cut",
  type: "cut",
  category: "long-silence",
  startMs: 6000,
  endMs: 8000,
  status: "accepted"
}], { events: [{ type: "frame-change", timeMs: 7000, frameId: "frame-2" }] });
assert.strictEqual(visualAudit.valid, false);
assert.ok(visualAudit.findings.some(function (item) { return item.signals.indexOf("Frame 切换") !== -1; }));

console.log("rough cut core tests ok");
