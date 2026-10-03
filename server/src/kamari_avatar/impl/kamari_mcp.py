"""Kamari's plugins exposed to the avatar's LLM, over MCP."""

from __future__ import annotations

import contextlib
from typing import Any

from ..interfaces import ToolResult, ToolSpec
from ..registry import register


@register("tool_provider", "kamari_mcp")
class KamariMcpToolProvider:
    """MCP client for the Kamari server.

    `url` connects over Streamable HTTP. `command` (+ `args`) launches Kamari as a stdio
    subprocess instead. Tool names are prefixed (`kamari.<tool>`) so they can't collide
    with the avatar's own tools.
    """

    def __init__(self, url: str | None = None, command: str | None = None, args: list[str] | None = None,
                 prefix: str = "kamari.", name: str = "kamari", timeout_s: float = 30.0, server: Any = None) -> None:
        if not (url or command or server is not None):
            raise ValueError("kamari_mcp needs `url` or `command`")
        self.name = name
        self.prefix = prefix
        self.timeout_s = timeout_s
        self._target: Any = server if server is not None else url
        if command:
            from mcp import StdioServerParameters

            self._target = StdioServerParameters(command=command, args=args or [])
        self._stack: contextlib.AsyncExitStack | None = None
        self._client: Any = None

    async def start(self) -> None:
        from mcp import Client

        self._stack = contextlib.AsyncExitStack()
        self._client = await self._stack.enter_async_context(Client(self._target))

    async def stop(self) -> None:
        if self._stack:
            await self._stack.aclose()
        self._stack = self._client = None

    async def list_tools(self) -> list[ToolSpec]:
        result = await self._require().list_tools()
        return [
            ToolSpec(self.prefix + t.name, t.description or "", dict(t.input_schema or {"type": "object"}), self.name)
            for t in result.tools
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        raw = name.removeprefix(self.prefix)
        result = await self._require().call_tool(raw, arguments, read_timeout_seconds=self.timeout_s)
        if result.structured_content is not None:
            content: Any = result.structured_content
        else:
            content = "\n".join(getattr(c, "text", "") for c in result.content if getattr(c, "type", "") == "text")
        return ToolResult(content, bool(result.is_error))

    def _require(self) -> Any:
        if self._client is None:
            raise RuntimeError("KamariMcpToolProvider.start() has not been called")
        return self._client
