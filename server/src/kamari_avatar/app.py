"""FastAPI app: WebSocket endpoint speaking the protocol in schema/protocol.schema.json.

Handshake, heartbeats, resume after a drop and state tracking, plus the Director that sends
walk and speech commands. In M1 commands come from the debug text box (`user_text`) and the
/debug endpoints; the LLM takes over in M2.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from . import __version__
from .config import DEFAULT_CONFIG, BackendConfig, Components, build
from .director import Director
from .protocol import (
    AvatarSnapshot,
    ClientMessage,
    HelloMessage,
    ResumeMessage,
)
from .session import Session, SessionManager

log = logging.getLogger("kamari_avatar")
_client_msg = TypeAdapter(ClientMessage)

TTS_RATE_DEFAULT = 22050
MIC_RATE = 16000


def _now_ms() -> int:
    return int(time.time() * 1000)


class Hub:
    """Sessions, their Directors, and the WebSocket each one is connected through right now."""

    def __init__(self, comps: Components) -> None:
        self.comps = comps
        self.sessions = SessionManager(ttl_s=comps.settings.resume_ttl_s)
        self.directors: dict[str, Director] = {}
        self.live: dict[str, Connection] = {}

    def director(self, s: Session) -> Director:
        for sid in [sid for sid in self.directors if sid not in self.sessions]:  # expired sessions
            del self.directors[sid]
        if s.id not in self.directors:
            self.directors[s.id] = Director(s, self.comps, SessionOutbox(self, s.id))
        return self.directors[s.id]


class SessionOutbox:
    """Sends through whichever connection the session has now; drops output while it has none."""

    def __init__(self, hub: Hub, session_id: str) -> None:
        self.hub, self.session_id = hub, session_id

    async def send_json(self, type_: str, data: dict[str, Any]) -> None:
        if conn := self.hub.live.get(self.session_id):
            await conn.send(type_, data)

    async def send_bytes(self, frame: bytes) -> None:
        if conn := self.hub.live.get(self.session_id):
            await conn.send_bytes(frame)


class Connection:
    def __init__(self, ws: WebSocket, hub: Hub) -> None:
        self.ws, self.hub, self.comps, self.sessions = ws, hub, hub.comps, hub.sessions
        self.session: Session | None = None
        self.lock = asyncio.Lock()  # a speech_chunk header and its audio frame must stay adjacent

    async def send(self, type_: str, data: dict[str, Any]) -> None:
        assert self.session is not None
        async with self.lock:
            await self.ws.send_json({"v": 1, "type": type_, "id": "m_" + secrets.token_hex(4), "ts": _now_ms(),
                                     "seq": self.session.next_seq(), "data": data})

    async def send_bytes(self, frame: bytes) -> None:
        async with self.lock:
            await self.ws.send_bytes(frame)

    async def error(self, code: str, message: str, ref: str | None = None) -> None:
        data = {"code": code, "message": message} | ({"ref": ref} if ref else {})
        if self.session is None:  # no session yet, so no seq to give it
            await self.ws.send_json({"v": 1, "type": "error", "id": "m_err", "ts": _now_ms(), "seq": 0, "data": data})
        else:
            await self.send("error", data)

    async def open(self, msg: HelloMessage | ResumeMessage) -> bool:
        if isinstance(msg, ResumeMessage):
            s = self.sessions.resume(msg.data.session_id, msg.data.resume_token)
            if s is None:
                await self.error("resume_failed", "unknown or expired session; send hello")
                return False
            self.session = s
            self.hub.live[s.id] = self
            await self.send("state_sync", {
                "session_id": s.id, "last_seq": s.seq, "avatar": s.avatar.model_dump(),
                "pending_cmds": s.pending_cmds, "speech": s.speech,
            })
            return True

        room = self.comps.room
        if msg.data.room_id != room.room_id:
            await self.error("unknown_room", f"this backend serves room {room.room_id!r}")
            return False
        s = self.sessions.create(room.room_id, msg.data.device or "desktop")
        spawn = room.manifest().get("spawn", {})
        s.avatar = AvatarSnapshot(location=None, position=spawn.get("position", {"x": 0, "z": 0}),
                                  heading_deg=spawn.get("heading_deg", 0))
        self.session = s
        self.hub.live[s.id] = self
        await self.send("session_ready", {
            "session_id": s.id, "resume_token": s.resume_token, "manifest_version": room.manifest_version,
            "audio": {"tts_rate": getattr(self.comps.tts, "sample_rate", TTS_RATE_DEFAULT), "mic_rate": MIC_RATE},
        })
        return True

    async def handle(self, msg: Any) -> None:
        s = self.session
        assert s is not None
        director = self.hub.director(s)
        d = msg.data
        s.last_seen = time.monotonic()
        match msg.type:
            case "ping":
                await self.send("pong", {"t": d.t})
            case "visibility":
                s.visible = d.state == "visible"
            case "state":
                s.avatar = AvatarSnapshot(location=s.avatar.location, position=d.position, heading_deg=d.heading_deg)
                s.speech = d.speech
            case "arrived" | "walk_failed" | "command_cancelled" | "gesture_finished":
                if msg.type == "arrived":
                    s.avatar = AvatarSnapshot(location=d.location, position=d.position, heading_deg=s.avatar.heading_deg)
                if d.cmd_id in s.pending_cmds:
                    s.pending_cmds.remove(d.cmd_id)
                director.resolve(d.cmd_id, {"type": msg.type} | d.model_dump(mode="json", exclude_none=True))
            case "speech_started":
                s.speech = "talking"
            case "speech_finished":
                s.speech = "silent"
                director.resolve(d.utterance_id, {"type": msg.type} | d.model_dump(mode="json", exclude_none=True))
            case "user_text":
                # M1: the debug text box drives the Director directly. In M2 this goes to the LLM.
                await self.send("transcript", {"text": d.text, "final": True})
                await director.command(d.text)
            case _:
                log.debug("unhandled %s", msg.type)


class DebugCommand(BaseModel):
    text: str
    session_id: str | None = None


class DebugRun(BaseModel):
    """Steps run in order, each waiting for the browser's event: {"walk_to": "sofa"} or {"say": "Hello"}."""

    steps: list[dict[str, str]]
    session_id: str | None = None
    timeout_s: float = Field(30, gt=0, le=300)


def create_app(config_path: str | Path = DEFAULT_CONFIG) -> FastAPI:
    comps = build(BackendConfig.load(config_path))
    hub = Hub(comps)
    sessions = hub.sessions

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        for p in comps.tool_providers:
            await p.start()
        try:
            yield
        finally:
            for p in comps.tool_providers:
                await p.stop()

    app = FastAPI(title="Kamari avatar backend", version=__version__, lifespan=lifespan)
    app.state.components = comps
    app.state.sessions = sessions
    app.state.hub = hub

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "room": comps.room.room_id, "sessions": len(sessions),
                "components": comps.active}

    @app.get("/manifest")
    async def manifest() -> dict[str, Any]:
        return comps.room.manifest()

    if comps.debug.endpoints or os.environ.get("KAMARI_AVATAR_DEBUG") == "1":
        def director_for(session_id: str | None) -> Director:
            live = [s for s in sessions.connected() if s.id in hub.live]
            s = next((s for s in live if s.id == session_id), None) if session_id else (live[0] if live else None)
            if s is None:
                raise HTTPException(404, "no connected browser session" + (f" {session_id!r}" if session_id else ""))
            return hub.director(s)

        @app.get("/debug/sessions")
        async def debug_sessions() -> list[dict[str, Any]]:
            return [{"session_id": s.id, "device": s.device, "avatar": s.avatar.model_dump(mode="json"),
                     "speech": s.speech} for s in sessions.connected()]

        @app.post("/debug/command")
        async def debug_command(cmd: DebugCommand) -> dict[str, Any]:
            kind, ref = await director_for(cmd.session_id).command(cmd.text)
            return {"kind": kind, "ref": ref}

        @app.post("/debug/run")
        async def debug_run(run: DebugRun) -> dict[str, Any]:
            director = director_for(run.session_id)
            events = []
            for step in run.steps:
                if "walk_to" in step:
                    ref = await director.walk_to(location=step["walk_to"])
                elif "say" in step:
                    ref = await director.say(step["say"])
                else:
                    raise HTTPException(422, f"unknown step {step}; use walk_to or say")
                if ref:
                    event = await director.wait(ref, run.timeout_s)
                else:
                    event = {"type": "rejected", "reason": f"unknown location {step['walk_to']!r}"}
                events.append({"step": step, "event": event})
                if event["type"] not in ("arrived", "speech_finished"):
                    break
            ok = len(events) == len(run.steps) and all(e["event"]["type"] in ("arrived", "speech_finished")
                                                       for e in events)
            return {"ok": ok, "session_id": director.session.id, "events": events}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        conn = Connection(ws, hub)
        try:
            while True:
                frame = await ws.receive()
                if frame["type"] == "websocket.disconnect":
                    break
                if frame.get("bytes") is not None:
                    continue  # binary mic audio: handled from M2
                try:
                    msg = _client_msg.validate_json(frame.get("text") or "").root
                except ValidationError as e:
                    await conn.error("bad_message", e.errors(include_url=False)[0]["msg"])
                    continue
                if conn.session is None:
                    if msg.type not in ("hello", "resume"):
                        await conn.error("no_session", "send hello or resume first")
                    elif not await conn.open(msg):
                        await ws.close()
                        return
                    continue
                await conn.handle(msg)
        except WebSocketDisconnect:
            pass
        finally:
            # Only the session's current socket may mark it gone: a phone that already resumed on a
            # new socket must stay connected when the old one finally times out.
            if conn.session and hub.live.get(conn.session.id) is conn:
                del hub.live[conn.session.id]
                sessions.disconnected(conn.session)
                # Audio sent while disconnected is lost, so the browser can never finish this
                # utterance: end it here rather than leave anyone waiting for speech_finished.
                if director := hub.directors.get(conn.session.id):
                    await director.cancel_speech("disconnected")

    return app
