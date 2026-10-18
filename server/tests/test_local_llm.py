"""The swappability check against a real model: the shipped Ollama config, no code change.

Runs where an Ollama server is up with the model pulled (CI does this):
    ollama pull qwen2.5:1.5b && KAMARI_TEST_OLLAMA=1 pytest -s tests/test_local_llm.py
"""

import os
from dataclasses import replace
from pathlib import Path

import pytest

from kamari_avatar.config import BackendConfig, build
from kamari_avatar.director import Director
from kamari_avatar.session import Session

pytestmark = pytest.mark.skipif(not os.environ.get("KAMARI_TEST_OLLAMA"), reason="set KAMARI_TEST_OLLAMA=1 with Ollama running")
TEST_CONFIG = Path(__file__).with_name("backend.test.yaml")


class Browser:
    def __init__(self):
        self.sent, self.director = [], None

    async def send_json(self, type_, data):
        self.sent.append((type_, data))
        d = self.director
        if type_ == "walk_to":
            d.resolve(data["cmd_id"], {"type": "arrived", "location": data["target"].get("location")})
        elif type_ == "gesture":
            d.resolve(data["cmd_id"], {"type": "gesture_finished"})
        elif type_ == "speech_end":
            d.resolve(data["utterance_id"], {"type": "speech_finished", "interrupted": False})

    async def send_bytes(self, frame):
        pass


async def test_conversation_runs_on_the_local_model():
    ollama = BackendConfig.load("config/llm-ollama.yaml")
    comps = build(BackendConfig.load(TEST_CONFIG))  # fakes for STT/TTS: this checks the LLM only
    comps = replace(comps, llm=build(ollama).llm)
    assert type(comps.llm).__name__ == "OpenAICompatibleLLM"
    browser = Browser()
    d = browser.director = Director(Session(id="s", resume_token="t", room_id="studio"), comps, browser, comps.director)
    result = await d.wait_turn(await d.converse("Please walk over to the window."), 120)
    print(f"\nreply: {result.get('reply')!r}\nactions: {result.get('actions')}\ntiming: {result.get('timing')}")
    assert result["type"] == "turn_done", result
    assert not [data for t, data in browser.sent if t == "error"]
    assert result["reply"] or result["actions"]  # it answered in words, actions or both
    if result["actions"]:  # whatever a small model calls must have passed validation
        assert all(a.split("(")[0] in ("walk_to", "gesture", "look_at", "stop_moving") for a in result["actions"])
