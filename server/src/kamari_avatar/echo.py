"""Is a transcript just the avatar's own voice, picked up by the user's microphone?

The browser cancels most echo before it reaches the VAD, but some gets through (speakers loud,
no headphones, a browser without echo cancellation for Web Audio). What does get through is
transcribed as the words the avatar was saying, so comparing the transcript with those words
catches it. One-word transcripts are never treated as echo ("stop" must always work), and neither is
one that adds a word that turns it around ("don't go to the window" after "I'll go to the window").
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from difflib import SequenceMatcher

_WORD = re.compile(r"[a-z0-9']+")
# Words that make an otherwise repeated sentence the user's own: a correction, not an echo.
_TURNING = {"no", "not", "don't", "dont", "never", "stop", "wait", "instead", "cancel", "but", "actually",
            "nope", "isn't", "can't", "won't", "didn't", "doesn't"}


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower().replace("\u2019", "'"))


def is_echo(transcript: str, said: Iterable[str], min_ratio: float = 0.75) -> bool:
    """True when at least `min_ratio` of the transcript's words appear, in order, in what was said."""
    heard = words(transcript)
    if len(heard) < 2:
        return False
    ref = words(" ".join(said))
    if not ref:
        return False
    blocks = SequenceMatcher(None, heard, ref, autojunk=False).get_matching_blocks()
    matched = {i for b in blocks for i in range(b.a, b.a + b.size)}
    if any(w in _TURNING for i, w in enumerate(heard) if i not in matched):
        return False
    return len(matched) / len(heard) >= min_ratio
