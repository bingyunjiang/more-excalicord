#!/usr/bin/env python3
"""Create a word-timestamp transcript from the project's actual recording audio."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def default_model_path() -> Path | None:
    hub = Path.home() / ".cache" / "huggingface" / "hub" / "models--Systran--faster-whisper-base" / "snapshots"
    if not hub.is_dir():
        return None
    snapshots = sorted((entry for entry in hub.iterdir() if entry.is_dir()), key=lambda entry: entry.stat().st_mtime, reverse=True)
    return snapshots[0] if snapshots else None


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: transcribe_audio.py input_audio output_json [language] [model_path]", file=sys.stderr)
        return 2
    audio_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    language = (sys.argv[3] if len(sys.argv) > 3 else "zh").strip() or "zh"
    configured_model = (sys.argv[4] if len(sys.argv) > 4 else os.environ.get("EXCALICORD_WHISPER_MODEL", "")).strip()
    model_path = Path(configured_model).expanduser().resolve() if configured_model else default_model_path()
    if not audio_path.is_file():
        raise FileNotFoundError("recording audio not found")
    if model_path is None or not model_path.is_dir():
        raise RuntimeError("local faster-whisper base model is not installed")

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("faster-whisper runtime is not installed") from exc

    model = WhisperModel(str(model_path), device="cpu", compute_type="int8")
    hotwords = " ".join(os.environ.get("EXCALICORD_ASR_HOTWORDS", "").split())[:4000] or None
    iterator, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        word_timestamps=True,
        condition_on_previous_text=True,
        hotwords=hotwords,
    )
    segments: list[dict] = []
    all_text: list[str] = []
    last_end_ms = 0
    for segment_index, segment in enumerate(iterator):
        words: list[dict] = []
        for word_index, word in enumerate(segment.words or []):
            word_text = str(word.word or "").strip()
            if not word_text or word.start is None or word.end is None or word.end <= word.start:
                continue
            start_ms = max(0, round(float(word.start) * 1000))
            end_ms = max(start_ms + 1, round(float(word.end) * 1000))
            last_end_ms = max(last_end_ms, end_ms)
            words.append({
                "id": f"word-{segment_index + 1}-{word_index + 1}",
                "text": word_text,
                "startMs": start_ms,
                "endMs": end_ms,
                "confidence": float(word.probability) if word.probability is not None else None,
            })
        text = str(segment.text or "").strip()
        if not text or not words:
            continue
        start_ms = max(0, round(float(segment.start) * 1000))
        end_ms = max(start_ms + 1, round(float(segment.end) * 1000))
        probabilities = [word["confidence"] for word in words if word["confidence"] is not None]
        segment_confidence = sum(probabilities) / len(probabilities) if probabilities else None
        if end_ms - start_ms < 300 and segment_confidence is not None and segment_confidence < 0.15:
            continue
        last_end_ms = max(last_end_ms, end_ms)
        all_text.append(text)
        segments.append({
            "id": f"segment-{segment_index + 1}",
            "text": text,
            "startMs": start_ms,
            "endMs": end_ms,
            "speaker": "speaker-1",
            "confidence": segment_confidence,
            "reviewRequired": segment_confidence is not None and segment_confidence < 0.45,
            "words": words,
        })

    payload = {
        "schemaVersion": 1,
        "engine": "faster-whisper",
        "model": model_path.name,
        "language": getattr(info, "language", language) or language,
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "durationMs": max(last_end_ms, round(float(getattr(info, "duration", 0.0) or 0.0) * 1000)),
        "text": " ".join(all_text),
        "segments": segments,
        "contextTermsUsed": hotwords.split(" ") if hotwords else [],
    }
    if not segments:
        raise RuntimeError("no speech with word timestamps was detected")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_path.replace(output_path)
    print(json.dumps({"ok": True, "outputPath": str(output_path), "transcript": payload}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
