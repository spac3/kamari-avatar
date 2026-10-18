from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from ..interfaces import ChatMessage
from ..registry import register


@register("conversation_store", "memory")
class MemoryConversationStore:
    """History per session, in memory. Keeps the newest `max_messages`, dropping the oldest exchanges
    whole (cut at a user message, so no tool result loses its call)."""

    def __init__(self, max_messages: int = 400) -> None:
        self._data: dict[str, list[ChatMessage]] = {}
        self.max_messages = max_messages

    def history(self, session_id: str) -> list[ChatMessage]:
        return list(self._data.get(session_id, []))

    def append(self, session_id: str, message: ChatMessage) -> None:
        msgs = self._data.setdefault(session_id, [])
        msgs.append(message)
        if len(msgs) > self.max_messages:
            cut = len(msgs) - self.max_messages
            while cut < len(msgs) - 1 and msgs[cut].role != "user":
                cut += 1
            del msgs[:cut]

    def rewrite_last_assistants(self, session_id: str, contents: Sequence[str | None]) -> None:
        msgs = self._data.get(session_id, [])
        newest = reversed([i for i, m in enumerate(msgs) if m.role == "assistant"])
        for i, content in zip(newest, reversed(contents), strict=False):
            if content is not None:
                msgs[i] = replace(msgs[i], content=content)

    def clear(self, session_id: str) -> None:
        self._data.pop(session_id, None)
