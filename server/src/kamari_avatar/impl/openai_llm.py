"""LLM over the OpenAI-compatible chat completions API: streaming text plus tool calls.

Nearly every provider speaks this API, hosted (Groq, OpenRouter, Together, DeepInfra...) or
local (Ollama, llama.cpp server, vLLM), so switching provider or model is a config change:
`base_url`, `model` and the env var holding the key.

Licence note: the client is the `openai` SDK (Apache-2.0). A hosted service is the one
proprietary, paid part of the stack; pick an open-weight model so the same model can run
locally later.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator, Sequence
from typing import Any

from ..interfaces import ChatMessage, Done, LLMEvent, TextDelta, ToolCall, ToolSpec, Usage
from ..registry import register

log = logging.getLogger(__name__)

_FINISH = {"stop": "stop", "tool_calls": "tool_calls", "function_call": "tool_calls", "length": "length"}


@register("llm", "openai_compatible")
class OpenAICompatibleLLM:
    """Options (config/backend.yaml):
      model        model id at the provider, e.g. qwen/qwen3-32b or qwen3:1.7b (Ollama)
      base_url     provider endpoint, e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1
      api_key_env  env var holding the API key; null for local servers that need none
      temperature, max_tokens
      timeout_s    per request
      extra_body   provider-specific fields sent as is (e.g. {reasoning_effort: none})
      strip_think  drop <think>...</think> blocks reasoning models put in the text
      stream_usage ask for token counts at the end of the stream (stream_options.include_usage);
                   turn off for a server that rejects the option
    """

    def __init__(self, model: str, *, base_url: str | None = None, api_key_env: str | None = "LLM_API_KEY",
                 temperature: float = 0.6, max_tokens: int = 400, timeout_s: float = 30.0,
                 extra_body: dict[str, Any] | None = None, strip_think: bool = True, stream_usage: bool = True,
                 http_client: Any = None) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as e:
            raise RuntimeError("openai is not installed: pip install openai") from e
        key = "none"  # local servers ignore it, but the SDK insists on one
        if api_key_env:
            key = os.environ.get(api_key_env, "")
            if not key:
                raise RuntimeError(f"set {api_key_env} to the LLM provider's API key")
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.extra_body = dict(extra_body or {})
        self.strip_think = strip_think
        self.stream_usage = stream_usage
        self._client = AsyncOpenAI(api_key=key, base_url=base_url, timeout=timeout_s, max_retries=1,
                                   http_client=http_client)

    async def stream(self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec]) -> AsyncIterator[LLMEvent]:
        kwargs: dict[str, Any] = {}
        if tools:
            kwargs["tools"] = [{"type": "function", "function": {"name": t.name, "description": t.description,
                                                                 "parameters": t.parameters}} for t in tools]
        if self.extra_body:
            kwargs["extra_body"] = self.extra_body
        if self.stream_usage:
            kwargs["stream_options"] = {"include_usage": True}
        stream = await self._client.chat.completions.create(
            model=self.model, messages=[_to_openai(m) for m in messages], stream=True,
            temperature=self.temperature, max_tokens=self.max_tokens, **kwargs)
        calls: dict[int, dict[str, str]] = {}
        think = ThinkFilter() if self.strip_think else None
        reason = "stop"
        usage: Usage | None = None
        try:
            async for chunk in stream:
                usage = _usage(chunk) or usage
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if delta is not None and delta.content:
                    text = think.feed(delta.content) if think else delta.content
                    if text:
                        yield TextDelta(text)
                for tc in (delta.tool_calls or []) if delta is not None else []:
                    # Arguments arrive in pieces; the id and name come with the first piece.
                    acc = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    acc["id"] = tc.id or acc["id"]
                    if tc.function is not None:
                        acc["name"] += tc.function.name or ""
                        acc["arguments"] += tc.function.arguments or ""
                if choice.finish_reason:
                    reason = _FINISH.get(choice.finish_reason, "stop")
        finally:
            await stream.close()  # stops the provider generating if the consumer stopped early
        for i in sorted(calls):
            c = calls[i]
            yield ToolCall(c["id"] or f"call_{i}", c["name"], _parse_args(c["arguments"]))
        yield Done("tool_calls" if calls else reason, usage)


def _usage(chunk: Any) -> Usage | None:
    """Token counts if this chunk carries them: the standard `usage` (the last chunk, with
    include_usage), or Groq's `x_groq.usage`."""
    u = getattr(chunk, "usage", None)
    if u is None:
        u = ((getattr(chunk, "model_extra", None) or {}).get("x_groq") or {}).get("usage")
    if u is None:
        return None
    get = u.get if isinstance(u, dict) else lambda k: getattr(u, k, None)
    return Usage(int(get("prompt_tokens") or 0), int(get("completion_tokens") or 0))


def _parse_args(raw: str) -> dict[str, Any]:
    if not raw.strip():
        return {}
    try:
        args = json.loads(raw)
    except ValueError:
        log.warning("LLM sent tool arguments that are not JSON: %r", raw[:200])
        return {"_invalid_json": raw}
    return args if isinstance(args, dict) else {"_invalid_json": raw}


def _to_openai(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": m.role, "content": m.content}
    if m.role == "tool":
        out["tool_call_id"] = m.tool_call_id
    if m.tool_calls:
        out["tool_calls"] = [{"id": c.id, "type": "function",
                              "function": {"name": c.name, "arguments": json.dumps(c.arguments)}} for c in m.tool_calls]
    return out


class ThinkFilter:
    """Removes <think>...</think> from streamed text, even when a tag is split across deltas."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self._buf = ""
        self._inside = False

    def feed(self, text: str) -> str:
        self._buf += text
        out = []
        while self._buf:
            tag = self.CLOSE if self._inside else self.OPEN
            i = self._buf.find(tag)
            if i >= 0:
                if not self._inside:
                    out.append(self._buf[:i])
                self._buf = self._buf[i + len(tag):]
                self._inside = not self._inside
                continue
            # Keep a tail that could be the start of a tag split across deltas.
            keep = next((k for k in range(min(len(tag) - 1, len(self._buf)), 0, -1)
                         if tag.startswith(self._buf[-k:])), 0)
            if not self._inside:
                out.append(self._buf[: len(self._buf) - keep])
            self._buf = self._buf[len(self._buf) - keep:]
            break
        return "".join(out)
