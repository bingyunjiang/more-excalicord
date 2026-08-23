(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExcalicordEditorIO = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function cleanText(value) {
    return typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
  }

  function makeId(prefix, index) {
    return String(prefix || "item") + "-" + String(index + 1);
  }

  function parseTimecode(value) {
    var text = String(value || "").trim().replace(",", ".");
    var parts = text.split(":");
    if (parts.length === 2) parts.unshift("0");
    if (parts.length !== 3) return NaN;
    var hours = Number(parts[0]);
    var minutes = Number(parts[1]);
    var seconds = Number(parts[2]);
    if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60.9999) return NaN;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  function formatTimecode(timeMs, separator) {
    var total = Math.max(0, Math.round(finite(timeMs, 0)));
    var hours = Math.floor(total / 3600000);
    var minutes = Math.floor((total % 3600000) / 60000);
    var seconds = Math.floor((total % 60000) / 1000);
    var milliseconds = total % 1000;
    function pad(value, width) { return String(value).padStart(width, "0"); }
    return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2)
      + (separator || ",") + pad(milliseconds, 3);
  }

  function normalizeSubtitle(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    var startMs = finite(raw.startMs, finite(raw.start, NaN) * 1000);
    var endMs = finite(raw.endMs, finite(raw.end, NaN) * 1000);
    var text = cleanText(raw.text);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : makeId("subtitle", index),
      startMs: Math.max(0, startMs),
      endMs: Math.max(0, endMs),
      text: text,
      style: typeof raw.style === "string" ? raw.style : "default",
      source: typeof raw.source === "string" ? raw.source : "imported",
    };
  }

  function parseSubtitleText(content) {
    var text = String(content || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
    var blocks = text.split(/\n{2,}/);
    var output = [];
    blocks.forEach(function (block) {
      var lines = block.split("\n").filter(function (line, index) {
        return index > 0 || line.trim() !== "WEBVTT";
      });
      var timingIndex = lines.findIndex(function (line) { return line.indexOf("-->") >= 0; });
      if (timingIndex < 0) return;
      var timing = lines[timingIndex].split("-->");
      var startToken = String(timing[0] || "").trim().split(/\s+/)[0];
      var endToken = String(timing[1] || "").trim().split(/\s+/)[0];
      var startMs = parseTimecode(startToken);
      var endMs = parseTimecode(endToken);
      var cueText = lines.slice(timingIndex + 1).filter(function (line) {
        return !/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line.trim());
      }).join("\n").trim();
      var segment = normalizeSubtitle({
        startMs: startMs,
        endMs: endMs,
        text: cueText,
        source: "imported",
      }, output.length);
      if (segment) output.push(segment);
    });
    return output.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
  }

  function subtitlesToSrt(segments) {
    return (Array.isArray(segments) ? segments : []).map(normalizeSubtitle).filter(Boolean)
      .map(function (segment, index) {
        return String(index + 1) + "\n"
          + formatTimecode(segment.startMs, ",") + " --> " + formatTimecode(segment.endMs, ",") + "\n"
          + segment.text + "\n";
      }).join("\n");
  }

  function subtitlesToVtt(segments) {
    var body = (Array.isArray(segments) ? segments : []).map(normalizeSubtitle).filter(Boolean)
      .map(function (segment) {
        return formatTimecode(segment.startMs, ".") + " --> " + formatTimecode(segment.endMs, ".") + "\n"
          + segment.text + "\n";
      }).join("\n");
    return "WEBVTT\n\n" + body;
  }

  function normalizeWord(raw, segmentIndex, wordIndex) {
    if (!raw || typeof raw !== "object") return null;
    var text = cleanText(raw.text != null ? raw.text : raw.word);
    var startMs = finite(raw.startMs, finite(raw.start, NaN) * 1000);
    var endMs = finite(raw.endMs, finite(raw.end, NaN) * 1000);
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : "word-" + String(segmentIndex + 1) + "-" + String(wordIndex + 1),
      text: text,
      startMs: Math.max(0, startMs),
      endMs: Math.max(0, endMs),
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence)
        : (Number.isFinite(Number(raw.probability)) ? Number(raw.probability) : null),
    };
  }

  function normalizeTranscript(input) {
    var raw = typeof input === "string" ? JSON.parse(input) : input;
    if (!raw || typeof raw !== "object") throw new Error("逐字稿 JSON 不是有效对象");
    var sourceSegments = Array.isArray(raw.segments) ? raw.segments : [];
    if (!sourceSegments.length && Array.isArray(raw.words)) {
      sourceSegments = [{ text: raw.text || "", words: raw.words }];
    }
    var segments = sourceSegments.map(function (segment, segmentIndex) {
      var words = (Array.isArray(segment.words) ? segment.words : []).map(function (word, wordIndex) {
        return normalizeWord(word, segmentIndex, wordIndex);
      }).filter(Boolean);
      var text = cleanText(segment.text || words.map(function (word) { return word.text; }).join(""));
      var startMs = finite(segment.startMs, finite(segment.start, words.length ? words[0].startMs / 1000 : NaN) * 1000);
      var endMs = finite(segment.endMs, finite(segment.end, words.length ? words[words.length - 1].endMs / 1000 : NaN) * 1000);
      if (!text || !words.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return {
        id: typeof segment.id === "string" && segment.id ? segment.id : makeId("segment", segmentIndex),
        text: text,
        startMs: Math.max(0, startMs),
        endMs: Math.max(0, endMs),
        speaker: typeof segment.speaker === "string" ? segment.speaker : "speaker-1",
        confidence: Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null,
        reviewRequired: segment.reviewRequired === true,
        textEdited: segment.textEdited === true,
        words: words,
      };
    }).filter(Boolean);
    if (!segments.length) throw new Error("逐字稿缺少带词级时间戳的 segments/words");
    segments.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    return {
      language: typeof raw.language === "string" ? raw.language : "zh-CN",
      durationMs: Math.max(finite(raw.durationMs, finite(raw.duration, 0) * 1000), segments[segments.length - 1].endMs),
      text: cleanText(raw.text || segments.map(function (segment) { return segment.text; }).join(" ")),
      segments: segments,
    };
  }

  function transcriptToSubtitles(transcriptInput, options) {
    var transcript = normalizeTranscript(transcriptInput);
    var config = options && typeof options === "object" ? options : {};
    var maxChars = Math.max(10, finite(config.maxChars, 26));
    var maxDurationMs = Math.max(1000, finite(config.maxDurationMs, 6000));
    var minDurationMs = Math.max(400, finite(config.minDurationMs, 900));
    var output = [];
    transcript.segments.forEach(function (segment) {
      if (segment.textEdited) {
        output.push(normalizeSubtitle({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          source: "transcript-corrected",
        }, output.length));
        return;
      }
      var words = segment.words;
      var current = [];
      function flush() {
        if (!current.length) return;
        var text = current.map(function (word) { return word.text; }).join("")
          .replace(/\s+([，。！？、；：,.!?;:])/g, "$1").trim();
        var startMs = current[0].startMs;
        var naturalEnd = current[current.length - 1].endMs;
        output.push(normalizeSubtitle({
          startMs: startMs,
          endMs: Math.max(naturalEnd, startMs + minDurationMs),
          text: text,
          source: "transcript",
        }, output.length));
        current = [];
      }
      words.forEach(function (word) {
        var candidate = current.concat([word]);
        var chars = candidate.map(function (item) { return item.text; }).join("").length;
        var duration = word.endMs - candidate[0].startMs;
        if (current.length && (chars > maxChars || duration > maxDurationMs)) flush();
        current.push(word);
        if (/[。！？!?]$/.test(word.text)) flush();
      });
      flush();
    });
    return output.filter(Boolean);
  }

  function safeExportName(projectId, extension) {
    var base = String(projectId || "more-excalicord").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return (base || "more-excalicord") + "-final." + String(extension || "mp4").replace(/[^A-Za-z0-9]/g, "");
  }

  return {
    parseTimecode: parseTimecode,
    formatTimecode: formatTimecode,
    parseSubtitleText: parseSubtitleText,
    subtitlesToSrt: subtitlesToSrt,
    subtitlesToVtt: subtitlesToVtt,
    normalizeTranscript: normalizeTranscript,
    transcriptToSubtitles: transcriptToSubtitles,
    safeExportName: safeExportName,
  };
});
