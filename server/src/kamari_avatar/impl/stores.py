from __future__ import annotations

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

    def truncate_last_assistant(self, session_id: str, heard_text: str) -> None:
        msgs = self._data.get(session_id, [])
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i].role == "assistant":
                msgs[i] = replace(msgs[i], content=heard_text + " [interrupted]")
                return

    def clear(self, session_id: str) -> None:
        self._data.pop(session_id, None)
