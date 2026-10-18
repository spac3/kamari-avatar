"""Turns what the user says into speech and movement for one session.

One conversational turn: push-to-talk audio -> STT -> text -> LLM (streamed). Text is cut into
sentences and each is synthesized as soon as it is complete, so the avatar starts talking while
the LLM is still writing. Tool calls are checked against the room; the avatar's own tools become
commands run in order (walk to the window, then wave on arrival) without blocking speech, and
Kamari's tools are called with their results fed back to the LLM for another round.

The debug text box and /debug endpoints still drive the avatar directly through `command`,
`walk_to` and `say`.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import re
import secrets
import struct
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import Components, DirectorSettings
from .interfaces import AudioSegment, ChatMessage, Done, TextDelta, ToolCall, ToolResult, ToolSpec
from .protocol import SpeechChunkData, Vec2, VisemeKey, WalkToData
from .session import Session
from .tools import AVATAR, USER, avatar_tools, normalize, validate

log = logging.getLogger("kamari_avatar")

AUDIO_MIC = 0x01
AUDIO_TTS = 0x02
_FRAME_HEADER = struct.Struct(">BII")  # kind, stream_id, seq; see schema description
MAX_MIC_BYTES = 16000 * 2 * 30  # 30 s of 16 kHz PCM16 per push-to-talk press


def audio_frame(stream_id: int, seq: int, pcm: bytes) -> bytes:
    return _FRAME_HEADER.pack(AUDIO_TTS, stream_id, seq) + pcm


def parse_frame(frame: bytes) -> tuple[int, int, int, bytes] | None:
    if len(frame) < _FRAME_HEADER.size:
        return None
    kind, stream_id, seq = _FRAME_HEADER.unpack_from(frame)
    return kind, stream_id, seq, frame[_FRAME_HEADER.size:]


class Outbox(Protocol):
    """Where a Director sends. The live WebSocket behind it changes when a phone reconnects."""

    async def send_json(self, type_: str, data: dict[str, Any]) -> None: ...
    async def send_bytes(self, frame: bytes) -> None: ...


@dataclass
class TurnTiming:
    """Milliseconds from the end of the user's speech to each stage of the reply."""

    turn_id: str
    t0: float = field(default_factory=time.monotonic)
    marks: dict[str, int] = field(default_factory=dict)
    reported: bool = False

    def mark(self, stage: str) -> None:
        if stage not in self.marks:
            self.marks[stage] = round((time.monotonic() - self.t0) * 1000)

    def report(self) -> dict[str, Any]:
        return {"turn_id": self.turn_id} | {f"{k}_ms": v for k, v in self.marks.items()}


@dataclass
class _Utterance:
    id: str
    sentences: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    spoken: list[tuple[int, str]] = field(default_factory=list)  # (ms into the utterance, sentence)
    ms: int = 0
    turn: _Turn | None = None

    def heard(self, played_ms: int) -> str:
        return " ".join(text for start, text in self.spoken if start < played_ms)


@dataclass
class _Turn:
    id: str
    timing: TurnTiming
    task: asyncio.Task[None] | None = None
    utterance: _Utterance | None = None
    pending_text: str | None = None  # text of the LLM round in progress, not yet in history
    unanswered: list[ToolCall] = field(default_factory=list)  # tool calls in history without a result yet
    heard: str | None = None  # set when the user cut the reply short: what they actually heard
    transcript: str = ""
    reply: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)


@dataclass
class Director:
    session: Session
    comps: Components
    out: Outbox
    settings: DirectorSettings = field(default_factory=DirectorSettings)
    waiters: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    timings: collections.deque[dict[str, Any]] = field(default_factory=lambda: collections.deque(maxlen=50))
    _speaking: _Utterance | None = None
    _recent: collections.OrderedDict[str, _Utterance] = field(default_factory=collections.OrderedDict)
    _stream_ids: int = 0
    _turn: _Turn | None = None
    _last_turn: _Turn | None = None
    _actions: collections.deque[tuple[str, dict[str, Any]]] = field(default_factory=collections.deque)
    _action_task: asyncio.Task[None] | None = None
    _notes: list[str] = field(default_factory=list)  # things that happened, told to the LLM next turn
    _mic: bytearray | None = None
    _mic_stream: int | None = None
    _tool_sources: dict[str, ToolSpec] = field(default_factory=dict)
    _background: set[asyncio.Task[None]] = field(default_factory=set)

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

    async def gesture(self, name: str) -> str:
        cmd_id = "c_" + secrets.token_hex(4)
        self._expect(cmd_id)
        await self.out.send_json("gesture", {"cmd_id": cmd_id, "name": name})
        return cmd_id

    async def look_at(self, target: str) -> str:
        cmd_id = "c_" + secrets.token_hex(4)
        await self.out.send_json("look_at", {"cmd_id": cmd_id, "target": {"user": True} if target == USER
                                             else {"location": target}})
        return cmd_id

    async def stop_moving(self) -> str:
        cmd_id = "c_" + secrets.token_hex(4)
        await self.out.send_json("stop_moving", {"cmd_id": cmd_id})
        return cmd_id

    async def say(self, text: str, voice: str | None = None) -> str:
        """Start speaking `text`, replacing anything still being spoken. Returns the utterance_id."""
        await self.cancel_speech("superseded")
        u = self._start_utterance(voice)
        u.sentences.put_nowait(text)
        u.sentences.put_nowait(None)
        return u.id

    async def cancel_speech(self, reason: str) -> None:
        u, self._speaking = self._speaking, None
        if u is None:
            return
        if u.task and not u.task.done():
            u.task.cancel()
        if u.id in self.waiters and not self.waiters[u.id].done():  # audio may still be playing
            await self.out.send_json("speech_cancel", {"utterance_id": u.id, "reason": reason})
            self.resolve(u.id, {"type": "speech_cancel", "reason": reason})

    def _start_utterance(self, voice: str | None = None, turn: _Turn | None = None) -> _Utterance:
        u = _Utterance("u_" + secrets.token_hex(4), turn=turn)
        self._expect(u.id)
        self._speaking = u
        self._recent[u.id] = u
        while len(self._recent) > 8:
            self._recent.popitem(last=False)
        u.task = asyncio.create_task(self._speak(u, voice))
        return u

    async def _speak(self, u: _Utterance, voice: str | None) -> None:
        sentence = await u.sentences.get()
        if sentence is None:  # nothing to say after all
            self.resolve(u.id, {"type": "speech_finished", "interrupted": False, "played_ms": 0})
            return
        start = {"utterance_id": u.id, "text": sentence} | ({"voice": voice} if voice else {})
        await self.out.send_json("speech_start", start)
        n = 0
        try:
            while sentence is not None:
                u.spoken.append((u.ms, sentence))
                async for chunk in self.comps.tts.synth(sentence, voice):
                    visemes: list[VisemeKey] = []
                    if chunk.phonemes and chunk.phoneme_ms:
                        visemes = self.comps.visemes.map(chunk.phonemes, chunk.phoneme_ms)
                    self._stream_ids += 1
                    header = SpeechChunkData(utterance_id=u.id, stream_id=self._stream_ids, seq=n,
                                             sample_rate=chunk.sample_rate, duration_ms=chunk.duration_ms,
                                             visemes=visemes, text=sentence, last=False)
                    await self.out.send_json("speech_chunk", header.model_dump(mode="json", exclude_none=True))
                    await self.out.send_bytes(audio_frame(self._stream_ids, n, chunk.pcm))
                    if u.turn:
                        u.turn.timing.mark("tts_first_audio")
                    u.ms += chunk.duration_ms
                    n += 1
                sentence = await u.sentences.get()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("speech failed")
            await self.out.send_json("error", {"code": "tts_failed", "ref": u.id, "message": str(e)})
        await self.out.send_json("speech_end", {"utterance_id": u.id, "total_chunks": n})
        if n == 0:
            self.resolve(u.id, {"type": "speech_finished", "interrupted": False, "played_ms": 0})
            if u.turn:
                self._report(u.turn)

    # ------------------------------------------------------------ conversation

    async def converse(self, text: str) -> str:
        """Answer typed (or already transcribed) text. Replaces any turn in progress; returns the turn id."""
        turn = await self._new_turn("superseded")
        turn.task = asyncio.create_task(self._run_turn(turn, text=text))
        return turn.id

    async def ptt_down(self, stream_id: int | None) -> None:
        """The user pressed push-to-talk: stop talking and start collecting their audio."""
        await self.interrupt("user_speaking")
        self._mic, self._mic_stream = bytearray(), stream_id
        self.session.speech = "listening"
        await self.out.send_json("listening", {"mode": "ptt"})

    def mic_audio(self, stream_id: int, pcm: bytes) -> None:
        if self._mic is None or (self._mic_stream is not None and stream_id != self._mic_stream):
            return  # not listening, or frames from an earlier press
        if len(self._mic) + len(pcm) <= MAX_MIC_BYTES:
            self._mic += pcm

    async def ptt_up(self) -> str | None:
        """Released: transcribe what was said and answer it. Returns the turn id."""
        pcm, self._mic = self._mic, None
        await self.out.send_json("listening", {"mode": "off"})
        if pcm is None:
            return None
        turn = await self._new_turn("superseded")
        self.session.speech = "thinking"
        turn.task = asyncio.create_task(self._run_turn(turn, audio=AudioSegment(bytes(pcm))))
        return turn.id

    async def interrupt(self, reason: str) -> None:
        """Stop the turn in progress, its queued actions and its speech."""
        turn, self._turn = self._turn, None
        if turn and turn.task and not turn.task.done():
            turn.task.cancel()
            await asyncio.wait([turn.task])  # let it write what was said to history before going on
        if turn:
            self._report(turn)
        self._actions.clear()
        if self._action_task and not self._action_task.done():
            self._action_task.cancel()
        await self.cancel_speech(reason)
        if self.session.speech in ("thinking", "talking"):
            self.session.speech = "silent"

    async def pause(self) -> None:
        """Tab hidden or phone locked: nobody is watching, so stop and drop anything half-heard."""
        self._mic = None
        await self.interrupt("hidden")

    async def wait_turn(self, turn_id: str, timeout_s: float) -> dict[str, Any]:
        """Until the turn is answered and its speech has played (debug runs and the demo)."""
        turn = self._turn if self._turn and self._turn.id == turn_id else self._last_turn
        if turn is None or turn.id != turn_id or turn.task is None:
            return {"type": "unknown", "ref": turn_id}
        deadline = time.monotonic() + timeout_s
        done, _ = await asyncio.wait([turn.task], timeout=timeout_s)
        if not done:
            return {"type": "timeout", "ref": turn_id}
        event: dict[str, Any] = {"type": "turn_done", "transcript": turn.transcript, "reply": " ".join(turn.reply),
                                 "actions": turn.actions}
        if turn.task.cancelled():
            event["type"] = "turn_cancelled"
        elif turn.utterance:
            event["speech"] = await self.wait(turn.utterance.id, max(0.1, deadline - time.monotonic()))
        event["timing"] = turn.timing.report()
        return event

    async def _new_turn(self, reason: str) -> _Turn:
        await self.interrupt(reason)
        turn_id = "t_" + secrets.token_hex(4)
        self._turn = self._last_turn = _Turn(turn_id, TurnTiming(turn_id))
        return self._turn

    async def _run_turn(self, turn: _Turn, *, text: str | None = None, audio: AudioSegment | None = None) -> None:
        sid, store = self.session.id, self.comps.store
        try:
            if audio is not None:
                transcript = await self.comps.stt.transcribe(audio)
                turn.timing.mark("stt")
                text = transcript.text.strip()
                await self.out.send_json("transcript", {"text": text, "final": True})
            turn.transcript = text = (text or "").strip()
            if not text:
                self.session.speech = "silent"
                return
            self.session.speech = "thinking"
            store.append(sid, ChatMessage("user", text))
            tools = await self._tools()
            for round_ in range(self.settings.max_tool_rounds + 1):
                more = await self._llm_round(turn, tools if round_ < self.settings.max_tool_rounds else [])
                if not more:
                    break
        except asyncio.CancelledError:
            if turn.pending_text is not None:  # cut off while the LLM was writing
                said = turn.heard if turn.heard is not None else turn.pending_text
                store.append(sid, ChatMessage("assistant", said.strip() + " [interrupted]",
                                              tool_calls=tuple(turn.unanswered)))
            elif turn.heard is not None:
                store.truncate_last_assistant(sid, turn.heard)
            for call in turn.unanswered:  # every tool call needs a result, or the next request is rejected
                store.append(sid, ChatMessage("tool", json.dumps({"status": "cancelled"}), tool_call_id=call.id))
            raise
        except Exception as e:
            log.exception("turn %s failed", turn.id)
            code = "stt_failed" if audio is not None and not turn.transcript else "llm_failed"
            await self.out.send_json("error", {"code": code, "ref": turn.id, "message": str(e) or type(e).__name__})
            self.session.speech = "silent"
        finally:
            turn.pending_text = None
            if turn.utterance:
                turn.utterance.sentences.put_nowait(None)
            if turn.utterance is None or "first_audio" in turn.timing.marks:
                self._report(turn)

    async def _llm_round(self, turn: _Turn, tools: list[ToolSpec]) -> bool:
        """One LLM call. Returns True when tool results need another round."""
        sid, store = self.session.id, self.comps.store
        chunker = self.comps.new_chunker()
        calls: list[ToolCall] = []
        turn.pending_text, turn.unanswered = "", calls
        async for ev in self.comps.llm.stream(self._messages(), tools):
            if isinstance(ev, TextDelta):
                turn.timing.mark("llm_first_token")
                turn.pending_text += ev.text
                for piece in chunker.feed(ev.text):
                    self._say_piece(turn, piece)
            elif isinstance(ev, ToolCall):
                turn.timing.mark("llm_first_token")
                calls.append(ev)
            elif isinstance(ev, Done):
                break
        for piece in chunker.flush():
            self._say_piece(turn, piece)
        text = turn.pending_text.strip()
        store.append(sid, ChatMessage("assistant", text, tool_calls=tuple(calls)))
        turn.pending_text = None
        if text:
            turn.reply.append(text)
        more = False
        while calls:
            call = calls[0]
            result, external = await self._call_tool(call, turn)
            content = result.content if isinstance(result.content, str) else json.dumps(result.content)
            store.append(sid, ChatMessage("tool", content, tool_call_id=call.id))
            calls.pop(0)
            more = more or external or result.is_error
        return more

    def _say_piece(self, turn: _Turn, piece: str) -> None:
        turn.timing.mark("first_sentence")
        if turn.utterance is None:
            turn.utterance = self._start_utterance(turn=turn)
            self.session.speech = "talking"
        turn.utterance.sentences.put_nowait(piece)

    async def _tools(self) -> list[ToolSpec]:
        tools = avatar_tools(self.comps.room)
        for p in self.comps.tool_providers:
            try:
                tools += await p.list_tools()
            except Exception:
                log.exception("tool provider %s failed to list tools; continuing without it", p.name)
        self._tool_sources = {t.name: t for t in tools}
        return tools

    async def _call_tool(self, call: ToolCall, turn: _Turn) -> tuple[ToolResult, bool]:
        """Runs one tool call. Returns the result and whether it came from outside the avatar."""
        spec = self._tool_sources.get(call.name)
        if spec is None:
            return ToolResult(f"there is no tool called {call.name!r}", is_error=True), False
        if spec.source == AVATAR:
            args = normalize(spec, call.arguments)
            if err := validate(spec, args):
                log.info("rejected %s(%s): %s", call.name, call.arguments, err)
                return ToolResult(err, is_error=True), False
            turn.actions.append(f"{call.name}({', '.join(map(str, args.values()))})")
            return await self._avatar_action(call.name, args), False
        provider = next((p for p in self.comps.tool_providers if p.name == spec.source), None)
        if provider is None:
            return ToolResult(f"tool {call.name!r} is not available", is_error=True), True
        turn.actions.append(call.name)
        try:
            return await asyncio.wait_for(provider.call_tool(call.name, call.arguments),
                                          self.settings.tool_timeout_s), True
        except Exception as e:  # noqa: BLE001 (any tool failure goes back to the LLM)
            log.warning("tool %s failed: %s", call.name, e)
            return ToolResult(f"the tool failed: {e or type(e).__name__}", is_error=True), True

    async def _avatar_action(self, name: str, args: dict[str, Any]) -> ToolResult:
        if name == "stop_moving":
            self._actions.clear()
            await self.stop_moving()
            return ToolResult({"status": "stopped"})
        busy = bool(self._actions) or bool(self._action_task and not self._action_task.done())
        self._actions.append((name, args))
        if not (self._action_task and not self._action_task.done()):
            self._action_task = asyncio.create_task(self._run_actions())
        return ToolResult({"status": "queued" if busy else "started"})

    async def _run_actions(self) -> None:
        """Avatar commands in the order the LLM gave them; each waits for the previous walk to end."""
        while self._actions:
            name, args = self._actions.popleft()
            if name == "walk_to":
                cmd = await self.walk_to(location=args["location"])
                if cmd:
                    ev = await self.wait(cmd, self.settings.walk_timeout_s)
                    label = args["location"]
                    if ev["type"] == "arrived":
                        self._notes.append(f"You arrived at the {label}.")
                    elif ev["type"] == "walk_failed":
                        self._notes.append(f"You could not walk to the {label} ({ev.get('reason', 'failed')}).")
            elif name == "gesture":
                await self.wait(await self.gesture(args["name"]), self.settings.gesture_timeout_s)
            elif name == "look_at":
                await self.look_at(args["target"])

    def _messages(self) -> list[ChatMessage]:
        history = self.comps.store.history(self.session.id)
        if len(history) > self.settings.history_messages:
            history = history[-self.settings.history_messages:]
            while history and history[0].role != "user":  # never start on an orphaned tool result
                history.pop(0)
        return [ChatMessage("system", self._system_prompt()), *history]

    def _system_prompt(self) -> str:
        room = self.comps.room
        places = ", ".join(f"{loc.name} ({loc.label})" for loc in room.locations())
        here = self.session.avatar.location
        where = f"You are standing at the {here}." if here else "You are standing in the room, not at a named place."
        lines = [self.settings.persona.strip(), "",
                 f"The room has these places: {places}.",
                 f"Gestures you can make: {', '.join(room.gestures())}.", where]
        if self._notes:
            lines.append("Since the last message: " + " ".join(self._notes))
            self._notes.clear()
        return "\n".join(lines)

    def _report(self, turn: _Turn) -> None:
        if turn.timing.reported:
            return
        turn.timing.reported = True
        turn.timing.mark("total")
        report = turn.timing.report()
        self.timings.append(report | {"at": round(time.time(), 3)})
        log.info("turn %s latency: %s", turn.id,
                 ", ".join(f"{k[:-3]} {v} ms" for k, v in report.items() if k != "turn_id"))
        task = asyncio.get_running_loop().create_task(self.out.send_json("turn_timing", report))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # ------------------------------------------------------------ events from the browser

    def on_speech_started(self, utterance_id: str) -> None:
        u = self._recent.get(utterance_id)
        if u and u.turn:
            u.turn.timing.mark("first_audio")
            if u.turn.task is None or u.turn.task.done():
                self._report(u.turn)

    async def on_speech_finished(self, utterance_id: str, interrupted: bool, played_ms: int) -> None:
        u = self._recent.get(utterance_id)
        if u and u.turn and not u.turn.timing.reported:
            self._report(u.turn)
        if not (interrupted and u and u.turn):
            return
        turn = u.turn
        turn.heard = u.heard(played_ms)
        if turn is self._turn and turn.task and not turn.task.done():
            await self.interrupt("interrupted")  # the turn writes what was heard as it stops
        elif turn is self._last_turn:
            self.comps.store.truncate_last_assistant(self.session.id, turn.heard)

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
        if m := _GESTURE.match(text):
            return "gesture", await self.gesture(m["name"].lower())
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
_GESTURE = re.compile(r"^gesture\s+(?P<name>\w+)$", re.IGNORECASE)
_SAY = re.compile(r"^say[:\s]\s*(?P<what>.+)$", re.IGNORECASE | re.DOTALL)
