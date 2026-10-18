"""OpenAI-compatible LLM provider against fake providers speaking the streaming wire format."""

import json
from dataclasses import replace
from pathlib import Path

import httpx2
import pytest

from kamari_avatar.config import BackendConfig, ComponentSpec, build
from kamari_avatar.director import Director
from kamari_avatar.impl.openai_llm import OpenAICompatibleLLM, ThinkFilter
from kamari_avatar.interfaces import ChatMessage, Done, TextDelta, ToolCall, ToolSpec, Usage
from kamari_avatar.session import Session

TEST_CONFIG = Path(__file__).with_name("backend.test.yaml")


def sse(*chunks):
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks] + ["data: [DONE]\n\n"]
    return "".join(lines).encode()


def chunk(delta=None, finish=None):
    return {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m",
            "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}


WALK_AND_TALK = sse(
    chunk({"role": "assistant", "content": "<think>they want the "}),
    chunk({"content": "window</think>Sure, "}),
    chunk({"content": "on my way."}),
    chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                           "function": {"name": "walk_to", "arguments": "{\"loca"}}]}),
    chunk({"tool_calls": [{"index": 0, "function": {"arguments": "tion\": \"window\"}"}}]}),
    chunk({}, "tool_calls"),
)


class FakeProvider:
    """Records requests and streams a canned completion, like any OpenAI-compatible server."""

    def __init__(self, body=WALK_AND_TALK, key=None):
        self.body, self.key, self.requests = body, key, []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.key and request.headers.get("authorization") != f"Bearer {self.key}":
            return httpx2.Response(401, json={"error": {"message": "bad key"}})
        return httpx2.Response(200, content=self.body, headers={"content-type": "text/event-stream"})

    def client(self):
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self))

    def sent(self, i=-1):
        return json.loads(self.requests[i].content)


async def collect(llm, messages, tools=()):
    return [ev async for ev in llm.stream(messages, list(tools))]


WALK = ToolSpec("walk_to", "Walk", {"type": "object", "properties": {"location": {"type": "string"}}}, "avatar")


async def test_streams_text_and_assembles_tool_calls(monkeypatch):
    monkeypatch.setenv("TEST_LLM_KEY", "sk-test")
    provider = FakeProvider(key="sk-test")
    llm = OpenAICompatibleLLM("qwen/qwen3-32b", base_url="https://llm.example/v1", api_key_env="TEST_LLM_KEY",
                              extra_body={"reasoning_effort": "none"}, http_client=provider.client())
    history = [ChatMessage("system", "be brief"), ChatMessage("user", "go to the window"),
               ChatMessage("assistant", "", tool_calls=(ToolCall("c0", "walk_to", {"location": "sofa"}),)),
               ChatMessage("tool", '{"status": "started"}', tool_call_id="c0")]
    events = await collect(llm, history, [WALK])
    text = "".join(e.text for e in events if isinstance(e, TextDelta))
    assert text == "Sure, on my way."  # the <think> block is gone
    assert ToolCall("call_1", "walk_to", {"location": "window"}) in events
    assert events[-1] == Done("tool_calls")

    body = provider.sent()
    assert str(provider.requests[0].url) == "https://llm.example/v1/chat/completions"
    assert body["model"] == "qwen/qwen3-32b" and body["stream"] is True and body["reasoning_effort"] == "none"
    assert body["tools"][0]["function"]["name"] == "walk_to"
    assert body["messages"][2]["tool_calls"][0]["function"] == {"name": "walk_to", "arguments": '{"location": "sofa"}'}
    assert body["messages"][3] == {"role": "tool", "content": '{"status": "started"}', "tool_call_id": "c0"}


async def test_local_server_needs_no_key():
    provider = FakeProvider(sse(chunk({"content": "Hi!"}), chunk({}, "stop")))
    llm = OpenAICompatibleLLM("qwen3:1.7b", base_url="http://localhost:11434/v1", api_key_env=None,
                              http_client=provider.client())
    assert await collect(llm, [ChatMessage("user", "hi")]) == [TextDelta("Hi!"), Done("stop")]
    assert "tools" not in provider.sent()


def test_missing_key_falls_back_to_the_configured_fallback(monkeypatch):
    monkeypatch.delenv("NOPE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="NOPE_KEY"):
        OpenAICompatibleLLM("m", api_key_env="NOPE_KEY")
    cfg = BackendConfig.load(TEST_CONFIG)
    cfg.llm = ComponentSpec(impl="openai_compatible", options={"model": "m", "api_key_env": "NOPE_KEY"},
                            fallback="fake", fallback_options={"reply": "My language model is not set up."})
    comps = build(cfg)
    assert comps.active["llm"] == "fake" and comps.llm.reply == "My language model is not set up."


async def test_reports_token_usage_from_the_last_chunk():
    # With include_usage the server ends with a chunk that has no choices, only usage.
    last = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [],
            "usage": {"prompt_tokens": 120, "completion_tokens": 7, "total_tokens": 127}}
    provider = FakeProvider(sse(chunk({"content": "Hi!"}), chunk({}, "stop"), last))
    llm = OpenAICompatibleLLM("m", api_key_env=None, http_client=provider.client())
    assert (await collect(llm, [ChatMessage("user", "hi")]))[-1] == Done("stop", Usage(120, 7))
    assert provider.sent()["stream_options"] == {"include_usage": True}


async def test_reports_groq_style_usage_and_can_skip_asking():
    last = chunk({}, "stop") | {"x_groq": {"usage": {"prompt_tokens": 50, "completion_tokens": 3}}}
    provider = FakeProvider(sse(chunk({"content": "Hi!"}), last))
    llm = OpenAICompatibleLLM("m", api_key_env=None, stream_usage=False, http_client=provider.client())
    assert (await collect(llm, [ChatMessage("user", "hi")]))[-1] == Done("stop", Usage(50, 3))
    assert "stream_options" not in provider.sent()


async def test_bad_tool_arguments_are_flagged():
    provider = FakeProvider(sse(chunk({"tool_calls": [{"index": 0, "id": "c", "type": "function",
                                                       "function": {"name": "walk_to", "arguments": "{oops"}}]}),
                                chunk({}, "tool_calls")))
    llm = OpenAICompatibleLLM("m", api_key_env=None, http_client=provider.client())
    events = await collect(llm, [ChatMessage("user", "go")], [WALK])
    assert events[0] == ToolCall("c", "walk_to", {"_invalid_json": "{oops"})


@pytest.mark.parametrize("pieces", [
    ["<think>x</think>Hello"],
    ["<thi", "nk>x</th", "ink>Hel", "lo"],
    ["<", "think>", "a<b", "</think", ">", "Hello"],
])
def test_think_filter_handles_split_tags(pieces):
    f = ThinkFilter()
    assert "".join(f.feed(p) for p in pieces) == "Hello"


def test_think_filter_passes_ordinary_text():
    f = ThinkFilter()
    assert f.feed("a < b and ") + f.feed("c > d") == "a < b and c > d"


class Out:
    def __init__(self):
        self.sent, self.director = [], None

    async def send_json(self, type_, data):
        self.sent.append((type_, data))
        if type_ == "speech_end":  # the browser finished playing it
            self.director.resolve(data["utterance_id"], {"type": "speech_finished"})

    async def send_bytes(self, frame):
        pass


async def test_same_conversation_runs_on_two_llm_configs(monkeypatch):
    """Swappability: a hosted provider and a local Ollama-style server, selected only by config."""
    monkeypatch.setenv("HOSTED_KEY", "sk-hosted")
    hosted, local = FakeProvider(key="sk-hosted"), FakeProvider()
    configs = [
        ({"model": "qwen/qwen3-32b", "base_url": "https://api.groq.com/openai/v1", "api_key_env": "HOSTED_KEY"}, hosted),
        ({"model": "qwen3:1.7b", "base_url": "http://localhost:11434/v1", "api_key_env": None}, local),
    ]
    for options, provider in configs:
        cfg = BackendConfig.load(TEST_CONFIG)
        cfg.llm = ComponentSpec(impl="openai_compatible", options=options)
        comps = build(cfg)
        assert comps.active["llm"] == "openai_compatible"
        comps = replace(comps, llm=OpenAICompatibleLLM(**options, http_client=provider.client()))
        out = Out()
        d = out.director = Director(Session(id="s", resume_token="t", room_id="studio"), comps, out, comps.director)
        result = await d.wait_turn(await d.converse("go to the window"), 5)
        assert result["reply"] == "Sure, on my way." and result["actions"] == ["walk_to(window)"]
        walk = next(data for t, data in out.sent if t == "walk_to")
        assert walk["target"] == {"location": "window"}
        assert provider.sent()["model"] == options["model"]
