"""Map eSpeak/Piper IPA phonemes to the Oculus 15-viseme set."""

from __future__ import annotations

from collections.abc import Sequence

from ..protocol import Viseme, VisemeKey
from ..registry import register

IPA_TO_OCULUS: dict[str, str] = {
    **dict.fromkeys("pbm", "PP"),
    **dict.fromkeys("fv", "FF"),
    **dict.fromkeys("θð", "TH"),
    **dict.fromkeys("td", "DD"),
    **dict.fromkeys("kgŋxq", "kk"),
    **dict.fromkeys("ʃʒ", "CH"),
    **dict.fromkeys("sz", "SS"),
    **dict.fromkeys("nlɫ", "nn"),
    **dict.fromkeys("rɹɾʁ", "RR"),
    **dict.fromkeys("ɑaæʌɐ", "aa"),
    **dict.fromkeys("ɛeəɜɚh", "E"),
    **dict.fromkeys("ɪij", "I"),
    **dict.fromkeys("ɔoɒ", "O"),
    **dict.fromkeys("ʊuw", "U"),
}
# No mouth shape of their own: their duration extends the previous key. Word gaps are included
# because speech flows across them; pauses come from punctuation, which maps to silence.
MODIFIERS = set("ːˑ̩̃ʰ ")
# Stress marks precede the syllable they stress, so their duration belongs to the next key.
PREFIXES = set("ˈˌ")


@register("viseme_mapper", "oculus_ipa")
class OculusIpaMapper:
    def map(self, phonemes: Sequence[str], durations_ms: Sequence[int]) -> list[VisemeKey]:
        if len(phonemes) != len(durations_ms):
            raise ValueError("phonemes and durations_ms must be the same length")
        keys: list[VisemeKey] = []
        t = 0
        start: int | None = None  # set while stress marks wait for the phoneme they belong to
        for ph, dur in zip(phonemes, durations_ms, strict=True):
            if ph in PREFIXES:
                start = t if start is None else start
                t += dur
                continue
            if ph in MODIFIERS and keys and start is None:
                t += dur
                continue
            v = IPA_TO_OCULUS.get(ph, "sil")  # punctuation and Piper's ^ $ markers are silence
            if not keys or keys[-1].v.root != v:
                keys.append(VisemeKey(t=t if start is None else start, v=Viseme(v)))
            start = None
            t += dur
        if not keys or keys[-1].v.root != "sil":
            keys.append(VisemeKey(t=t, v=Viseme("sil")))
        return keys
