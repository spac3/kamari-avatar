import pytest

from kamari_avatar import registry
from kamari_avatar.config import BackendConfig, ComponentSpec, build
from kamari_avatar.interfaces import (
    ChatMessage,
    ConversationStore,
    Done,
    LLMProvider,
    RoomRegistry,
    SentenceChunker,
    STTEngine,
    TextDelta,
    ToolCall,
    ToolProvider,
    ToolSpec,
    TTSEngine,
    VisemeMapper,
)


@pytest.fixture
def comps():
    return build(BackendConfig.load())


def test_default_config_builds_every_interface(comps):
    assert isinstance(comps.room, RoomRegistry)
    assert isinstance(comps.stt, STTEngine)
    assert isinstance(comps.llm, LLMProvider)
    assert isinstance(comps.tts, TTSEngine)
    assert isinstance(comps.visemes, VisemeMapper)
    assert isinstance(comps.store, ConversationStore)
    assert isinstance(comps.new_chunker(), SentenceChunker)
    assert comps.tool_providers == []  # kamari_mcp is disabled by default


def test_every_interface_has_a_fake():
    for kind in ["stt", "llm", "tts", "vad", "tool_provider"]:
        assert "fake" in registry.available(kind), kind


def test_unknown_impl_names_the_known_ones():
    with pytest.raises(LookupError, match="known: fake"):
        registry.create("stt", "whisper-9000")


def test_swap_by_config_only(tmp_path):
    cfg = BackendConfig.load()
    cfg.llm = ComponentSpec(impl="fake", options={"reply": "Different brain."})
    assert build(cfg).llm.reply == "Different brain."


def test_room_registry(comps):
    assert comps.room.room_id == "studio"
    assert comps.room.location("sofa").x == pytest.approx(-2.6)
    assert comps.room.location("nowhere") is None
    assert "wave" in comps.room.gestures()


async def test_fake_llm_streams_text_then_tool_call(comps):
    tools = [ToolSpec("walk_to", "", {"type": "object"})]
    events = [e async for e in comps.llm.stream([ChatMessage("user", "go to the sofa")], tools)]
    text = "".join(e.text for e in events if isinstance(e, TextDelta))
    assert text == "Sure, heading to the sofa now."
    assert ToolCall("call_fake_1", "walk_to", {"location": "sofa"}) in events
    assert events[-1] == Done("tool_calls")


async def test_fake_tts_and_visemes_line_up(comps):
    [chunk] = [c async for c in comps.tts.synth("Hi Bob")]
    assert chunk.duration_ms == sum(chunk.phoneme_ms)
    keys = comps.visemes.map(chunk.phonemes, chunk.phoneme_ms)
    assert [k.v.root for k in keys] == ["E", "I", "sil", "PP", "O", "PP", "sil"]
    assert keys[-1].t == chunk.duration_ms


def test_viseme_mapper_merges_and_skips_stress_marks(comps):
    keys = comps.visemes.map(["h", "ə", "ˈ", "l", "oʊ"[0], "ʊ"], [50, 60, 0, 70, 80, 40])
    assert [(k.t, k.v.root) for k in keys] == [(0, "E"), (110, "nn"), (180, "O"), (260, "U"), (300, "sil")]


def test_chunker_emits_sentences_early(comps):
    c = comps.new_chunker()
    assert c.feed("Sure, heading to the sofa") == []
    assert c.feed(" now. And then") == ["Sure, heading to the sofa now."]
    assert c.flush() == ["And then"]


def test_chunker_merges_tiny_sentences(comps):
    c = comps.new_chunker()
    assert c.feed("Ok. Let me check that for you. ") == ["Ok. Let me check that for you."]


def test_store_truncates_after_barge_in(comps):
    comps.store.append("s", ChatMessage("assistant", "One two three four."))
    comps.store.truncate_last_assistant("s", "One two")
    assert comps.store.history("s")[-1].content == "One two [interrupted]"


async def test_fake_tool_provider_satisfies_interface():
    p = registry.create("tool_provider", "fake")
    assert isinstance(p, ToolProvider)
    [t] = await p.list_tools()
    assert (await p.call_tool(t.name, {"a": 1})).content == {"tool": "echo", "arguments": {"a": 1}}
