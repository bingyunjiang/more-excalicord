"use strict";

var assert = require("assert");
var camera = require("../src/smart-camera-core.js");

var track = camera.planFromEvents([
  { type: "frame-change", t: 1, frameId: "frame-a" },
  { type: "pointer", t: 1.2, x: 0.1, y: 0.1, insideCanvas: true },
  { type: "pointer", t: 2, x: 0.8, y: 0.7, insideCanvas: true },
  { type: "pointer", t: 2.1, x: 0.81, y: 0.71, insideCanvas: true },
  { type: "click", t: 3, x: 0.2, y: 0.3, insideCanvas: true },
], { durationMs: 8000, strength: "medium" });

assert.strictEqual(track[0].timeMs, 0);
assert.ok(track.some(function (item) { return item.source === "auto-frame"; }));
assert.ok(track.some(function (item) { return item.source === "auto-pointer"; }));
assert.ok(track.some(function (item) { return item.source === "auto-click"; }));
assert.ok(track.some(function (item) { return item.source === "auto-idle"; }));
assert.ok(track.length < 8, "nearby pointer samples should be coalesced");

var focused = track.find(function (item) { return item.source === "auto-pointer"; });
assert.ok(focused.x <= 1 - 0.5 / focused.scale);
assert.ok(focused.y <= 1 - 0.5 / focused.scale);

var beforeTransition = camera.evaluate([
  { timeMs: 0, x: 0.5, y: 0.5, scale: 1, transitionMs: 0 },
  { timeMs: 1000, x: 0.7, y: 0.7, scale: 1.5, transitionMs: 400 },
], 500);
assert.strictEqual(beforeTransition.scale, 1);
var duringTransition = camera.evaluate([
  { timeMs: 0, x: 0.5, y: 0.5, scale: 1, transitionMs: 0 },
  { timeMs: 1000, x: 0.7, y: 0.7, scale: 1.5, transitionMs: 400 },
], 800);
assert.ok(duringTransition.scale > 1 && duringTransition.scale < 1.5);

var merged = camera.mergeManualKeyframes(track, [
  { timeMs: 3000, x: 0.5, y: 0.5, scale: 1.1, transitionMs: 200 },
]);
assert.strictEqual(merged.filter(function (item) { return item.timeMs === 3000; }).length, 1);
assert.strictEqual(merged.find(function (item) { return item.timeMs === 3000; }).locked, true);

var crop = camera.cropAt([{ timeMs: 0, x: 0.9, y: 0.9, scale: 2 }], 0, 1920, 1080, 16 / 9);
assert.ok(crop.x + crop.width <= 1920.001);
assert.ok(crop.y + crop.height <= 1080.001);

console.log("smart camera core tests ok");
