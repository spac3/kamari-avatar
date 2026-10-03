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
    " ": "sil",
}
# Codepoints that carry no mouth shape of their own: their duration extends the previous key.
MODIFIERS = set("ˈˌːˑ̩̃ʰ")


@register("viseme_mapper", "oculus_ipa")
class OculusIpaMapper:
    def map(self, phonemes: Sequence[str], durations_ms: Sequence[int]) -> list[VisemeKey]:
        if len(phonemes) != len(durations_ms):
            raise ValueError("phonemes and durations_ms must be the same length")
        keys: list[VisemeKey] = []
        t = 0
        for ph, dur in zip(phonemes, durations_ms, strict=True):
            if ph in MODIFIERS and keys:
                t += dur
                continue
            v = IPA_TO_OCULUS.get(ph, "sil")
            if not keys or keys[-1].v.root != v:
                keys.append(VisemeKey(t=t, v=Viseme(v)))
            t += dur
        if not keys or keys[-1].v.root != "sil":
            keys.append(VisemeKey(t=t, v=Viseme("sil")))
        return keys
