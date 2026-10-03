"""Swappable component interfaces for the avatar backend.

Nothing outside an implementation module imports a concrete engine (Whisper, Piper,
an LLM SDK, MCP). Code depends on these Protocols, and `config/backend.yaml` picks
the implementation through the registry. Every interface has a `fake` implementation.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from .protocol import Viseme, VisemeKey

# ---------------------------------------------------------------- data types


@dataclass(frozen=True)
class AudioSegment:
    """One utterance of user speech: PCM16 mono."""

    pcm: bytes
    sample_rate: int = 16000


@dataclass(frozen=True)
class Transcript:
    text: str
    final: bool = True
    language: str | None = None


@dataclass(frozen=True)
class SynthChunk:
    """A piece of synthesized speech, with phoneme timings when the engine provides them."""

    pcm: bytes
    sample_rate: int
    phonemes: Sequence[str] | None = None
    phoneme_ms: Sequence[int] | None = None  # duration of each phoneme, same length as `phonemes`

    @property
    def duration_ms(self) -> int:
        return len(self.pcm) // 2 * 1000 // self.sample_rate


@dataclass(frozen=True)
class ToolSpec:
    """A tool the LLM may call. `parameters` is a JSON Schema object."""

    name: str
    description: str
    parameters: dict[str, Any]
    source: str = ""  # which ToolProvider owns it


@dataclass(frozen=True)
class ToolResult:
    content: Any
    is_error: bool = False


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None
    tool_calls: Sequence[ToolCall] = ()


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Done:
    reason: Literal["stop", "tool_calls", "length", "cancelled"] = "stop"


LLMEvent = TextDelta | ToolCall | Done


@dataclass(frozen=True)
class Location:
    name: str
    label: str
    x: float
    z: float
    heading_deg: float


# ---------------------------------------------------------------- interfaces


@runtime_checkable
class VAD(Protocol):
    """Server-side voice activity confirmation. Returns "start"/"end" on transitions."""

    def feed(self, pcm: bytes) -> Literal["start", "end"] | None: ...
    def reset(self) -> None: ...


@runtime_checkable
class STTEngine(Protocol):
    async def transcribe(self, segment: AudioSegment) -> Transcript: ...


@runtime_checkable
class LLMProvider(Protocol):
    """Streams text and tool calls. Must stop promptly when the consumer stops iterating."""

    def stream(self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec]) -> AsyncIterator[LLMEvent]: ...


@runtime_checkable
class TTSEngine(Protocol):
    sample_rate: int

    def synth(self, text: str, voice: str | None = None) -> AsyncIterator[SynthChunk]: ...


@runtime_checkable
class VisemeMapper(Protocol):
    def map(self, phonemes: Sequence[str], durations_ms: Sequence[int]) -> list[VisemeKey]: ...


@runtime_checkable
class SentenceChunker(Protocol):
    """Turns streamed LLM text into speakable pieces as early as possible."""

    def feed(self, delta: str) -> list[str]: ...
    def flush(self) -> list[str]: ...


@runtime_checkable
class ConversationStore(Protocol):
    def history(self, session_id: str) -> list[ChatMessage]: ...
    def append(self, session_id: str, message: ChatMessage) -> None: ...
    def truncate_last_assistant(self, session_id: str, heard_text: str) -> None:
        """After a barge-in, keep only what the user actually heard."""
        ...
    def clear(self, session_id: str) -> None: ...


@runtime_checkable
class RoomRegistry(Protocol):
    manifest_version: str
    room_id: str

    def locations(self) -> list[Location]: ...
    def location(self, name: str) -> Location | None: ...
    def gestures(self) -> list[str]: ...
    def manifest(self) -> dict[str, Any]: ...


@runtime_checkable
class ToolProvider(Protocol):
    """A source of tools for the LLM: the avatar itself, or Kamari's plugins over MCP."""

    name: str

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def list_tools(self) -> list[ToolSpec]: ...
    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult: ...


__all__ = [
    "VAD",
    "AudioSegment",
    "ChatMessage",
    "ConversationStore",
    "Done",
    "LLMEvent",
    "LLMProvider",
    "Location",
    "RoomRegistry",
    "STTEngine",
    "SentenceChunker",
    "SynthChunk",
    "TTSEngine",
    "TextDelta",
    "ToolCall",
    "ToolProvider",
    "ToolResult",
    "ToolSpec",
    "Transcript",
    "Viseme",
    "VisemeKey",
    "VisemeMapper",
]
