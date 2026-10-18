"""Runs where faster-whisper and Piper are installed: Piper says a line and Whisper must hear it.

    KAMARI_TEST_WHISPER_MODEL=base.en KAMARI_TEST_PIPER_VOICE=voices/en_US-ljspeech-medium.onnx pytest tests/test_whisper.py
"""

import os
from pathlib import Path

import pytest

from kamari_avatar.interfaces import AudioSegment

MODEL = os.environ.get("KAMARI_TEST_WHISPER_MODEL")
VOICE = os.environ.get("KAMARI_TEST_PIPER_VOICE")
pytestmark = pytest.mark.skipif(not (MODEL and VOICE), reason="set KAMARI_TEST_WHISPER_MODEL and KAMARI_TEST_PIPER_VOICE")


def to_16k(pcm: bytes, rate: int) -> bytes:
    import numpy as np

    x = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    t = np.arange(0, len(x) / rate, 1 / 16000)
    return np.interp(t, np.arange(len(x)) / rate, x).astype("<i2").tobytes()


async def test_whisper_hears_what_piper_says():
    from kamari_avatar.impl.piper_tts import PiperTTS
    from kamari_avatar.impl.whisper_stt import FasterWhisperSTT

    # No sampling noise: the same audio every run (with it, base.en sometimes hears "wave" as "wait").
    tts = PiperTTS(str(Path(VOICE).resolve()), noise_scale=0.0, noise_w_scale=0.0)
    pcm = b"".join([c.pcm async for c in tts.synth("Please go to the window and wave.")])
    stt = FasterWhisperSTT(MODEL)
    transcript = await stt.transcribe(AudioSegment(to_16k(pcm, tts.sample_rate)))
    words = transcript.text.lower()
    assert "window" in words and "wave" in words, words
    assert (await stt.transcribe(AudioSegment(b"\x00\x00" * 800))).text == ""  # a 50 ms tap
