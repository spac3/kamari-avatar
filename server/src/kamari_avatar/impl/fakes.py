"""Fake implementations: deterministic, dependency-free stand-ins for every engine.

They let the rest of the system run end to end in tests and on machines without
models installed. Select them with `impl: fake` in config/backend.yaml.
"""

from __future__ import annotations

import asyncio
import math
import struct
from collections.abc import AsyncIterator, Sequence
from typing import Any

from ..interfaces import (
    AudioSegment,
    ChatMessage,
    Done,
    LLMEvent,
    SynthChunk,
    TextDelta,
    ToolCall,
    ToolResult,
    ToolSpec,
    Transcript,
)
from ..registry import register


@register("vad", "fake")
class FakeVAD:
    """Counts 20 ms frames whose peak passes a fixed threshold. Good enough for tests, not for real rooms."""

    def __init__(self, threshold: int = 500) -> None:
        self.threshold = threshold

    def speech_ms(self, segment: AudioSegment) -> int:
        frame = segment.sample_rate // 50 * 2
        loud = 0
        for i in range(0, len(segment.pcm) - frame + 1, frame):
            n = frame // 2
            if max(abs(v) for v in struct.unpack(f"<{n}h", segment.pcm[i:i + frame])) > self.threshold:
                loud += 1
        return loud * 20


@register("stt", "fake")
class FakeSTT:
    def __init__(self, transcript: str = "hello") -> None:
        self.transcript = transcript

    async def transcribe(self, segment: AudioSegment) -> Transcript:
        return Transcript(self.transcript)


@register("llm", "fake")
class FakeLLM:
    """Streams a fixed reply word by word, then optional tool calls (`tool_call` or a `tool_calls` list)."""

    def __init__(self, reply: str = "Hello!", tool_call: dict[str, Any] | None = None,
                 tool_calls: list[dict[str, Any]] | None = None, delay_s: float = 0.0) -> None:
        self.reply = reply
        self.tool_calls = list(tool_calls or []) + ([tool_call] if tool_call else [])
        self.delay_s = delay_s

    async def stream(self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec]) -> AsyncIterator[LLMEvent]:
        words = self.reply.split(" ")
        for i, w in enumerate(words):
            if self.delay_s:
                await asyncio.sleep(self.delay_s)
            yield TextDelta(w if i == 0 else " " + w)
        names = {t.name for t in tools}
        calls = [c for c in self.tool_calls if c["name"] in names]
        for i, c in enumerate(calls):
            yield ToolCall(f"call_fake_{i + 1}", c["name"], dict(c.get("arguments", {})))
        yield Done("tool_calls" if calls else "stop")


# Rough phoneme stand-ins per letter so fake speech still produces moving visemes.
_LETTER_PHONEME = {
    "a": "a", "e": "ɛ", "i": "ɪ", "o": "ɔ", "u": "ʊ", "y": "i", "b": "b", "p": "p", "m": "m", "f": "f",
    "v": "v", "t": "t", "d": "d", "k": "k", "c": "k", "g": "g", "q": "k", "s": "s", "z": "z", "x": "s",
    "n": "n", "l": "l", "r": "ɹ", "w": "w", "j": "ʒ", "h": "h",
}


@register("tts", "fake")
class FakeTTS:
    """Emits a quiet tone per sentence with letter-based phoneme timings (80 ms each)."""

    def __init__(self, sample_rate: int = 22050, ms_per_phoneme: int = 80) -> None:
        self.sample_rate = sample_rate
        self.ms_per_phoneme = ms_per_phoneme

    async def synth(self, text: str, voice: str | None = None) -> AsyncIterator[SynthChunk]:
        phonemes = [(_LETTER_PHONEME.get(ch.lower(), " ")) for ch in text if ch.isalpha() or ch == " "]
        durations = [self.ms_per_phoneme] * len(phonemes)
        n = self.sample_rate * sum(durations) // 1000
        tone = (int(800 * math.sin(2 * math.pi * 220 * i / self.sample_rate)) for i in range(n))
        pcm = struct.pack(f"<{n}h", *tone)
        yield SynthChunk(pcm, self.sample_rate, phonemes, durations)


@register("tool_provider", "fake")
class FakeToolProvider:
    """Echoes calls back. Stands in for Kamari's MCP tools in tests."""

    def __init__(self, name: str = "fake", tools: list[dict[str, Any]] | None = None) -> None:
        self.name = name
        self._tools = [
            ToolSpec(t["name"], t.get("description", ""), t.get("parameters", {"type": "object"}), self.name)
            for t in (tools or [{"name": "echo", "description": "Echo the arguments back"}])
        ]
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    async def list_tools(self) -> list[ToolSpec]:
        return list(self._tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, arguments))
        return ToolResult({"tool": name, "arguments": arguments})
