(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExcalicordRoughCutCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_FILLERS = ["嗯", "呃", "额", "啊", "那个", "这个", "就是", "然后呢"];
  var RESTART_CUES = ["不对", "等一下", "我重说", "重新说", "重来", "再来一遍", "又讲偏了"];

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function makeId(prefix, index) {
    return String(prefix || "suggestion") + "-" + String(index + 1);
  }

  function cleanText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function normalizedComparableText(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]—-]/g, "");
  }

  function normalizeWord(raw, fallbackId) {
    if (!isObject(raw)) return null;
    var text = cleanText(raw.text != null ? raw.text : raw.word);
    var startMs = finite(raw.startMs, finite(raw.start, NaN) * 1000);
    var endMs = finite(raw.endMs, finite(raw.end, NaN) * 1000);
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId,
      text: text,
      startMs: Math.max(0, startMs),
      endMs: Math.max(0, endMs),
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    };
  }

  function normalizeSegment(raw, index) {
    if (!isObject(raw)) return null;
    var words = (Array.isArray(raw.words) ? raw.words : []).map(function (word, wordIndex) {
      return normalizeWord(word, "word-" + String(index + 1) + "-" + String(wordIndex + 1));
    }).filter(Boolean);
    words.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    var text = cleanText(raw.text || words.map(function (word) { return word.text; }).join(""));
    var startMs = finite(raw.startMs, finite(raw.start, words.length ? words[0].startMs / 1000 : NaN) * 1000);
    var endMs = finite(raw.endMs, finite(raw.end, words.length ? words[words.length - 1].endMs / 1000 : NaN) * 1000);
    if (!text || !words.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : "segment-" + String(index + 1),
      text: text,
      startMs: Math.max(0, startMs),
      endMs: Math.max(0, endMs),
      speaker: typeof raw.speaker === "string" ? raw.speaker : "speaker-1",
      words: words,
    };
  }

  function normalizeTranscript(raw) {
    var source = isObject(raw) ? raw : {};
    var segments = (Array.isArray(source.segments) ? source.segments : []).map(normalizeSegment).filter(Boolean);
    segments.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    var words = [];
    segments.forEach(function (segment) {
      segment.words.forEach(function (word) {
        words.push(Object.assign({}, word, { segmentId: segment.id, speaker: segment.speaker }));
      });
    });
    return {
      language: typeof source.language === "string" ? source.language : "zh-CN",
      durationMs: Math.max(0, finite(source.durationMs, segments.length ? segments[segments.length - 1].endMs : 0)),
      segments: segments,
      words: words,
    };
  }

  function validateTranscript(raw) {
    var transcript = normalizeTranscript(raw);
    var errors = [];
    var warnings = [];
    if (!transcript.segments.length) errors.push("缺少带词级时间戳的逐字稿");
    var previousEnd = 0;
    transcript.words.forEach(function (word) {
      if (word.startMs < previousEnd - 5) warnings.push("词级时间戳存在重叠：" + word.text);
      previousEnd = Math.max(previousEnd, word.endMs);
    });
    if (transcript.durationMs < previousEnd) transcript.durationMs = previousEnd;
    return { valid: errors.length === 0, errors: errors, warnings: warnings, transcript: transcript };
  }

  function includesAny(text, values) {
    return values.some(function (value) { return text.indexOf(value) !== -1; });
  }

  function informationSignals(text) {
    var value = cleanText(text);
    var signals = [];
    if (/\d/.test(value)) signals.push("数字");
    if (/[A-Za-z][A-Za-z0-9._+-]{1,}/.test(value)) signals.push("英文或术语");
    if (/%|％|℃|°C|kW|MW|V|A|mm|cm|kg|秒|分钟|小时/.test(value)) signals.push("单位");
    if (/因为|所以|但是|不过|如果|只有|必须|例如|比如|步骤|方法|原因|结果/.test(value)) signals.push("逻辑或方法信息");
    return signals;
  }

  function coveredSegments(transcript, startMs, endMs) {
    return transcript.segments.filter(function (segment) {
      return segment.endMs > startMs && segment.startMs < endMs;
    });
  }

  function recordingEventTimeMs(event) {
    if (!isObject(event)) return NaN;
    if (Number.isFinite(Number(event.timeMs))) return Math.max(0, Number(event.timeMs));
    if (Number.isFinite(Number(event.tMs))) return Math.max(0, Number(event.tMs));
    if (Number.isFinite(Number(event.t))) return Math.max(0, Number(event.t) * 1000);
    return NaN;
  }

  function activitySignals(events, startMs, endMs) {
    var overlapping = (Array.isArray(events) ? events : []).filter(function (event) {
      var timeMs = recordingEventTimeMs(event);
      return Number.isFinite(timeMs) && timeMs >= startMs && timeMs < endMs;
    });
    var signals = [];
    if (overlapping.some(function (event) { return event.type === "frame-change"; })) signals.push("Frame 切换");
    if (overlapping.some(function (event) { return event.type === "click"; })) signals.push("点击操作");
    if (overlapping.some(function (event) { return event.type === "pointer"; })) signals.push("指针演示");
    if (overlapping.some(function (event) {
      return ["draw", "annotation", "element-change", "scene-change", "keyboard"].indexOf(event.type) !== -1;
    })) signals.push("白板编辑");
    return { count: overlapping.length, signals: signals, events: overlapping };
  }

  function enrichSuggestion(transcript, suggestion, events) {
    var segments = coveredSegments(transcript, suggestion.startMs, suggestion.endMs);
    var text = segments.map(function (segment) { return segment.text; }).join(" ");
    var signals = informationSignals(text);
    var activity = activitySignals(events, suggestion.startMs, suggestion.endMs);
    var enriched = Object.assign({}, suggestion, {
      coveredSegmentIds: segments.map(function (segment) { return segment.id; }),
      coveredText: text,
      informationSignals: signals,
      activitySignals: activity.signals,
      activityEventCount: activity.count,
      status: "pending",
    });
    if (signals.length && suggestion.type === "cut" && suggestion.category !== "lead-in" && suggestion.category !== "tail-out") {
      enriched.requiresReview = true;
      enriched.confidence = Math.min(finite(enriched.confidence, 0.5), 0.55);
      enriched.note = "该区间包含" + signals.join("、") + "，接受前必须做信息损失审计。";
    }
    if (activity.signals.length && suggestion.type === "cut") {
      enriched.requiresReview = true;
      enriched.confidence = Math.min(finite(enriched.confidence, 0.5), 0.5);
      enriched.note = "该区间包含" + activity.signals.join("、") + "；静音不等于无画面内容，必须定位预览后再决定。";
    }
    return enriched;
  }

  function bigrams(text) {
    var value = normalizedComparableText(text);
    var output = {};
    for (var i = 0; i < value.length - 1; i += 1) output[value.slice(i, i + 2)] = true;
    return output;
  }

  function similarity(a, b) {
    var left = bigrams(a);
    var right = bigrams(b);
    var keys = Object.keys(left).concat(Object.keys(right));
    var union = {};
    var intersection = 0;
    keys.forEach(function (key) { union[key] = true; });
    Object.keys(left).forEach(function (key) { if (right[key]) intersection += 1; });
    var total = Object.keys(union).length;
    return total ? intersection / total : 0;
  }

  function analyzeTranscript(raw, options) {
    var checked = validateTranscript(raw);
    if (!checked.valid) return { ok: false, errors: checked.errors, warnings: checked.warnings, suggestions: [] };
    var transcript = checked.transcript;
    var config = isObject(options) ? options : {};
    var leadThresholdMs = Math.max(500, finite(config.leadThresholdMs, 1500));
    var tailThresholdMs = Math.max(500, finite(config.tailThresholdMs, 1500));
    var longSilenceMs = Math.max(1000, finite(config.longSilenceMs, 3000));
    var targetSilenceMs = Math.max(200, Math.min(longSilenceMs, finite(config.targetSilenceMs, 800)));
    var fillers = Array.isArray(config.fillers) ? config.fillers.map(cleanText).filter(Boolean) : DEFAULT_FILLERS;
    var events = Array.isArray(config.events) ? config.events : [];
    var suggestions = [];
    var firstWord = transcript.words[0];
    var lastWord = transcript.words[transcript.words.length - 1];

    if (firstWord.startMs >= leadThresholdMs) {
      suggestions.push({
        type: "cut",
        category: "lead-in",
        startMs: 0,
        endMs: Math.max(0, firstWord.startMs - 120),
        label: "清理开头准备时间",
        reason: "第一处实际口播前有 " + (firstWord.startMs / 1000).toFixed(1) + " 秒空白",
        confidence: 0.98,
        requiresReview: false,
      });
    }

    for (var i = 1; i < transcript.words.length; i += 1) {
      var previous = transcript.words[i - 1];
      var current = transcript.words[i];
      var gap = current.startMs - previous.endMs;
      if (gap >= longSilenceMs) {
        var trim = Math.max(0, gap - targetSilenceMs);
        suggestions.push({
          type: "cut",
          category: "long-silence",
          startMs: previous.endMs + targetSilenceMs / 2,
          endMs: current.startMs - targetSilenceMs / 2,
          label: "缩短长停顿",
          reason: "检测到 " + (gap / 1000).toFixed(1) + " 秒停顿，建议保留 " + (targetSilenceMs / 1000).toFixed(1) + " 秒",
          confidence: trim > 0 ? 0.94 : 0.5,
          requiresReview: false,
        });
      }
    }

    transcript.words.forEach(function (word) {
      if (fillers.indexOf(normalizedComparableText(word.text)) === -1) return;
      suggestions.push({
        type: "review",
        category: "filler",
        startMs: word.startMs,
        endMs: word.endMs,
        label: "检查口头填充词",
        reason: "检测到“" + word.text + "”；句内删除可能切字，需试听后决定",
        confidence: 0.72,
        requiresReview: true,
      });
    });

    transcript.segments.forEach(function (segment, index) {
      if (includesAny(segment.text, RESTART_CUES)) {
        var previous = index > 0 ? transcript.segments[index - 1] : segment;
        suggestions.push({
          type: "review",
          category: "restart-cue",
          startMs: previous.startMs,
          endMs: segment.endMs,
          label: "检查作废 take",
          reason: "检测到重说信号；需结合前后内容确认作废范围",
          confidence: 0.7,
          requiresReview: true,
        });
      }
      if (index === 0) return;
      var before = transcript.segments[index - 1];
      var score = similarity(before.text, segment.text);
      if (score >= 0.78 && normalizedComparableText(segment.text).length >= 8) {
        suggestions.push({
          type: "review",
          category: "possible-duplicate",
          startMs: before.startMs,
          endMs: segment.endMs,
          label: "检查重复表达",
          reason: "相邻两段表达相似度 " + Math.round(score * 100) + "%；只有信息完全覆盖时才能删除",
          confidence: Math.min(0.85, score),
          requiresReview: true,
        });
      }
    });

    var tail = transcript.durationMs - lastWord.endMs;
    if (tail >= tailThresholdMs) {
      suggestions.push({
        type: "cut",
        category: "tail-out",
        startMs: Math.min(transcript.durationMs, lastWord.endMs + 180),
        endMs: transcript.durationMs,
        label: "清理结尾收工时间",
        reason: "最后一句实际口播后有 " + (tail / 1000).toFixed(1) + " 秒空白",
        confidence: 0.98,
        requiresReview: false,
      });
    }

    suggestions = suggestions.filter(function (item) { return item.endMs > item.startMs; })
      .sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; })
      .map(function (item, index) {
        return enrichSuggestion(transcript, Object.assign({ id: makeId("suggestion", index) }, item), events);
      });

    return {
      ok: true,
      errors: [],
      warnings: checked.warnings,
      transcript: transcript,
      suggestions: suggestions,
      summary: summarizeSuggestions(suggestions),
    };
  }

  function summarizeSuggestions(suggestions) {
    var list = Array.isArray(suggestions) ? suggestions : [];
    return {
      total: list.length,
      directCuts: list.filter(function (item) { return item.type === "cut" && !item.requiresReview; }).length,
      requiresReview: list.filter(function (item) { return item.requiresReview; }).length,
      estimatedRemovedMs: list.filter(function (item) { return item.type === "cut"; })
        .reduce(function (total, item) { return total + Math.max(0, item.endMs - item.startMs); }, 0),
    };
  }

  function auditAcceptedSuggestions(transcriptInput, suggestions, options) {
    var checked = validateTranscript(transcriptInput);
    if (!checked.valid) return { valid: false, errors: checked.errors, findings: [] };
    var transcript = checked.transcript;
    var config = isObject(options) ? options : {};
    var events = Array.isArray(config.events) ? config.events : [];
    var findings = [];
    (Array.isArray(suggestions) ? suggestions : []).filter(function (item) {
      return item && item.status === "accepted" && item.type === "cut";
    }).forEach(function (suggestion) {
      var segments = coveredSegments(transcript, suggestion.startMs, suggestion.endMs);
      var text = segments.map(function (segment) { return segment.text; }).join(" ");
      var signals = informationSignals(text);
      var activity = activitySignals(events, suggestion.startMs, suggestion.endMs);
      if (signals.length && suggestion.category !== "lead-in" && suggestion.category !== "tail-out") {
        findings.push({
          suggestionId: suggestion.id,
          severity: "review",
          signals: signals,
          text: text,
          message: "被删除内容包含" + signals.join("、") + "，必须确认成片中有完整覆盖。",
        });
      }
      if (activity.signals.length) {
        findings.push({
          suggestionId: suggestion.id,
          severity: "review",
          signals: activity.signals,
          eventCount: activity.count,
          text: text,
          message: "被删除区间包含" + activity.signals.join("、") + "，必须确认画面演示可删除。",
        });
      }
    });
    return { valid: findings.length === 0, errors: [], findings: findings };
  }

  return {
    normalizeTranscript: normalizeTranscript,
    validateTranscript: validateTranscript,
    analyzeTranscript: analyzeTranscript,
    summarizeSuggestions: summarizeSuggestions,
    auditAcceptedSuggestions: auditAcceptedSuggestions,
    activitySignals: activitySignals,
    informationSignals: informationSignals,
    similarity: similarity,
  };
});
