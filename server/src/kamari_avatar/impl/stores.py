from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from ..interfaces import ChatMessage
from ..registry import register


@register("conversation_store", "memory")
class MemoryConversationStore:
    def __init__(self) -> None:
        self._data: dict[str, list[ChatMessage]] = {}

    def history(self, session_id: str) -> list[ChatMessage]:
        return list(self._data.get(session_id, []))

    def append(self, session_id: str, message: ChatMessage) -> None:
        self._data.setdefault(session_id, []).append(message)

    def rewrite_last_assistants(self, session_id: str, contents: Sequence[str | None]) -> None:
        msgs = self._data.get(session_id, [])
        newest = reversed([i for i, m in enumerate(msgs) if m.role == "assistant"])
        for i, content in zip(newest, reversed(contents), strict=False):
            if content is not None:
                msgs[i] = replace(msgs[i], content=content)

    def clear(self, session_id: str) -> None:
        self._data.pop(session_id, None)
