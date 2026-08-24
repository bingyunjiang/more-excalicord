(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExcalicordSmartCameraCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STRENGTHS = {
    gentle: { scale: 1.22, transitionMs: 520, deadZone: 0.10 },
    medium: { scale: 1.38, transitionMs: 430, deadZone: 0.08 },
    strong: { scale: 1.58, transitionMs: 340, deadZone: 0.06 },
  };
  var SPEEDS = {
    slow: 1.35,
    standard: 1,
    fast: 0.72,
  };

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function eventTimeMs(event) {
    if (Number.isFinite(Number(event && event.timeMs))) return Math.max(0, Number(event.timeMs));
    if (Number.isFinite(Number(event && event.atMs))) return Math.max(0, Number(event.atMs));
    return Math.max(0, finite(event && event.t, 0) * 1000);
  }

  function strengthOptions(value) {
    return STRENGTHS[value] || STRENGTHS.gentle;
  }

  function safeCenter(value, scale) {
    var half = 0.5 / Math.max(1, scale);
    return clamp(finite(value, 0.5), half, 1 - half);
  }

  function normalizeKeyframe(raw, index) {
    var source = raw && typeof raw === "object" ? raw : {};
    var timeMs = eventTimeMs(source);
    var scale = clamp(finite(source.scale, 1), 1, 4);
    return {
      id: typeof source.id === "string" && source.id ? source.id : "camera-" + String(index + 1),
      timeMs: timeMs,
      x: safeCenter(source.x, scale),
      y: safeCenter(source.y, scale),
      scale: scale,
      transitionMs: clamp(finite(source.transitionMs, 420), 0, 3000),
      source: typeof source.source === "string" ? source.source : "manual",
      frameId: typeof source.frameId === "string" ? source.frameId : "",
      locked: source.locked === true,
    };
  }

  function normalizeTrack(track) {
    var frames = (Array.isArray(track) ? track : []).map(normalizeKeyframe);
    frames.sort(function (a, b) { return a.timeMs - b.timeMs; });
    var output = [];
    frames.forEach(function (frame) {
      var previous = output[output.length - 1];
      if (previous && Math.abs(previous.timeMs - frame.timeMs) < 1) {
        output[output.length - 1] = frame;
      } else {
        output.push(frame);
      }
    });
    return output;
  }

  function distance(a, b) {
    var dx = finite(a && a.x, 0.5) - finite(b && b.x, 0.5);
    var dy = finite(a && a.y, 0.5) - finite(b && b.y, 0.5);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function planFromEvents(events, options) {
    var config = options && typeof options === "object" ? options : {};
    var strength = typeof config.strength === "string" ? config.strength : "gentle";
    var preset = strengthOptions(strength);
    var speed = SPEEDS[config.speed] || SPEEDS.standard;
    var transitionMs = Math.max(120, Math.round(preset.transitionMs * speed));
    var durationMs = Math.max(0, finite(config.durationMs, 0));
    var minIntervalMs = Math.max(150, finite(config.minIntervalMs, 650));
    var frameSettleMs = Math.max(0, finite(config.frameSettleMs, 700));
    var idleReturnMs = Math.max(1000, finite(config.idleReturnMs, 3600));
    var maxKeyframes = Math.max(2, Math.min(5000, finite(config.maxKeyframes, 1200)));
    var slideFocus = config.slideFocus !== false;
    var mouseFocus = config.mouseFocus !== false;
    var clickFocus = config.clickFocus !== false;
    var typingFocus = config.typingFocus !== false;
    var allowOutsideCanvas = config.allowOutsideCanvas === true;
    var list = (Array.isArray(events) ? events : []).filter(function (event) {
      return event && (event.type === "pointer" || event.type === "click" || event.type === "keyboard" || event.type === "frame-change");
    }).map(function (event) {
      return Object.assign({}, event, { timeMs: eventTimeMs(event) });
    }).sort(function (a, b) { return a.timeMs - b.timeMs; });
    if (!durationMs && list.length) durationMs = list[list.length - 1].timeMs;

    var track = [normalizeKeyframe({
      id: "camera-start",
      timeMs: 0,
      x: 0.5,
      y: 0.5,
      scale: 1,
      transitionMs: 0,
      source: "start",
      frameId: typeof config.initialFrameId === "string" ? config.initialFrameId : "",
    }, 0)];
    var lastFocus = track[0];
    var lastFrameAt = -Infinity;
    var currentFrameId = track[0].frameId;

    function maybeReturnToOverview(nextTimeMs) {
      if (lastFocus.scale <= 1 || nextTimeMs - lastFocus.timeMs < idleReturnMs) return;
      var at = Math.min(nextTimeMs - 120, lastFocus.timeMs + idleReturnMs);
      if (at <= lastFocus.timeMs) return;
      var overview = normalizeKeyframe({
        timeMs: at,
        x: 0.5,
        y: 0.5,
        scale: 1,
        transitionMs: transitionMs,
        source: "auto-idle",
        frameId: currentFrameId,
      }, track.length);
      track.push(overview);
      lastFocus = overview;
    }

    list.some(function (event) {
      if (track.length >= maxKeyframes) return true;
      maybeReturnToOverview(event.timeMs);
      if (event.type === "frame-change") {
        if (!slideFocus) return false;
        currentFrameId = typeof event.frameId === "string" ? event.frameId : currentFrameId;
        lastFrameAt = event.timeMs;
        var frameKey = normalizeKeyframe({
          timeMs: event.timeMs,
          x: 0.5,
          y: 0.5,
          scale: 1,
          transitionMs: transitionMs,
          source: "auto-frame",
          frameId: currentFrameId,
        }, track.length);
        track.push(frameKey);
        lastFocus = frameKey;
        return false;
      }
      var isClick = event.type === "click";
      var isTyping = event.type === "keyboard";
      if (isClick && !clickFocus) return false;
      if (isTyping && !typingFocus) return false;
      if (!isClick && !isTyping && !mouseFocus) return false;
      if (event.insideCanvas === false && !allowOutsideCanvas) return false;
      if (event.timeMs - lastFrameAt < frameSettleMs) return false;
      var target = { x: clamp(finite(event.x, 0.5), 0, 1), y: clamp(finite(event.y, 0.5), 0, 1) };
      if (!isClick && event.timeMs - lastFocus.timeMs < (isTyping ? Math.max(minIntervalMs, 900) : minIntervalMs)) return false;
      if (!isClick && !isTyping && lastFocus.scale > 1 && distance(target, lastFocus) < preset.deadZone) return false;
      var focus = normalizeKeyframe({
        timeMs: event.timeMs,
        x: target.x,
        y: target.y,
        scale: preset.scale,
        transitionMs: isClick ? Math.max(180, transitionMs - 90) : (isTyping ? Math.max(220, transitionMs - 40) : transitionMs),
        source: isClick ? "auto-click" : (isTyping ? "auto-typing" : "auto-pointer"),
        frameId: currentFrameId,
      }, track.length);
      track.push(focus);
      lastFocus = focus;
      return false;
    });
    maybeReturnToOverview(durationMs + 120);
    return normalizeTrack(track.slice(0, maxKeyframes));
  }

  function mergeManualKeyframes(autoTrack, manualTrack) {
    var automatic = normalizeTrack(autoTrack).filter(function (frame) { return !frame.locked; });
    var manual = normalizeTrack(manualTrack).map(function (frame) {
      frame.source = "manual";
      frame.locked = true;
      return frame;
    });
    manual.forEach(function (frame) {
      automatic = automatic.filter(function (candidate) {
        return Math.abs(candidate.timeMs - frame.timeMs) > Math.max(180, frame.transitionMs / 2);
      });
    });
    return normalizeTrack(automatic.concat(manual));
  }

  function smoothstep(value) {
    var t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function evaluate(track, timeMs) {
    var frames = normalizeTrack(track);
    if (!frames.length) return { x: 0.5, y: 0.5, scale: 1, source: "default" };
    var time = Math.max(0, finite(timeMs, 0));
    var nextIndex = frames.findIndex(function (frame) { return frame.timeMs > time; });
    if (nextIndex < 0) return clone(frames[frames.length - 1]);
    if (nextIndex === 0) return clone(frames[0]);
    var before = frames[nextIndex - 1];
    var after = frames[nextIndex];
    var transition = Math.min(after.transitionMs, Math.max(0, after.timeMs - before.timeMs));
    var transitionStart = after.timeMs - transition;
    if (!transition || time <= transitionStart) return clone(before);
    var ratio = smoothstep((time - transitionStart) / transition);
    return {
      id: after.id,
      timeMs: time,
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
      scale: before.scale + (after.scale - before.scale) * ratio,
      transitionMs: after.transitionMs,
      source: after.source,
      frameId: after.frameId,
      locked: after.locked,
    };
  }

  function cropAt(track, timeMs, sourceWidth, sourceHeight, outputRatio) {
    var camera = evaluate(track, timeMs);
    var width = Math.max(1, finite(sourceWidth, 1));
    var height = Math.max(1, finite(sourceHeight, 1));
    var ratio = finite(outputRatio, width / height);
    var cropWidth = width / Math.max(1, camera.scale);
    var cropHeight = cropWidth / ratio;
    if (cropHeight > height / Math.max(1, camera.scale)) {
      cropHeight = height / Math.max(1, camera.scale);
      cropWidth = cropHeight * ratio;
    }
    var centerX = safeCenter(camera.x, width / cropWidth) * width;
    var centerY = safeCenter(camera.y, height / cropHeight) * height;
    return {
      x: clamp(centerX - cropWidth / 2, 0, width - cropWidth),
      y: clamp(centerY - cropHeight / 2, 0, height - cropHeight),
      width: cropWidth,
      height: cropHeight,
      camera: camera,
    };
  }

  return {
    STRENGTHS: clone(STRENGTHS),
    SPEEDS: clone(SPEEDS),
    normalizeTrack: normalizeTrack,
    planFromEvents: planFromEvents,
    mergeManualKeyframes: mergeManualKeyframes,
    evaluate: evaluate,
    cropAt: cropAt,
  };
});
