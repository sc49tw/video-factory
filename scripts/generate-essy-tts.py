#!/usr/bin/env python3
"""Canonical ESSY narration TTS synthesis (multi-provider).

Generates, for ONE narration block, in a single provider session:
  - the block MP3 audio (the master timeline)
  - a single-cue block-parent VTT window (temp/<sentenceId>.vtt)
  - the canonical word-timing artifact (temp/<sentenceId>.words.json)

Providers (selected with --provider, default "edge"):
  - edge: Microsoft Edge Read Aloud via the edge-tts Python package
    (WordBoundary events). Retained as the optional legacy provider;
    it remains the default so existing behavior is unchanged.
  - azure: Microsoft Azure AI Speech via azure-cognitiveservices-speech
    (SpeechSynthesisWordBoundary events). Credentials come ONLY from
    the AZURE_SPEECH_KEY and AZURE_SPEECH_REGION environment
    variables (never committed; .env is git-ignored).

Both providers emit the SAME artifact contracts (MP3, single-cue VTT,
words.json with textSha256-bound cache identity), so the subtitle
timeline builder, PREPARE validation, and the render pipeline are
provider-agnostic. The words.json timingSource records which provider
produced the timing ("edge-tts-word-boundary" or
"azure-speech-word-boundary").

Usage:
  python scripts/generate-essy-tts.py \
    --text-file <path>            # block narration text (UTF-8)
    --audio-out <path>            # MP3 output
    --vtt-out <path>              # single-cue parent VTT
    --words-out <path>            # word-timing JSON artifact
    --sentence-id <id>            # e.g. sentence-001
    --block-id <id>               # e.g. n001
    --voice <voice>               # e.g. en-GB-RyanNeural
    [--rate=-12%] [--pitch=+0Hz] [--volume=+0%]
    [--provider edge|azure]       # default: edge
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

PROVIDER_EDGE = "edge"
PROVIDER_AZURE = "azure"

# Word-timing artifact sources accepted by the PREPARE validator and
# the shared subtitle timeline builder.
TIMING_SOURCE_EDGE = "edge-tts-word-boundary"
TIMING_SOURCE_AZURE = "azure-speech-word-boundary"

WORD_BOUNDARY_TOLERANCE_SEC = 1.5


def load_project_dotenv():
    """Load the repository's git-ignored .env as a non-logging fallback.

    Existing process variables take precedence, so hosted or CI configuration
    remains authoritative.  This mirrors the project's lightweight .env
    convention without adding a dependency or ever printing secret values.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key not in os.environ:
            os.environ[key] = value


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate ESSY narration TTS + canonical word timing for one block"
    )
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--audio-out", required=True)
    parser.add_argument("--vtt-out", required=True)
    parser.add_argument("--words-out", required=True)
    parser.add_argument("--sentence-id", required=True)
    parser.add_argument("--block-id", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="-12%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--volume", default="+0%")
    parser.add_argument(
        "--provider",
        choices=[PROVIDER_EDGE, PROVIDER_AZURE],
        default=PROVIDER_EDGE,
        help="TTS provider (default: edge; azure uses AZURE_SPEECH_KEY/AZURE_SPEECH_REGION env vars)",
    )
    return parser.parse_args()


def format_timestamp(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    secs = (total_ms % 60_000) // 1000
    ms = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def ffprobe_duration_sec(audio_path: str) -> float:
    """Actual MP3 container duration (seconds) via ffprobe."""
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            audio_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return round(float(json.loads(completed.stdout)["format"]["duration"]), 3)


def azure_pitch_percent(pitch: str) -> str:
    """Azure Speech pitch is percentage-based; the ESSY contract
    carries Hz ("+0Hz"). Zero Hz is the neutral pitch and maps to 0%.
    Any other Hz shift has no standardized percentage equivalent and is
    refused rather than approximated."""
    value = pitch.strip()
    if re.fullmatch(r"[+-]?\d+%", value):
        return value
    match = re.fullmatch(r"([+-]?)(\d+)Hz", value)
    if match and int(match.group(2)) == 0:
        return "0%"
    raise RuntimeError(
        f"Unsupported pitch for the Azure Speech provider: {pitch!r}. "
        "Azure Speech pitch is a percentage (e.g. '+0%'); only the neutral "
        "Hz value '+0Hz' has an exact equivalent."
    )


def build_azure_ssml(narration_text, voice, rate, pitch, volume):
    """Build the complete Azure SSML request for an ESSY narration block.

    Azure's Python SpeechConfig has no supported ``speech_rate`` setting for
    synthesis.  The prosody request must therefore travel in SSML.  Escaping
    the narration is deliberately done here, at the production boundary, so
    approved punctuation remains literal narration text rather than markup.
    """
    azure_pitch = azure_pitch_percent(pitch)
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xml:lang="en-GB">'
        f'<voice name="{xml_escape(voice, {chr(34): "&quot;"})}">'
        f'<prosody rate="{xml_escape(rate, {chr(34): "&quot;"})}" '
        f'pitch="{xml_escape(azure_pitch, {chr(34): "&quot;"})}" '
        f'volume="{xml_escape(volume, {chr(34): "&quot;"})}">'
        f'{xml_escape(narration_text)}'
        '</prosody></voice></speak>'
    )


# ---------------------------------------------------------------------------
# Provider backends. Each returns (audio_bytes, duration_sec, word_boundaries)
# where word_boundaries is a list of {"text", "startSec", "endSec"} dicts
# captured in the SAME synthesis session as the audio.
# ---------------------------------------------------------------------------


def synthesize_edge(narration_text, voice, rate, pitch, volume):
    import edge_tts

    communicate = edge_tts.Communicate(
        narration_text,
        voice,
        rate=rate,
        pitch=pitch,
        volume=volume,
        boundary="WordBoundary",
    )

    word_boundaries = []
    audio_data = bytearray()
    duration = None

    async def process_stream():
        nonlocal duration
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.extend(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                offset_ms = int(chunk["offset"]) / 10_000.0
                duration_ms = int(chunk["duration"]) / 10_000.0
                word_boundaries.append(
                    {
                        "text": chunk["text"],
                        "startSec": round(offset_ms / 1000.0, 3),
                        "endSec": round((offset_ms + duration_ms) / 1000.0, 3),
                    }
                )
            elif chunk["type"] == "AudioMetadata":
                duration = chunk["duration"]

    import asyncio

    asyncio.run(process_stream())

    if not audio_data:
        raise RuntimeError("edge-tts produced no audio")
    if duration is None:
        raise RuntimeError("edge-tts produced no audio metadata (duration)")
    return bytes(audio_data), duration, word_boundaries


def parse_azure_word_boundary(evt):
    """Convert one Azure Speech WordBoundary event into the canonical
    word-timing dict {"text", "startSec", "endSec"}.

    Azure Speech SDK (>=1.21) event attributes:
      - evt.audio_offset : int, in 100-nanosecond ticks
      - evt.duration     : datetime.timedelta  (NOT numeric ticks/ms)
      - evt.text         : str

    audio_offset ticks -> seconds via /10_000_000. duration is a timedelta and
    MUST be converted with .total_seconds(); treating it as numeric ticks
    raises TypeError ("unsupported operand type(s) for +: 'int' and
    'datetime.timedelta'"), which the SDK silently swallows inside its event
    dispatch — producing a successful synthesis with zero words (ESSY-0006).
    """
    start_sec = evt.audio_offset / 10_000_000.0
    end_sec = start_sec + evt.duration.total_seconds()
    return {
        "text": evt.text,
        "startSec": round(start_sec, 3),
        "endSec": round(end_sec, 3),
    }


def synthesize_azure(narration_text, voice, rate, pitch, volume):
    try:
        import azure.cognitiveservices.speech as speechsdk
    except ImportError:
        raise RuntimeError(
            "The Azure Speech provider requires the azure-cognitiveservices-speech "
            "package: pip install azure-cognitiveservices-speech"
        )

    load_project_dotenv()
    subscription_key = os.environ.get("AZURE_SPEECH_KEY")
    region = os.environ.get("AZURE_SPEECH_REGION")
    if not subscription_key or not region:
        raise RuntimeError(
            "The Azure Speech provider requires the AZURE_SPEECH_KEY and "
            "AZURE_SPEECH_REGION environment variables."
        )

    speech_config = speechsdk.SpeechConfig(
        subscription=subscription_key, region=region
    )
    speech_config.speech_synthesis_voice_name = voice
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3
    )
    speech_config.set_property(
        speechsdk.PropertyId.SpeechServiceResponse_RequestWordBoundary, "true"
    )

    word_boundaries = []
    word_boundary_errors = []

    def on_word_boundary(evt):
        # The SDK dispatches event callbacks on its own thread and silently
        # swallows exceptions raised here. Capture any parsing failure so it
        # can be surfaced after synthesis instead of vanishing (ESSY-0006).
        try:
            word_boundaries.append(parse_azure_word_boundary(evt))
        except Exception as error:  # noqa: BLE001 - recorded, then surfaced
            word_boundary_errors.append(
                f"{type(error).__name__}: {error}"
            )

    synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=speech_config, audio_config=None
    )
    synthesizer.synthesis_word_boundary.connect(on_word_boundary)

    ssml = build_azure_ssml(narration_text, voice, rate, pitch, volume)
    result = synthesizer.speak_ssml_async(ssml).get()

    if result.reason == speechsdk.ResultReason.Canceled:
        cancellation = speechsdk.CancellationDetails.from_result(result)
        raise RuntimeError(
            "Azure Speech synthesis was canceled: "
            f"{cancellation.reason}: {cancellation.error_details}"
        )
    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        raise RuntimeError(
            f"Azure Speech synthesis failed: {result.reason}"
        )
    if not result.audio_data:
        raise RuntimeError("Azure Speech produced no audio")

    # Surface callback parse failures instead of silently dropping words.
    if word_boundary_errors:
        raise RuntimeError(
            "Azure Speech word-boundary parsing failed "
            f"({len(word_boundary_errors)} error(s), "
            f"{len(word_boundaries)} parsed): {word_boundary_errors[0]}"
        )
    # Nonempty narration must never yield a successful artifact with zero
    # valid word boundaries; that is the ESSY-0006 failure mode.
    if narration_text.strip() and not word_boundaries:
        raise RuntimeError(
            "Azure Speech produced no word boundaries for nonempty narration"
        )

    return result.audio_data, None, word_boundaries


def write_artifacts(
    audio_bytes,
    audio_path,
    vtt_path,
    words_path,
    duration_sec,
    word_boundaries,
    provider,
    timing_source,
    sentence_id,
    block_id,
    text_sha256,
    voice,
    rate,
    pitch,
    volume,
    narration_text,
):
    Path(audio_path).parent.mkdir(parents=True, exist_ok=True)
    Path(vtt_path).parent.mkdir(parents=True, exist_ok=True)
    Path(words_path).parent.mkdir(parents=True, exist_ok=True)

    with open(audio_path, "wb") as audio_file:
        audio_file.write(audio_bytes)

    # Single-cue VTT carrying the whole block's parent window (0 -> duration).
    vtt_content = (
        "WEBVTT\n\n"
        f"00:00:00.000 --> {format_timestamp(duration_sec)}\n"
        f"{narration_text}\n"
    )
    with open(vtt_path, "w", encoding="utf-8") as vtt_file:
        vtt_file.write(vtt_content)

    last_word_end_sec = (
        round(max(word["endSec"] for word in word_boundaries), 3)
        if word_boundaries
        else 0.0
    )
    words_artifact = {
        "schemaVersion": "1.0",
        "sentenceId": sentence_id,
        "blockId": block_id,
        "timingSource": timing_source,
        "cacheIdentity": {
            "textSha256": text_sha256,
            "matchesManifest": True,
            "audioDurationSec": duration_sec,
            "tts": {
                "provider": provider,
                "voice": voice,
                "rate": rate,
                "pitch": pitch,
                "volume": volume,
            },
        },
        "validation": {
            "wordCount": len(word_boundaries),
            "lastWordEndSec": last_word_end_sec,
            "fitsAudioDuration": last_word_end_sec
            <= duration_sec + WORD_BOUNDARY_TOLERANCE_SEC,
        },
        "words": word_boundaries,
    }
    with open(words_path, "w", encoding="utf-8") as words_file:
        json.dump(words_artifact, words_file, indent=2)
        words_file.write("\n")

    return words_artifact


def main():
    args = parse_args()

    narration_text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not narration_text:
        raise ValueError("Narration text file is empty")

    text_sha256 = hashlib.sha256(narration_text.encode("utf-8")).hexdigest()

    if args.provider == PROVIDER_AZURE:
        audio_bytes, _, word_boundaries = synthesize_azure(
            narration_text, args.voice, args.rate, args.pitch, args.volume
        )
        # The Azure backend returns the raw audio; the ACTUAL container
        # duration is measured from the written MP3 (never estimated).
        audio_path = os.path.abspath(args.audio_out)
        Path(audio_path).parent.mkdir(parents=True, exist_ok=True)
        with open(audio_path, "wb") as audio_file:
            audio_file.write(audio_bytes)
        duration_sec = ffprobe_duration_sec(audio_path)
    else:
        audio_bytes, duration_sec, word_boundaries = synthesize_edge(
            narration_text, args.voice, args.rate, args.pitch, args.volume
        )

    provider_config = {
        PROVIDER_EDGE: (PROVIDER_EDGE, TIMING_SOURCE_EDGE),
        PROVIDER_AZURE: (PROVIDER_AZURE, TIMING_SOURCE_AZURE),
    }[args.provider]

    words_artifact = write_artifacts(
        audio_bytes=audio_bytes,
        audio_path=args.audio_out,
        vtt_path=args.vtt_out,
        words_path=args.words_out,
        duration_sec=duration_sec,
        word_boundaries=word_boundaries,
        provider=provider_config[0],
        timing_source=provider_config[1],
        sentence_id=args.sentence_id,
        block_id=args.block_id,
        text_sha256=text_sha256,
        voice=args.voice,
        rate=args.rate,
        pitch=args.pitch,
        volume=args.volume,
        narration_text=narration_text,
    )

    validation = words_artifact["validation"]
    if not validation["fitsAudioDuration"]:
        raise RuntimeError(
            f"Word timing exceeds audio duration: lastWordEndSec="
            f"{validation['lastWordEndSec']} > durationSec="
            f"{duration_sec}+{WORD_BOUNDARY_TOLERANCE_SEC}"
        )

    print(
        f"Generated: {args.audio_out} ({duration_sec:.3f}s), "
        f"{args.vtt_out}, {args.words_out} "
        f"({len(word_boundaries)} words, provider={args.provider})"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
