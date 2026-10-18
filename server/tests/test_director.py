"""The conversation loop: LLM text spoken sentence by sentence, tool calls validated and queued."""

import asyncio
import json
from dataclasses import replace
from pathlib import Path

import pytest

from kamari_avatar.config import BackendConfig, build
from kamari_avatar.director import Director
from kamari_avatar.impl.fakes import FakeToolProvider
from kamari_avatar.interfaces import AudioSegment, Done, TextDelta, ToolCall
from kamari_avatar.session import Session

TEST_CONFIG = Path(__file__).with_name("backend.test.yaml")


class ScriptedLLM:
    """Plays one scripted reply per call and records what it was sent."""

    def __init__(self, *replies, delay_s=0.0):
        self.replies = list(replies)
        self.calls = []
        self.delay_s = delay_s

    async def stream(self, messages, tools):
        self.calls.append({"messages": list(messages), "tools": [t.name for t in tools]})
        for ev in self.replies.pop(0) if self.replies else [TextDelta("Okay."), Done()]:
            if self.delay_s:
                await asyncio.sleep(self.delay_s)
            yield ev


class Browser:
    """Stands in for the WebSocket: records what the Director sends and answers like the client would."""

    def __init__(self, auto=True):
        self.sent = []
        self.director = None
        self.auto = auto

    async def send_json(self, type_, data):
        self.sent.append((type_, data))
        if not self.auto:
            return
        d = self.director
        if type_ == "walk_to":
            loop = asyncio.get_running_loop()
            loop.call_later(0.05, d.resolve, data["cmd_id"], {"type": "arrived", "location": data["target"]["location"]})
        elif type_ == "gesture":
            d.resolve(data["cmd_id"], {"type": "gesture_finished"})
        elif type_ == "speech_end":
            d.on_speech_started(data["utterance_id"])
            d.resolve(data["utterance_id"], {"type": "speech_finished", "interrupted": False})
            await d.on_speech_finished(data["utterance_id"], False, 1000)

    async def send_bytes(self, frame):
        self.sent.append(("audio", len(frame)))

    def types(self):
        return [t for t, _ in self.sent if t != "audio"]

    def of(self, type_):
        return [d for t, d in self.sent if t == type_]


def make(llm, browser=None, providers=()):
    comps = build(BackendConfig.load(TEST_CONFIG))
    comps = replace(comps, llm=llm, tool_providers=list(providers))
    browser = browser or Browser()
    session = Session(id="s_test", resume_token="rt", room_id="studio")
    d = Director(session, comps, browser, comps.director)
    browser.director = d
    return d, browser


async def run(d, text):
    turn = await d.converse(text)
    return await d.wait_turn(turn, 5)


async def test_speaks_sentences_as_they_stream_and_walks_then_waves():
    llm = ScriptedLLM([TextDelta("Sure, "), TextDelta("I'll head to the window. "), TextDelta("Then I'll wave."),
                       ToolCall("c1", "walk_to", {"location": "window"}), ToolCall("c2", "gesture", {"name": "wave"}),
                       Done("tool_calls")])
    d, browser = make(llm)
    result = await run(d, "go to the window and wave")
    assert result["type"] == "turn_done" and result["actions"] == ["walk_to(window)", "gesture(wave)"]
    await asyncio.sleep(0.1)  # the wave goes out once the walk has arrived
    types = browser.types()
    assert types.index("walk_to") < types.index("gesture")
    chunks = browser.of("speech_chunk")
    assert [c["text"] for c in chunks] == ["Sure, I'll head to the window.", "Then I'll wave."]
    assert len(llm.calls) == 1  # avatar tools need no second LLM round
    tools = llm.calls[0]["tools"]
    assert tools == ["walk_to", "gesture", "look_at", "stop_moving"]
    # history stays valid for the next request: every tool call has a result
    history = d.comps.store.history("s_test")
    assert [m.role for m in history] == ["user", "assistant", "tool", "tool"]
    assert json.loads(history[2].content) == {"status": "started"}
    assert json.loads(history[3].content) == {"status": "queued"}
    timing = result["timing"]
    assert {"llm_first_token_ms", "first_sentence_ms", "tts_first_audio_ms"} <= timing.keys()


async def test_arrival_is_told_to_the_llm_next_turn():
    llm = ScriptedLLM([ToolCall("c1", "walk_to", {"location": "sofa"}), Done("tool_calls")], [TextDelta("Hi."), Done()])
    d, _ = make(llm)
    await run(d, "go to the sofa")
    await asyncio.sleep(0.1)
    await run(d, "where are you?")
    system = llm.calls[1]["messages"][0].content
    assert "You arrived at the sofa." in system


async def test_invalid_tool_call_goes_back_to_the_llm():
    llm = ScriptedLLM([ToolCall("c1", "walk_to", {"location": "moon"}), Done("tool_calls")],
                      [TextDelta("I can't go there."), Done()])
    d, browser = make(llm)
    result = await run(d, "go to the moon")
    assert "walk_to" not in browser.types()
    assert len(llm.calls) == 2 and result["reply"] == "I can't go there."
    tool_msg = llm.calls[1]["messages"][-1]
    assert tool_msg.role == "tool" and "'moon' is not one of" in tool_msg.content


async def test_kamari_tool_results_get_a_second_round():
    provider = FakeToolProvider("kamari", tools=[{"name": "kamari__tasks_list", "description": "List tasks"}])
    llm = ScriptedLLM([ToolCall("c1", "kamari__tasks_list", {"day": "today"}), Done("tool_calls")],
                      [TextDelta("You have two tasks."), Done()])
    d, _ = make(llm, providers=[provider])
    result = await run(d, "what's on today?")
    assert provider.calls == [("kamari__tasks_list", {"day": "today"})]
    assert "kamari__tasks_list" in llm.calls[0]["tools"]
    assert json.loads(llm.calls[1]["messages"][-1].content)["tool"] == "kamari__tasks_list"
    assert result["reply"] == "You have two tasks."


async def test_tool_rounds_are_capped():
    loop_call = [ToolCall("c", "walk_to", {"location": "nowhere"}), Done("tool_calls")]
    llm = ScriptedLLM(*[list(loop_call) for _ in range(10)])
    d, _ = make(llm)
    await run(d, "go")
    assert len(llm.calls) == d.settings.max_tool_rounds + 1
    assert llm.calls[-1]["tools"] == []  # the last round must answer in words


async def test_interrupting_keeps_only_what_was_heard():
    llm = ScriptedLLM([TextDelta("First sentence here. "), TextDelta("Second sentence here. "),
                       TextDelta("Third sentence that never gets said."), Done()], delay_s=0.05)
    d, browser = make(llm, Browser(auto=False))
    await d.converse("tell me a story")
    while len(browser.of("speech_chunk")) < 1:
        await asyncio.sleep(0.01)
    uid = browser.of("speech_start")[0]["utterance_id"]
    await d.on_speech_finished(uid, interrupted=True, played_ms=100)  # user pressed talk mid-sentence
    history = d.comps.store.history("s_test")
    assert history[-1].role == "assistant" and history[-1].content == "First sentence here. [interrupted]"
    assert "speech_cancel" in browser.types()


async def test_cancelled_turn_answers_its_tool_calls():
    llm = ScriptedLLM([ToolCall("c1", "walk_to", {"location": "sofa"}), Done("tool_calls")])
    d, _ = make(llm, Browser(auto=False))
    provider = FakeToolProvider("kamari", tools=[{"name": "slow"}])

    async def slow(name, args):
        await asyncio.sleep(10)

    provider.call_tool = slow
    d.comps.tool_providers.append(provider)
    llm.replies = [[ToolCall("c1", "slow", {}), ToolCall("c2", "walk_to", {"location": "sofa"}), Done("tool_calls")]]
    await d.converse("do it")
    await asyncio.sleep(0.05)
    await d.converse("never mind")
    await asyncio.sleep(0.05)
    roles = [(m.role, m.tool_call_id) for m in d.comps.store.history("s_test")]
    assert roles[:4] == [("user", None), ("assistant", None), ("tool", "c1"), ("tool", "c2")]


async def test_push_to_talk_transcribes_and_answers():
    llm = ScriptedLLM([TextDelta("On my way."), ToolCall("c1", "walk_to", {"location": "sofa"}), Done("tool_calls")])
    d, browser = make(llm)
    await d.ptt_down(7)
    d.mic_audio(7, b"\x10\x00" * 1600)
    d.mic_audio(8, b"\xff\x7f" * 1600)  # a different press: ignored
    assert d.session.speech == "listening"
    turn = await d.ptt_up()
    result = await d.wait_turn(turn, 5)
    assert browser.of("listening") == [{"mode": "ptt"}, {"mode": "off"}]
    assert browser.of("transcript") == [{"text": "go to the sofa", "final": True}]  # the fake STT
    assert result["transcript"] == "go to the sofa" and "stt_ms" in result["timing"]
    assert llm.calls[0]["messages"][-1].content == "go to the sofa"


async def test_empty_transcript_ends_the_turn_quietly():
    class Silent:
        async def transcribe(self, segment: AudioSegment):
            from kamari_avatar.interfaces import Transcript
            return Transcript("")

    llm = ScriptedLLM()
    d, browser = make(llm)
    d.comps = replace(d.comps, stt=Silent())
    await d.ptt_down(1)
    turn = await d.ptt_up()
    await d.wait_turn(turn, 5)
    assert llm.calls == [] and d.session.speech == "silent"
    assert browser.of("turn_timing")


@pytest.mark.parametrize("failing", ["stt", "llm"])
async def test_engine_failures_are_reported(failing):
    class Broken:
        async def transcribe(self, segment):
            raise RuntimeError("no model")

        async def stream(self, messages, tools):
            raise RuntimeError("provider down")
            yield

    d, browser = make(ScriptedLLM())
    d.comps = replace(d.comps, **{failing: Broken()})
    await d.ptt_down(1)
    await d.wait_turn(await d.ptt_up(), 5)
    err = browser.of("error")
    assert err and err[0]["code"] == f"{failing}_failed"
