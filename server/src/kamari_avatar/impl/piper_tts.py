"""Piper TTS (OHF-Voice/piper1-gpl) with phoneme alignments for timed lip sync.

Install with `pip install -e ".[piper]"` and download a voice, e.g.
`python -m piper.download_voices en_US-ljspeech-medium --data-dir voices`.

Licence note: piper-tts is GPL-3.0. That is fine for a backend you run yourself; review it
before distributing a build that bundles it. Kokoro or any other engine can replace it
behind the same TTSEngine interface.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

from ..interfaces import SynthChunk
from ..registry import register

log = logging.getLogger(__name__)
_DONE = object()
REPO_ROOT = Path(__file__).resolve().parents[4]


@register("tts", "piper")
class PiperTTS:
    """Synthesises one chunk per sentence. Each chunk carries IPA phonemes and their durations.

    Options:
      model        path to the voice .onnx, relative to the repo root unless absolute
      speaker      speaker id for multi-speaker voices
      length_scale speaking rate; >1 is slower
      alignments   ask Piper for phoneme timings (patches the model in memory; needs `onnx`)
    """

    def __init__(self, model: str, *, base_dir: str | Path = REPO_ROOT, speaker: int | None = None,
                 length_scale: float | None = None, alignments: bool = True, use_cuda: bool = False) -> None:
        try:
            from piper import PiperVoice, SynthesisConfig
        except ImportError as e:
            raise RuntimeError('piper is not installed: pip install -e ".[piper]"') from e
        path = Path(model)
        if not path.is_absolute():
            path = Path(base_dir) / path
        if not path.exists():
            raise FileNotFoundError(f"Piper voice not found at {path}; see README (Run it) to download one")
        self.alignments = alignments
        self.voice = PiperVoice.load(path, include_alignments=alignments, use_cuda=use_cuda)
        self.sample_rate: int = self.voice.config.sample_rate
        self._syn = SynthesisConfig(speaker_id=speaker, length_scale=length_scale)
        log.info("Piper voice %s loaded (%d Hz, alignments=%s)", path.name, self.sample_rate, alignments)

    def _chunks(self, text: str) -> Iterator[SynthChunk]:
        for c in self.voice.synthesize(text, syn_config=self._syn, include_alignments=self.alignments):
            pcm = c.audio_int16_bytes
            phonemes = durations = None
            if c.phoneme_alignments:
                phonemes = [a.phoneme for a in c.phoneme_alignments]
                durations = _samples_to_ms([int(a.num_samples) for a in c.phoneme_alignments], c.sample_rate)
            yield SynthChunk(pcm, c.sample_rate, phonemes, durations)

    async def synth(self, text: str, voice: str | None = None) -> AsyncIterator[SynthChunk]:
        # Piper is synchronous and CPU-bound: run it in a thread and hand chunks over as each sentence finishes.
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Any] = asyncio.Queue()
        cancelled = False

        def work() -> None:
            try:
                for chunk in self._chunks(text):
                    if cancelled:
                        return
                    loop.call_soon_threadsafe(queue.put_nowait, chunk)
            except Exception as e:  # noqa: BLE001 (re-raised in the consumer)
                loop.call_soon_threadsafe(queue.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, _DONE)

        task = loop.run_in_executor(None, work)
        try:
            while (item := await queue.get()) is not _DONE:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            cancelled = True
            await asyncio.shield(task)


def _samples_to_ms(samples: list[int], rate: int) -> list[int]:
    """Convert per-phoneme sample counts to ms without accumulating rounding drift."""
    out, total, prev = [], 0, 0
    for n in samples:
        total += n
        ms = total * 1000 // rate
        out.append(ms - prev)
        prev = ms
    return out
