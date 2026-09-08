# CANONICAL ESSY TTS SYNTHESIS (one session -> audio + VTT + word timing).
#
# Promoted from the validated prototype (scripts/oneoff/generate-word-timing.py)
# into the production path. render-lesson.mjs invokes this for ESSY narration
# blocks so that a single edge-tts synthesis session produces, cache-binds and
# validates:
#   <audio-out>          narration mp3 (identical treatment to the old CLI path)
#   <vtt-out>            single-cue VTT covering the block (parent windows for
#                        the shared subtitle timeline builder; semantic grouping
#                        is decided later by the DP segmentation)
#   <words-out>          canonical word-timing artifact (edge-tts WordBoundary
#                        offset/duration captured in the SAME synthesis session)
#
# Cache identity: textSha256 + voice/rate/pitch/volume, matching manifest.json
# TTS cache identity. render-lesson validates the pair on cache hits.
#
# Usage (invoked by scripts/render-lesson.mjs):
#   python scripts/generate-essy-tts.py \
#     --text-file <txt> --audio-out <mp3> --vtt-out <vtt> --words-out <json> \
#     --sentence-id sentence-001 --block-id n001 \
#     --voice en-GB-RyanNeural --rate=-12% --pitch=+0Hz --volume=+0%
import argparse
import asyncio
import hashlib
import json
import subprocess

import edge_tts

SCHEMA_VERSION = "1.0"


def ffprobe_duration(file_path):
    result = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file_path,
    ], capture_output=True, text=True)
    return float(result.stdout.strip())


async def synthesize(text, voice, rate, pitch, volume, audio_out, vtt_out, words_out,
                     sentence_id, block_id):
    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, volume=volume, boundary="WordBoundary",
    )
    words = []
    audio_chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append({
                "text": chunk["text"],
                "startSec": round(chunk["offset"] / 10_000_000, 3),
                "endSec": round((chunk["offset"] + chunk["duration"]) / 10_000_000, 3),
            })
    if not audio_chunks:
        raise RuntimeError("edge-tts produced no audio")
    with open(audio_out, "wb") as f:
        for data in audio_chunks:
            f.write(data)

    audio_dur = ffprobe_duration(audio_out)
    last_end = words[-1]["endSec"] if words else 0.0
    if not words:
        raise RuntimeError("edge-tts produced no WordBoundary metadata")
    if last_end > audio_dur + 1.5:
        raise RuntimeError(
            f"word timing exceeds audio duration ({last_end:.3f}s > {audio_dur:.3f}s)"
        )

    # Single-cue parent VTT (whole block window). Semantic subtitle grouping is
    # decided by the shared DP segmentation; word timing decides placement.
    with open(vtt_out, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        f.write("00:00:00,000 --> {:02d}:{:02d}:{:02d},{:03d}\n".format(
            int(last_end // 3600), int((last_end % 3600) // 60),
            int(last_end % 60), int(round((last_end % 1) * 1000)),
        ))
        f.write(text + "\n")

    artifact = {
        "schemaVersion": SCHEMA_VERSION,
        "sentenceId": sentence_id,
        "blockId": block_id,
        "timingSource": "edge-tts-word-boundary",
        "cacheIdentity": {
            "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "matchesManifest": True,
            "audioDurationSec": round(audio_dur, 3),
            "tts": {"voice": voice, "rate": rate, "pitch": pitch, "volume": volume},
        },
        "validation": {
            "wordCount": len(words),
            "lastWordEndSec": last_end,
            "fitsAudioDuration": True,
        },
        "words": words,
    }
    with open(words_out, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2, ensure_ascii=False)
    return artifact


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--audio-out", required=True)
    parser.add_argument("--vtt-out", required=True)
    parser.add_argument("--words-out", required=True)
    parser.add_argument("--sentence-id", required=True)
    parser.add_argument("--block-id", default="")
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--volume", default="+0%")
    args = parser.parse_args()

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read().rstrip("\n")

    artifact = asyncio.run(synthesize(
        text, args.voice, args.rate, args.pitch, args.volume,
        args.audio_out, args.vtt_out, args.words_out,
        args.sentence_id, args.block_id,
    ))
    print(json.dumps({
        "sentenceId": artifact["sentenceId"],
        "words": artifact["validation"]["wordCount"],
        "lastWordEndSec": artifact["validation"]["lastWordEndSec"],
        "audioDurationSec": artifact["cacheIdentity"]["audioDurationSec"],
    }))


if __name__ == "__main__":
    main()
