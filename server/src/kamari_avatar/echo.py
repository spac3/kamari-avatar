"""Is a transcript just the avatar's own voice, picked up by the user's microphone?

The browser cancels most echo before it reaches the VAD, but some gets through (speakers loud,
no headphones, a browser without echo cancellation for Web Audio). What does get through is
transcribed as the words the avatar was saying, so comparing the transcript with those words
catches it. One-word transcripts are never treated as echo: "stop" must always work.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from difflib import SequenceMatcher

_WORD = re.compile(r"[a-z0-9']+")


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def is_echo(transcript: str, said: Iterable[str], min_ratio: float = 0.75) -> bool:
    """True when at least `min_ratio` of the transcript's words appear, in order, in what was said."""
    heard = words(transcript)
    if len(heard) < 2:
        return False
    ref = words(" ".join(said))
    if not ref:
        return False
    matched = sum(b.size for b in SequenceMatcher(None, heard, ref, autojunk=False).get_matching_blocks())
    return matched / len(heard) >= min_ratio
