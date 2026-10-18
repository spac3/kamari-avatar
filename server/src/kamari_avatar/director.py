"""Turns intents (walk somewhere, say something) into protocol messages for one session.

M1 scope: commands come from a debug text box or the /debug endpoints. The M2 Director puts
the LLM in front of this and adds validation of tool calls, a command queue and history.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import struct
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import Components
from .protocol import SpeechChunkData, Vec2, VisemeKey, WalkToData
from .session import Session

log = logging.getLogger("kamari_avatar")

AUDIO_TTS = 0x02
_FRAME_HEADER = struct.Struct(">BII")  # kind, stream_id, seq; see schema description


def audio_frame(stream_id: int, seq: int, pcm: bytes) -> bytes:
    return _FRAME_HEADER.pack(AUDIO_TTS, stream_id, seq) + pcm


class Outbox(Protocol):
    """Where a Director sends. The live WebSocket behind it changes when a phone reconnects."""

    async def send_json(self, type_: str, data: dict[str, Any]) -> None: ...
    async def send_bytes(self, frame: bytes) -> None: ...


@dataclass
class Director:
    session: Session
    comps: Components
    out: Outbox
    waiters: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    _speaking: asyncio.Task[None] | None = None
    _utterance: str | None = None
    _stream_ids: int = 0

    # ------------------------------------------------------------ commands

    async def walk_to(self, location: str | None = None, point: Vec2 | None = None) -> str | None:
        """Send walk_to; returns the cmd_id, or None after reporting an unknown location."""
        if location is not None and self.comps.room.location(location) is None:
            names = ", ".join(loc.name for loc in self.comps.room.locations())
            await self.out.send_json("error", {"code": "unknown_location", "message": f"{location!r} is not one of: {names}"})
            return None
        cmd_id = "c_" + secrets.token_hex(4)
        target = {"location": location} if location is not None else {"point": point}
        data = WalkToData.model_validate({"cmd_id": cmd_id, "target": target}).model_dump(mode="json", exclude_none=True)
        self.session.pending_cmds.append(cmd_id)
        self._expect(cmd_id)
        await self.out.send_json("walk_to", data)
        return cmd_id

    async def say(self, text: str, voice: str | None = None) -> str:
        """Start speaking `text`, replacing anything still being spoken. Returns the utterance_id."""
        await self.cancel_speech("superseded")
        utterance_id = "u_" + secrets.token_hex(4)
        self._expect(utterance_id)
        self._utterance = utterance_id
        self._speaking = asyncio.create_task(self._speak(utterance_id, text, voice))
        return utterance_id

    async def cancel_speech(self, reason: str) -> None:
        task, uid = self._speaking, self._utterance
        self._speaking = self._utterance = None
        if task and not task.done():
            task.cancel()
        if uid and uid in self.waiters and not self.waiters[uid].done():  # audio may still be playing
            await self.out.send_json("speech_cancel", {"utterance_id": uid, "reason": reason})
            self.resolve(uid, {"type": "speech_cancel", "reason": reason})

    async def _speak(self, utterance_id: str, text: str, voice: str | None) -> None:
        start = {"utterance_id": utterance_id, "text": text} | ({"voice": voice} if voice else {})
        await self.out.send_json("speech_start", start)
        n = 0
        try:
            async for chunk in self.comps.tts.synth(text, voice):
                visemes: list[VisemeKey] = []
                if chunk.phonemes and chunk.phoneme_ms:
                    visemes = self.comps.visemes.map(chunk.phonemes, chunk.phoneme_ms)
                self._stream_ids += 1
                header = SpeechChunkData(utterance_id=utterance_id, stream_id=self._stream_ids, seq=n,
                                         sample_rate=chunk.sample_rate, duration_ms=chunk.duration_ms,
                                         visemes=visemes, last=False)
                await self.out.send_json("speech_chunk", header.model_dump(mode="json", exclude_none=True))
                await self.out.send_bytes(audio_frame(self._stream_ids, n, chunk.pcm))
                n += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("speech failed")
            await self.out.send_json("error", {"code": "tts_failed", "ref": utterance_id, "message": str(e)})
        await self.out.send_json("speech_end", {"utterance_id": utterance_id, "total_chunks": n})
        if n == 0:
            self.resolve(utterance_id, {"type": "speech_finished", "interrupted": False, "played_ms": 0})

    # ------------------------------------------------------------ events from the browser

    def _expect(self, ref: str) -> None:
        if len(self.waiters) > 64:  # nobody waits on commands from the text box; forget finished ones
            for k in [k for k, f in self.waiters.items() if f.done()]:
                del self.waiters[k]
        self.waiters[ref] = asyncio.get_running_loop().create_future()

    def resolve(self, ref: str, event: dict[str, Any]) -> None:
        fut = self.waiters.get(ref)
        if fut and not fut.done():
            fut.set_result(event)

    async def wait(self, ref: str, timeout_s: float) -> dict[str, Any]:
        """The browser's event for a command or utterance: arrived, walk_failed, speech_finished..."""
        fut = self.waiters.get(ref)
        if fut is None:
            return {"type": "unknown", "ref": ref}
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout_s)
        except TimeoutError:
            return {"type": "timeout", "ref": ref}
        finally:
            if fut.done():
                self.waiters.pop(ref, None)

    # ------------------------------------------------------------ debug text commands

    async def command(self, text: str) -> tuple[str, str | None]:
        """Run one debug command: 'go to <location>' / 'walk <location>' / 'say <text>' / any other text."""
        text = text.strip()
        if m := _WALK.match(text):
            return "walk_to", await self.walk_to(location=self._location_named(m["where"]))
        if m := _SAY.match(text):
            text = m["what"]
        return "say", await self.say(text)

    def _location_named(self, words: str) -> str:
        words = words.strip().lower().removeprefix("the ").strip(" .!")
        for loc in self.comps.room.locations():
            if words in (loc.name, loc.label.lower()):
                return loc.name
        return words


_WALK = re.compile(r"^(?:please\s+)?(?:go|walk|move)\s+(?:(?:over\s+)?to\s+)?(?P<where>.+)$", re.IGNORECASE)
_SAY = re.compile(r"^say[:\s]\s*(?P<what>.+)$", re.IGNORECASE | re.DOTALL)
