# CANONICAL WORD-TIMING ARTIFACT GENERATOR (generic, episode-agnostic).
#
# Captures Edge TTS WordBoundary offset/duration data for narration blocks and
# writes the authoritative per-block word-timing artifact:
#   projects/<EP>/temp/<sentenceId>.words.json
#
# Cache-compatible: the artifact records textSha256 + voice/rate/pitch, exactly
# matching the manifest.json TTS cache identity. Existing approved narration
# audio (projects/<EP>/audio/<sentenceId>.mp3) is NEVER overwritten — the
# synthesized audio used to obtain word boundaries is discarded.
#
# Usage:
#   python scripts/oneoff/generate-word-timing.py <EPISODE>            # all blocks
#   python scripts/oneoff/generate-word-timing.py <EPISODE> n003       # one block
import asyncio
import hashlib
import json
import os
import subprocess
import sys

import edge_tts

FACTORY_ROOT = os.getcwd()
SCHEMA_VERSION = "1.0"
DURATION_TOLERANCE_SEC = 1.5  # word timings must fit inside the cached mp3 + tolerance


def ffprobe_duration(file_path):
    result = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file_path,
    ], capture_output=True, text=True)
    return float(result.stdout.strip())


def load_blocks(episode):
    project_root = os.path.join(FACTORY_ROOT, "projects", episode)
    with open(os.path.join(project_root, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    with open(os.path.join(project_root, "source", "lesson.json"), "r", encoding="utf-8") as f:
        lesson = json.load(f)
    blocks = []
    for section in lesson["sections"]:
        for block in section["narration"]:
            sentence_id = f"sentence-{block['id'][1:]}"
            entry = next((a for a in manifest["audio"] if a["id"] == sentence_id), None)
            if entry is None:
                print(f"SKIP {sentence_id}: no manifest entry")
                continue
            blocks.append({
                "sentenceId": sentence_id,
                "blockId": block["id"],
                "text": block["text"],
                "manifestEntry": entry,
            })
    return blocks


async def capture_word_boundaries(text, voice, rate, pitch, volume):
    # edge-tts >= 7 defaults to SentenceBoundary; request word-level metadata.
    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, volume=volume, boundary="WordBoundary",
    )
    words = []
    async for chunk in communicate.stream():
        if chunk["type"] == "WordBoundary":
            start = chunk["offset"] / 10_000_000  # 100ns ticks -> seconds
            words.append({
                "text": chunk["text"],
                "startSec": round(start, 3),
                "endSec": round((chunk["offset"] + chunk["duration"]) / 10_000_000, 3),
            })
    return words


async def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/oneoff/generate-word-timing.py <EPISODE> [blockId ...]")
        sys.exit(1)
    episode = sys.argv[1]
    only_ids = {a.lower() for a in sys.argv[2:]}
    project_root = os.path.join(FACTORY_ROOT, "projects", episode)
    temp_dir = os.path.join(project_root, "temp")

    blocks = load_blocks(episode)
    if only_ids:
        blocks = [b for b in blocks if b["blockId"].lower() in only_ids]
    if not blocks:
        print("No matching blocks.")
        sys.exit(1)

    for block in blocks:
        entry = block["manifestEntry"]
        tts = entry["tts"]
        text_hash = hashlib.sha256(block["text"].encode("utf-8")).hexdigest()
        identity_ok = text_hash == entry.get("textSha256")
        if not identity_ok:
            print(f"FAIL {block['sentenceId']}: narration text does not match cached TTS identity "
                  f"(sha256 {text_hash} != manifest {entry.get('textSha256')}). NOT writing artifact.")
            continue

        print(f"[{block['sentenceId']}] voice={tts['voice']} rate={tts['rate']} ...", end=" ")
        words = await capture_word_boundaries(
            block["text"], tts["voice"], tts["rate"], tts["pitch"], tts.get("volume", "+0%"),
        )
        audio_dur = ffprobe_duration(os.path.join(project_root, "audio", f"{block['sentenceId']}.mp3"))
        last_end = words[-1]["endSec"] if words else 0.0
        fits_audio = last_end <= audio_dur + DURATION_TOLERANCE_SEC
        artifact = {
            "schemaVersion": SCHEMA_VERSION,
            "sentenceId": block["sentenceId"],
            "blockId": block["blockId"],
            "timingSource": "edge-tts-word-boundary",
            "cacheIdentity": {
                "textSha256": text_hash,
                "matchesManifest": identity_ok,
                "audioDurationSec": round(audio_dur, 3),
                "tts": {"voice": tts["voice"], "rate": tts["rate"], "pitch": tts["pitch"], "volume": tts.get("volume", "+0%")},
            },
            "validation": {
                "wordCount": len(words),
                "lastWordEndSec": last_end,
                "fitsAudioDuration": fits_audio,
            },
            "words": words,
        }
        out_path = os.path.join(temp_dir, f"{block['sentenceId']}.words.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(artifact, f, indent=2, ensure_ascii=False)
        status = "OK" if (words and fits_audio) else "WARN"
        print(f"{status}: {len(words)} words, last end {last_end:.3f}s, audio {audio_dur:.3f}s -> {out_path}")


asyncio.run(main())
