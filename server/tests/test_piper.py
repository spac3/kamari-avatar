"""Runs only where Piper and a voice are installed: KAMARI_TEST_PIPER_VOICE=/path/to/voice.onnx pytest"""

import os
from pathlib import Path

import pytest

from kamari_avatar.impl.visemes import OculusIpaMapper

VOICE = os.environ.get("KAMARI_TEST_PIPER_VOICE")
pytestmark = pytest.mark.skipif(not VOICE, reason="set KAMARI_TEST_PIPER_VOICE to a Piper .onnx voice")


async def test_piper_chunks_carry_aligned_phonemes():
    from kamari_avatar.impl.piper_tts import PiperTTS

    tts = PiperTTS(str(Path(VOICE).resolve()))  # relative to where pytest runs, not the repo root
    chunks = [c async for c in tts.synth("Hello, welcome. Let me show you the window.")]
    assert len(chunks) == 2  # one per sentence
    for c in chunks:
        assert c.sample_rate == tts.sample_rate
        assert c.phonemes and len(c.phonemes) == len(c.phoneme_ms)
        assert abs(sum(c.phoneme_ms) - c.duration_ms) <= 2
        keys = OculusIpaMapper().map(c.phonemes, c.phoneme_ms)
        assert {k.v.root for k in keys} >= {"sil", "E"}
        assert [k.t for k in keys] == sorted(k.t for k in keys)
