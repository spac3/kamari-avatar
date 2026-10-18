"""Open mic: barge-in, segments without speech, the avatar's own echo, walking and talking at once."""

import asyncio
import math
import struct
from dataclasses import replace

from test_director import Browser, ScriptedLLM, make

from kamari_avatar.echo import is_echo
from kamari_avatar.impl.vad import EnergyVAD
from kamari_avatar.interfaces import AudioSegment, Done, TextDelta, ToolCall, Transcript


def tone(ms, amp=6000, hz=220, rate=16000):
    n = rate * ms // 1000
    return struct.pack(f"<{n}h", *(round(amp * math.sin(2 * math.pi * hz * i / rate)) for i in range(n)))


def hiss(ms, amp=40, rate=16000):
    n = rate * ms // 1000
    return struct.pack(f"<{n}h", *(((i * 7919) % (2 * amp + 1)) - amp for i in range(n)))


class HeardSTT:
    def __init__(self, text):
        self.text = text
        self.calls = 0

    async def transcribe(self, segment):
        self.calls += 1
        return Transcript(self.text)


def test_energy_vad_counts_speech_above_the_noise_floor():
    vad = EnergyVAD()
    assert vad.speech_ms(AudioSegment(hiss(300) + tone(400) + hiss(300))) == 400
    assert vad.speech_ms(AudioSegment(hiss(1000))) == 0  # room noise
    assert vad.speech_ms(AudioSegment(hiss(400) + tone(40) + hiss(400))) == 40  # a knock
    assert vad.speech_ms(AudioSegment(tone(600))) == 600  # talking the whole time: no floor of its own
    assert vad.speech_ms(AudioSegment(b"")) == 0


def test_echo_is_the_avatars_own_words_but_never_one_word():
    said = ["Sure, I'll head to the window.", "Then I will wave at you."]
    assert is_echo("I'll head to the window", said)
    assert is_echo("then I will wave at", said)
    assert not is_echo("no, go to the sofa instead", said)
    assert not is_echo("wave", said)  # one word: could be the user, and "stop" must always work
    assert not is_echo("window please", [])


async def test_speaking_over_the_avatar_cuts_its_reply_to_what_was_heard():
    llm = ScriptedLLM([TextDelta("First sentence here. "), TextDelta("Second sentence here. "),
                       TextDelta("Third sentence that never gets said."), Done()],
                      [TextDelta("Okay, I'll stop."), Done()], delay_s=0.05)
    d, browser = make(llm, Browser(auto=False))
    d.comps = replace(d.comps, stt=HeardSTT("wait, stop"))
    await d.converse("tell me a story")
    while len(browser.of("speech_chunk")) < 1:
        await asyncio.sleep(0.01)
    uid = browser.of("speech_start")[0]["utterance_id"]
    # What the browser sends on a barge-in: how much it played, then the segment.
    await d.on_speech_finished(uid, interrupted=True, played_ms=100)
    await d.user_speech_start(3, "talking")
    d.mic_audio(3, hiss(200) + tone(500) + hiss(200))
    turn = await d.user_speech_end()
    assert turn is not None
    await asyncio.wait([d._last_turn.task])
    history = [(m.role, m.content) for m in d.comps.store.history("s_test")]
    assert history[:4] == [("user", "tell me a story"), ("assistant", "First sentence here. [interrupted]"),
                           ("user", "wait, stop"), ("assistant", "Okay, I'll stop.")]
    assert browser.of("listening") == [{"mode": "open_mic"}, {"mode": "off"}]
    assert d.stats["barge_ins"] == 1 and d.stats["segments"] == 1


async def test_user_speech_while_the_avatar_thinks_replaces_the_turn():
    llm = ScriptedLLM([TextDelta("Hmm"), TextDelta(" let me see."), Done()], delay_s=0.1)
    d, _ = make(llm, Browser(auto=False))
    await d.converse("what time is it?")
    await asyncio.sleep(0.05)  # still writing: nothing said yet
    first = d._turn
    await d.user_speech_start(1, "thinking")
    assert first.task.cancelled()
    assert d.session.speech == "listening"
    assert d.comps.store.history("s_test")[0].content == "what time is it?"  # the question stays


async def test_a_segment_without_speech_is_dropped_before_stt():
    stt = HeardSTT("hello")
    llm = ScriptedLLM()
    d, _ = make(llm)
    d.comps = replace(d.comps, stt=stt)
    await d.user_speech_start(1, "idle")
    d.mic_audio(1, hiss(300) + tone(60) + hiss(300))  # a cough or a knock: 60 ms
    assert await d.user_speech_end() is None
    assert stt.calls == 0 and llm.calls == [] and d.session.speech == "silent"
    assert d.stats["dropped_no_speech"] == 1


async def test_push_to_talk_is_never_dropped_as_noise():
    stt = HeardSTT("hello")
    d, _ = make(ScriptedLLM())
    d.comps = replace(d.comps, stt=stt)
    await d.ptt_down(1)
    d.mic_audio(1, hiss(300))
    await d.wait_turn(await d.ptt_up(), 5)
    assert stt.calls == 1


async def test_the_avatars_echo_is_not_answered():
    llm = ScriptedLLM([TextDelta("I'll head over to the window now. "), TextDelta("It is sunny out there."), Done()],
                      delay_s=0.02)
    d, browser = make(llm, Browser(auto=False))
    await d.converse("look outside")
    await asyncio.wait([d._last_turn.task])
    # The speakers leak into the mic: the browser takes it for the user and the segment is transcribed.
    d.comps = replace(d.comps, stt=HeardSTT("head over to the window now"))
    await d.user_speech_start(2, "talking")
    d.mic_audio(2, tone(800))
    turn = await d.user_speech_end()
    result = await d.wait_turn(turn, 5)
    assert result["transcript"] == "" and len(llm.calls) == 1  # not answered
    assert browser.of("transcript")[-1] == {"text": "", "final": True}
    assert d.stats["dropped_echo"] == 1


async def test_walks_and_talks_at_once_and_a_barge_in_stops_both():
    llm = ScriptedLLM([TextDelta("Walking over to the desk while I tell you about it. "),
                       ToolCall("c1", "walk_to", {"location": "desk"}),
                       TextDelta("It holds my favourite things. "), Done("tool_calls")],
                      [TextDelta("Sure."), Done()])
    d, browser = make(llm, Browser(auto=False))
    await d.converse("show me the desk")
    while not browser.of("walk_to"):
        await asyncio.sleep(0.01)
    await asyncio.wait([d._last_turn.task])
    # The walk is under way and the reply is being spoken: both in flight together.
    assert browser.of("speech_start") and d._action_task and not d._action_task.done()
    uid = browser.of("speech_start")[0]["utterance_id"]
    await d.on_speech_finished(uid, interrupted=True, played_ms=50)
    await d.user_speech_start(5, "walking")
    assert d._action_task.done()  # no more movement from the old turn
    d.mic_audio(5, tone(500))
    assert await d.user_speech_end() is not None
    await asyncio.wait([d._last_turn.task])
    system = llm.calls[-1]["messages"][0].content
    assert "stopped before reaching the desk" in system
