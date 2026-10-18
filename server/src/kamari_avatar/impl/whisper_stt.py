"""Speech-to-text with faster-whisper (MIT), on CPU with int8 by default.

Install with `pip install -e ".[stt]"`. The model downloads from Hugging Face on first start
and is cached (base.en is about 145 MB); without network or the package, the backend falls
back to the `fallback` STT in config and says so in the log and on /health.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

from ..interfaces import AudioSegment, Transcript
from ..registry import register

log = logging.getLogger(__name__)


@register("stt", "faster_whisper")
class FasterWhisperSTT:
    """Transcribes one push-to-talk segment at a time.

    Options:
      model         tiny.en, base.en, small.en, distil-small.en... or a local model directory
      device        cpu or cuda
      compute_type  int8 on CPU, float16 on GPU
      language      fixes the language (skips detection, faster); null to detect
      beam_size     1 is greedy and fastest
      cpu_threads   0 lets CTranslate2 decide
      vad_filter    trim silence with the bundled Silero VAD first (stops Whisper inventing words in silence)
    """

    def __init__(self, model: str = "base.en", *, device: str = "cpu", compute_type: str = "int8",
                 language: str | None = "en", beam_size: int = 1, cpu_threads: int = 0,
                 vad_filter: bool = True, download_root: str | None = None) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError('faster-whisper is not installed: pip install -e ".[stt]"') from e
        try:
            self._model = WhisperModel(model, device=device, compute_type=compute_type, cpu_threads=cpu_threads,
                                       download_root=download_root)
        except Exception as e:  # download or load failure: let config fall back
            raise RuntimeError(f"cannot load Whisper model {model!r}: {e}") from e
        self.language = language
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        # CTranslate2 releases the GIL; one worker keeps transcriptions from fighting over cores.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
        log.info("Whisper model %s loaded (%s, %s)", model, device, compute_type)

    def _run(self, segment: AudioSegment) -> Transcript:
        import numpy as np

        audio = np.frombuffer(segment.pcm, dtype="<i2").astype(np.float32) / 32768.0
        if segment.sample_rate != 16000:
            raise ValueError("faster-whisper expects 16 kHz audio")
        segments, info = self._model.transcribe(audio, language=self.language, beam_size=self.beam_size,
                                                condition_on_previous_text=False, without_timestamps=True,
                                                vad_filter=self.vad_filter)
        text = "".join(s.text for s in segments).strip()
        return Transcript(text, final=True, language=info.language)

    async def transcribe(self, segment: AudioSegment) -> Transcript:
        if len(segment.pcm) < segment.sample_rate // 10 * 2:  # under 100 ms: a tap, not speech
            return Transcript("")
        return await asyncio.get_running_loop().run_in_executor(self._pool, self._run, segment)
