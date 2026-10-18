from pathlib import Path

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

TEST_CONFIG = Path(__file__).with_name("backend.test.yaml")


@pytest.fixture
def comps():
    return build(BackendConfig.load(TEST_CONFIG))


def test_default_config_builds_with_fallbacks():
    # config/backend.yaml asks for Piper; without the engine or voice it must fall back, not fail.
    comps = build(BackendConfig.load())
    assert isinstance(comps.tts, TTSEngine)
    assert comps.active["tts"] in ("piper", "fake")


def test_fallback_is_used_when_impl_cannot_start(tmp_path):
    cfg = BackendConfig.load(TEST_CONFIG)
    cfg.tts = ComponentSpec(impl="piper", fallback="fake", options={"model": str(tmp_path / "missing.onnx")})
    comps = build(cfg)
    assert comps.active["tts"] == "fake"
    cfg.tts.fallback = None
    with pytest.raises((FileNotFoundError, RuntimeError)):
        build(cfg)


def test_test_config_builds_every_interface(comps):
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
    cfg = BackendConfig.load(TEST_CONFIG)
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
    done = events[-1]
    assert isinstance(done, Done) and done.reason == "tool_calls" and done.usage.output_tokens > 0


async def test_fake_tts_and_visemes_line_up(comps):
    [chunk] = [c async for c in comps.tts.synth("Hi Bob")]
    assert chunk.duration_ms == sum(chunk.phoneme_ms)
    keys = comps.visemes.map(chunk.phonemes, chunk.phoneme_ms)
    assert [k.v.root for k in keys] == ["E", "I", "PP", "O", "PP", "sil"]
    assert keys[-1].t == chunk.duration_ms


def test_viseme_mapper_merges_and_skips_stress_marks(comps):
    keys = comps.visemes.map(["h", "ə", "ˈ", "l", "o", "ʊ"], [50, 60, 30, 70, 80, 40])
    # the stress mark's 30 ms starts the stressed "l"
    assert [(k.t, k.v.root) for k in keys] == [(0, "E"), (110, "nn"), (210, "O"), (290, "U"), (330, "sil")]


def test_viseme_mapper_bridges_word_gaps_and_pauses_on_punctuation(comps):
    keys = comps.visemes.map(["^", "h", "i", " ", "m", "i", ",", " ", "o", "$"], [40, 50, 60, 30, 50, 60, 80, 20, 70, 30])
    assert [(k.t, k.v.root) for k in keys] == [
        (0, "sil"), (40, "E"), (90, "I"), (180, "PP"), (230, "I"), (290, "sil"), (390, "O"), (460, "sil"),
    ]


def test_chunker_emits_sentences_early(comps):
    c = comps.new_chunker()
    assert c.feed("Sure, heading to the sofa") == []
    assert c.feed(" now. And then") == ["Sure, heading to the sofa now."]
    assert c.flush() == ["And then"]


def test_chunker_merges_tiny_sentences(comps):
    c = comps.new_chunker()
    assert c.feed("Ok. Let me check that for you. ") == ["Ok. Let me check that for you."]


def test_store_rewrites_the_last_replies_after_barge_in(comps):
    for m in [ChatMessage("assistant", "Old."), ChatMessage("user", "hi"), ChatMessage("assistant", "One."),
              ChatMessage("tool", "{}", tool_call_id="c"), ChatMessage("assistant", "Two three.")]:
        comps.store.append("s", m)
    comps.store.rewrite_last_assistants("s", [None, "Two [interrupted]"])
    assert [m.content for m in comps.store.history("s")] == ["Old.", "hi", "One.", "{}", "Two [interrupted]"]


async def test_fake_tool_provider_satisfies_interface():
    p = registry.create("tool_provider", "fake")
    assert isinstance(p, ToolProvider)
    [t] = await p.list_tools()
    assert (await p.call_tool(t.name, {"a": 1})).content == {"tool": "echo", "arguments": {"a": 1}}


@pytest.mark.parametrize(("text", "kind", "where"), [
    ("go to the sofa", "walk_to", "sofa"),
    ("walk over to the Desk", "walk_to", "desk"),
    ("move window", "walk_to", "window"),
    ("go tomorrow", "walk_to", None),  # "tomorrow" is not a place; "to" is not stripped from it
    ("Hello there", "say", None),
])
async def test_director_text_commands(comps, text, kind, where):
    from kamari_avatar.director import Director
    from kamari_avatar.session import Session

    sent = []

    class Out:
        async def send_json(self, t, d):
            sent.append((t, d))

        async def send_bytes(self, f):
            pass

    d = Director(Session(id="s", resume_token="t", room_id="studio"), comps, Out())
    got_kind, ref = await d.command(text)
    assert got_kind == kind
    if kind == "walk_to" and where:
        assert sent[-1] == ("walk_to", {"cmd_id": ref, "target": {"location": where}, "speed": "walk",
                                        "face_on_arrival": "default", "interrupt": "replace"})
    elif kind == "walk_to":
        assert ref is None and sent[-1][0] == "error" and "'tomorrow'" in sent[-1][1]["message"]
    await d.cancel_speech("test")


def test_config_extends_replaces_whole_sections(tmp_path):
    (tmp_path / "local.yaml").write_text(f"extends: {TEST_CONFIG}\nllm:\n  impl: fake\n  options: {{ reply: hi }}\n")
    cfg = BackendConfig.load(tmp_path / "local.yaml")
    assert cfg.llm.options == {"reply": "hi"}  # not merged with the base llm options
    assert cfg.tts.impl == "fake" and cfg.debug.endpoints  # everything else from the base


def test_shipped_ollama_config_switches_only_the_llm():
    base, ollama = BackendConfig.load(), BackendConfig.load("config/llm-ollama.yaml")
    assert ollama.llm.options["base_url"].startswith("http://localhost:11434")
    assert ollama.model_dump(exclude={"llm"}) == base.model_dump(exclude={"llm"})


def test_stored_history_is_capped_at_a_user_message():
    from kamari_avatar.impl.stores import MemoryConversationStore

    store = MemoryConversationStore(max_messages=5)
    for i in range(4):
        store.append("s", ChatMessage("user", f"q{i}"))
        store.append("s", ChatMessage("assistant", f"a{i}"))
    roles = [m.role for m in store.history("s")]
    assert len(roles) <= 5 and roles[0] == "user"
    store.clear("s")
    assert store.history("s") == []
