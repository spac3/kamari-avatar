"""Server-side sessions that outlive a dropped WebSocket (phones background tabs)."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

from .protocol import AvatarSnapshot, Vec2


@dataclass
class Session:
    id: str
    resume_token: str
    room_id: str
    device: str = "desktop"
    seq: int = 0
    avatar: AvatarSnapshot = field(default_factory=lambda: AvatarSnapshot(location=None, position=Vec2(x=0, z=0), heading_deg=0))
    speech: str = "silent"
    pending_cmds: list[str] = field(default_factory=list)
    visible: bool = True
    connected: bool = True
    last_seen: float = field(default_factory=time.monotonic)

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq


class SessionManager:
    def __init__(self, ttl_s: float = 600) -> None:
        self.ttl_s = ttl_s
        self._sessions: dict[str, Session] = {}

    def create(self, room_id: str, device: str = "desktop") -> Session:
        self.expire()
        s = Session(id="s_" + secrets.token_hex(6), resume_token="rt_" + secrets.token_urlsafe(18),
                    room_id=room_id, device=device)
        self._sessions[s.id] = s
        return s

    def resume(self, session_id: str, token: str) -> Session | None:
        self.expire()
        s = self._sessions.get(session_id)
        if s is None or not secrets.compare_digest(s.resume_token, token):
            return None
        s.connected, s.last_seen = True, time.monotonic()
        return s

    def disconnected(self, s: Session) -> None:
        s.connected, s.last_seen = False, time.monotonic()

    def expire(self) -> None:
        now = time.monotonic()
        for sid in [sid for sid, s in self._sessions.items() if not s.connected and now - s.last_seen > self.ttl_s]:
            del self._sessions[sid]

    def __len__(self) -> int:
        return len(self._sessions)

    def __contains__(self, session_id: str) -> bool:
        return session_id in self._sessions

    def connected(self) -> list[Session]:
        """Connected sessions, most recently active first."""
        return sorted((s for s in self._sessions.values() if s.connected), key=lambda s: -s.last_seen)
