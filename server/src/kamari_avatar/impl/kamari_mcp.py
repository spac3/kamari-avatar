"""Kamari's plugins exposed to the avatar's LLM, over MCP.

Kamari (the user's own MCP server) speaks protocol 2024-11-05 over Streamable HTTP at
`POST /mcp`, answers with plain JSON, requires a Bearer API key on every call, filters
tools/list by the key's capabilities, and sends no listChanged notifications (plugins
hot-reload, so we re-poll). Results arrive as one text item holding the plugin's dict
as JSON. Calls are synchronous and may take long.

Kamari exposes ~300 tools, including payments, infrastructure and secrets. The avatar
only ever sees tools that pass BOTH the key's server-side capabilities and the
allow/deny globs here.
"""

from __future__ import annotations

import contextlib
import fnmatch
import json
import os
import re
import time
from typing import Any

from ..interfaces import ToolResult, ToolSpec
from ..registry import register

# Never offered to a voice-driven LLM, whatever the allowlist says. Narrow with care.
ALWAYS_DENY = [
    "investec_*", "terraform_*", "ansible_*", "exec_*", "vault_*", "files_*", "backup_*",
    "config_*", "email_*", "sms_*", "pushover_*", "telegram_*", "pipelines_*", "quest_*",
]

_SAFE_NAME = re.compile(r"[^a-zA-Z0-9_-]")


@register("tool_provider", "kamari_mcp")
class KamariMcpToolProvider:
    """MCP client for the Kamari server.

    Options (config/backend.yaml):
      url          Kamari's MCP endpoint, e.g. https://kamari.example/mcp
      api_key_env  env var holding a Bearer key dedicated to the avatar (default KAMARI_API_KEY)
      allow        glob patterns of Kamari tool names the avatar may use (default: none)
      deny         extra globs to block on top of ALWAYS_DENY
      prefix       added to tool names given to the LLM; LLM APIs only accept [a-zA-Z0-9_-]
      refresh_s    how long a tools/list result is reused before re-polling
      timeout_s    per-call timeout; Kamari's own job timeout is longer
      command/args launch a stdio MCP server instead of `url` (Kamari has no stdio today)
    """

    def __init__(self, url: str | None = None, *, api_key_env: str = "KAMARI_API_KEY", allow: list[str] | None = None,
                 deny: list[str] | None = None, prefix: str = "kamari__", refresh_s: float = 300.0,
                 timeout_s: float = 60.0, mode: str = "legacy", command: str | None = None,
                 args: list[str] | None = None, name: str = "kamari", server: Any = None,
                 http_client_factory: Any = None) -> None:
        if not (url or command or server is not None):
            raise ValueError("kamari_mcp needs `url` or `command`")
        if _SAFE_NAME.search(prefix):
            raise ValueError("prefix may only contain letters, digits, '_' and '-'")
        self.name = name
        self.url = url
        self.prefix = prefix
        self.allow = list(allow or [])
        self.deny = ALWAYS_DENY + list(deny or [])
        self.refresh_s = refresh_s
        self.timeout_s = timeout_s
        self.mode = mode
        self.api_key_env = api_key_env
        self._command = (command, args or [])
        self._server = server
        self._http_client_factory = http_client_factory
        self._stack: contextlib.AsyncExitStack | None = None
        self._client: Any = None
        self._tools: list[ToolSpec] = []
        self._tools_at = float("-inf")
        self._by_llm_name: dict[str, str] = {}

    def allowed(self, tool: str) -> bool:
        if any(fnmatch.fnmatchcase(tool, p) for p in self.deny):
            return False
        return any(fnmatch.fnmatchcase(tool, p) for p in self.allow)

    async def start(self) -> None:
        from mcp import Client, StdioServerParameters
        from mcp.client.streamable_http import streamable_http_client

        self._stack = contextlib.AsyncExitStack()
        if self._server is not None:
            target: Any = self._server
        elif self._command[0]:
            target = StdioServerParameters(command=self._command[0], args=self._command[1])
        else:
            key = os.environ.get(self.api_key_env)
            if not key:
                raise RuntimeError(f"set {self.api_key_env} to a Kamari API key for the avatar")
            http = self._make_http_client({"Authorization": f"Bearer {key}"})
            await self._stack.enter_async_context(http)
            target = streamable_http_client(self.url, http_client=http, terminate_on_close=False)
        self._client = await self._stack.enter_async_context(Client(target, mode=self.mode))

    def _make_http_client(self, headers: dict[str, str]) -> Any:
        if self._http_client_factory:
            return self._http_client_factory(headers)
        import httpx2

        # Long read timeout: Kamari's tools/call blocks until the tool finishes.
        return httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(10.0, read=self.timeout_s + 5))

    async def stop(self) -> None:
        if self._stack:
            await self._stack.aclose()
        self._stack = self._client = None

    async def list_tools(self, force: bool = False) -> list[ToolSpec]:
        if not force and time.monotonic() - self._tools_at < self.refresh_s:
            return list(self._tools)
        result = await self._require().list_tools(cache_mode="bypass")
        tools, by_name = [], {}
        for t in result.tools:
            if not self.allowed(t.name):
                continue
            llm_name = self.prefix + _SAFE_NAME.sub("_", t.name)
            by_name[llm_name] = t.name
            tools.append(ToolSpec(llm_name, t.description or "", dict(t.input_schema or {"type": "object"}), self.name))
        self._tools, self._by_llm_name, self._tools_at = tools, by_name, time.monotonic()
        return list(tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        raw = self._by_llm_name.get(name)
        if raw is None or not self.allowed(raw):
            return ToolResult(f"tool {name!r} is not available to the avatar", is_error=True)
        result = await self._require().call_tool(raw, arguments, read_timeout_seconds=self.timeout_s)
        if result.structured_content is not None:
            return ToolResult(result.structured_content, bool(result.is_error))
        text = "\n".join(getattr(c, "text", "") for c in result.content if getattr(c, "type", "") == "text")
        try:
            content: Any = json.loads(text)  # Kamari serialises the plugin's dict as one text item
        except ValueError:
            content = text
        return ToolResult(content, bool(result.is_error))

    def _require(self) -> Any:
        if self._client is None:
            raise RuntimeError("KamariMcpToolProvider.start() has not been called")
        return self._client
