"""Energy VAD: frames well above the segment's own noise floor count as speech.

Cheap and dependency-free; it only has to tell speech from near-silence and short knocks, because
the browser's VAD already decided someone started talking. Swap in a model-based VAD through the
`vad` section of config/backend.yaml if that is not enough.
"""

from __future__ import annotations

import math
from array import array

from ..interfaces import AudioSegment
from ..registry import register


@register("vad", "energy")
class EnergyVAD:
    """
    min_dbfs     frames quieter than this are never speech (-50 dBFS: well below a voice a metre away)
    margin_db    a frame is speech when it is this much louder than the quietest tenth of the segment
    frame_ms     analysis frame length
    """

    def __init__(self, min_dbfs: float = -50, margin_db: float = 9, frame_ms: int = 20) -> None:
        self.min_dbfs, self.margin_db, self.frame_ms = min_dbfs, margin_db, frame_ms

    def frame_levels(self, segment: AudioSegment) -> list[float]:
        """dBFS of each frame."""
        samples = array("h")
        samples.frombytes(segment.pcm[: len(segment.pcm) // 2 * 2])
        n = max(1, segment.sample_rate * self.frame_ms // 1000)
        levels = []
        for i in range(0, len(samples) - n + 1, n):
            frame = samples[i:i + n]
            rms = math.sqrt(sum(v * v for v in frame) / n) / 32768
            levels.append(20 * math.log10(max(rms, 1e-6)))
        return levels

    def speech_ms(self, segment: AudioSegment) -> int:
        levels = self.frame_levels(segment)
        if not levels:
            return 0
        floor = sorted(levels)[len(levels) // 10]
        threshold = max(self.min_dbfs, floor + self.margin_db)
        # A segment that is loud all the way through (no pause in it) has no floor of its own.
        if floor > self.min_dbfs + self.margin_db:
            threshold = self.min_dbfs
        return sum(self.frame_ms for v in levels if v > threshold)
