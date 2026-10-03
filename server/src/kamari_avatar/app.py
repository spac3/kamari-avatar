"""FastAPI app: WebSocket endpoint speaking the protocol in schema/protocol.schema.json.

M0 scope: handshake, heartbeats, resume after a drop, and state tracking. The Director
(LLM, speech, commands) arrives in M1/M2 and plugs in behind `Connection.handle`.
"""

from __future__ import annotations

import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from . import __version__
from .config import DEFAULT_CONFIG, BackendConfig, Components, build
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


class Connection:
    def __init__(self, ws: WebSocket, comps: Components, sessions: SessionManager) -> None:
        self.ws, self.comps, self.sessions = ws, comps, sessions
        self.session: Session | None = None

    async def send(self, type_: str, data: dict[str, Any]) -> None:
        assert self.session is not None
        await self.ws.send_json({"v": 1, "type": type_, "id": "m_" + secrets.token_hex(4), "ts": _now_ms(),
                                 "seq": self.session.next_seq(), "data": data})

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
        await self.send("session_ready", {
            "session_id": s.id, "resume_token": s.resume_token, "manifest_version": room.manifest_version,
            "audio": {"tts_rate": getattr(self.comps.tts, "sample_rate", TTS_RATE_DEFAULT), "mic_rate": MIC_RATE},
        })
        return True

    async def handle(self, msg: Any) -> None:
        s = self.session
        assert s is not None
        d = msg.data
        match msg.type:
            case "ping":
                await self.send("pong", {"t": d.t})
            case "visibility":
                s.visible = d.state == "visible"
            case "state":
                s.avatar = AvatarSnapshot(location=s.avatar.location, position=d.position, heading_deg=d.heading_deg)
                s.speech = d.speech
            case "arrived":
                s.avatar = AvatarSnapshot(location=d.location, position=d.position, heading_deg=s.avatar.heading_deg)
                if d.cmd_id in s.pending_cmds:
                    s.pending_cmds.remove(d.cmd_id)
            case "walk_failed" | "command_cancelled" | "gesture_finished":
                if d.cmd_id in s.pending_cmds:
                    s.pending_cmds.remove(d.cmd_id)
            case "user_text":
                # Placeholder until the Director lands (M2): echo so the round trip is visible.
                await self.send("transcript", {"text": d.text, "final": True})
            case _:
                log.debug("unhandled %s", msg.type)


def create_app(config_path: str | Path = DEFAULT_CONFIG) -> FastAPI:
    comps = build(BackendConfig.load(config_path))
    sessions = SessionManager(ttl_s=comps.settings.resume_ttl_s)

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

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "room": comps.room.room_id, "sessions": len(sessions)}

    @app.get("/manifest")
    async def manifest() -> dict[str, Any]:
        return comps.room.manifest()

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        conn = Connection(ws, comps, sessions)
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
            if conn.session:
                sessions.disconnected(conn.session)

    return app
