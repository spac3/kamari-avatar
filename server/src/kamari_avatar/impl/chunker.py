from __future__ import annotations

import re

from ..registry import register

_BOUNDARY = re.compile(r"(?<=[.!?;:])\s+|\n+")


@register("chunker", "punctuation")
class PunctuationChunker:
    """Emits a piece at each sentence boundary. Pieces shorter than `min_chars` wait for more text."""

    def __init__(self, min_chars: int = 12) -> None:
        self.min_chars = min_chars
        self._buf = ""

    def feed(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        while m := _BOUNDARY.search(self._buf):
            piece, rest = self._buf[: m.start()].strip(), self._buf[m.end():]
            if len(piece) < self.min_chars and rest:
                # too short to be worth a TTS call on its own; merge with what follows
                nxt = _BOUNDARY.search(rest)
                if not nxt:
                    break
                piece = f"{piece} {rest[: nxt.start()].strip()}"
                rest = rest[nxt.end():]
            if piece:
                out.append(piece)
            self._buf = rest
        return out

    def flush(self) -> list[str]:
        piece, self._buf = self._buf.strip(), ""
        return [piece] if piece else []
