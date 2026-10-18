#!/usr/bin/env python3
"""Offline regression test for the Azure Speech WordBoundary parser.

Covers the ESSY-0006 root cause: `evt.duration` is a datetime.timedelta
(SDK >=1.21), but the old parser treated it as numeric 100-ns ticks, raising
TypeError inside the SDK event dispatch (silently swallowed) and yielding a
"successful" synthesis with zero words.

Runs fully offline: no Azure credentials, no network, no synthesis. The event
is a lightweight mock carrying the real attribute shapes. Run:

    python scripts/_test-azure-word-boundary.py
"""

import datetime
import importlib.util
import os
import sys
import unittest
import xml.etree.ElementTree as ET

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_PATH = os.path.join(_HERE, "generate-essy-tts.py")

# The production module name contains hyphens, so load it by file path.
_spec = importlib.util.spec_from_file_location("generate_essy_tts", _MODULE_PATH)
generate_essy_tts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(generate_essy_tts)


class MockWordBoundaryEvent:
    """Mimic SpeechSynthesisWordBoundaryEventArgs attribute shapes.

    audio_offset : int, 100-nanosecond ticks
    duration     : datetime.timedelta
    text         : str
    """

    def __init__(self, text, audio_offset_ticks, duration):
        self.text = text
        self.audio_offset = audio_offset_ticks
        self.duration = duration


class ParseAzureWordBoundaryTest(unittest.TestCase):
    def test_converts_timedelta_duration_to_seconds(self):
        # 0.5s offset (5_000_000 ticks) + 0.25s duration -> 0.5 .. 0.75
        evt = MockWordBoundaryEvent(
            "Hello", 5_000_000, datetime.timedelta(milliseconds=250)
        )
        result = generate_essy_tts.parse_azure_word_boundary(evt)
        self.assertEqual(result["text"], "Hello")
        self.assertAlmostEqual(result["startSec"], 0.5, places=3)
        self.assertAlmostEqual(result["endSec"], 0.75, places=3)

    def test_offset_uses_ten_million_ticks_per_second(self):
        evt = MockWordBoundaryEvent(
            "world", 12_345_678, datetime.timedelta(microseconds=123_456)
        )
        result = generate_essy_tts.parse_azure_word_boundary(evt)
        self.assertAlmostEqual(result["startSec"], 1.234568, places=3)
        self.assertAlmostEqual(result["endSec"], 1.358024, places=3)

    def test_zero_duration_word_is_valid(self):
        evt = MockWordBoundaryEvent("x", 0, datetime.timedelta(0))
        result = generate_essy_tts.parse_azure_word_boundary(evt)
        self.assertEqual(result["startSec"], 0.0)
        self.assertEqual(result["endSec"], 0.0)

    def test_regression_old_numeric_expression_raises_typeerror(self):
        # The removed buggy math (adding int + timedelta) must still raise,
        # proving the fix is what makes parsing succeed.
        evt = MockWordBoundaryEvent(
            "Hello", 5_000_000, datetime.timedelta(milliseconds=250)
        )
        with self.assertRaises(TypeError):
            _ = (evt.audio_offset + evt.duration) / 10_000_000.0

    def test_ssml_uses_approved_voice_rate_and_escapes_narration(self):
        ssml = generate_essy_tts.build_azure_ssml(
            'Fish & chips < 5 euros; say "hello".',
            "en-GB-RyanNeural",
            "-20%",
            "+0Hz",
            "+0%",
        )
        root = ET.fromstring(ssml)
        namespace = {"s": "http://www.w3.org/2001/10/synthesis"}
        voice = root.find("s:voice", namespace)
        prosody = voice.find("s:prosody", namespace)
        self.assertEqual(voice.attrib["name"], "en-GB-RyanNeural")
        self.assertEqual(prosody.attrib["rate"], "-20%")
        self.assertEqual(prosody.attrib["pitch"], "0%")
        self.assertEqual(prosody.attrib["volume"], "+0%")
        self.assertEqual(prosody.text, 'Fish & chips < 5 euros; say "hello".')


if __name__ == "__main__":
    unittest.main(verbosity=2)
    sys.exit(0)
