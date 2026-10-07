"""Load config/backend.yaml and build every component through the registry."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from . import impl  # noqa: F401  (registers built-in implementations)
from .interfaces import (
    ConversationStore,
    LLMProvider,
    RoomRegistry,
    SentenceChunker,
    STTEngine,
    ToolProvider,
    TTSEngine,
    VisemeMapper,
)
from .registry import create

log = logging.getLogger("kamari_avatar")
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = REPO_ROOT / "config" / "backend.yaml"


class ComponentSpec(BaseModel):
    impl: str
    enabled: bool = True
    options: dict[str, Any] = Field(default_factory=dict)
    # Used when `impl` cannot start here (engine not installed, model not downloaded).
    fallback: str | None = None


class SessionSettings(BaseModel):
    resume_ttl_s: int = 600


class DebugSettings(BaseModel):
    # /debug/* endpoints that drive the avatar without a conversation (M1 demo, tests).
    endpoints: bool = False


class BackendConfig(BaseModel):
    room_registry: ComponentSpec
    stt: ComponentSpec
    llm: ComponentSpec
    tts: ComponentSpec
    viseme_mapper: ComponentSpec
    chunker: ComponentSpec
    conversation_store: ComponentSpec
    tool_providers: list[ComponentSpec] = Field(default_factory=list)
    session: SessionSettings = Field(default_factory=SessionSettings)
    debug: DebugSettings = Field(default_factory=DebugSettings)

    @classmethod
    def load(cls, path: str | Path = DEFAULT_CONFIG) -> BackendConfig:
        return cls.model_validate(yaml.safe_load(Path(path).read_text()))


@dataclass
class Components:
    room: RoomRegistry
    stt: STTEngine
    llm: LLMProvider
    tts: TTSEngine
    visemes: VisemeMapper
    chunker_spec: ComponentSpec  # chunkers are stateful, so build one per utterance
    store: ConversationStore
    tool_providers: list[ToolProvider] = field(default_factory=list)
    settings: SessionSettings = field(default_factory=SessionSettings)
    debug: DebugSettings = field(default_factory=DebugSettings)
    active: dict[str, str] = field(default_factory=dict)  # interface -> implementation actually running

    def new_chunker(self) -> SentenceChunker:
        return create("chunker", self.chunker_spec.impl, **self.chunker_spec.options)


def build(cfg: BackendConfig, base_dir: Path = REPO_ROOT) -> Components:
    active: dict[str, str] = {}

    def make(kind: str, spec: ComponentSpec, **extra: Any) -> Any:
        try:
            comp = create(kind, spec.impl, **{**spec.options, **extra})
            if kind != "tool_provider":
                active[kind] = spec.impl
            return comp
        except (ImportError, RuntimeError, FileNotFoundError) as e:
            if not spec.fallback:
                raise
            log.warning("%s %r unavailable (%s); falling back to %r", kind, spec.impl, e, spec.fallback)
            if kind != "tool_provider":
                active[kind] = spec.fallback
            return create(kind, spec.fallback, **extra)

    providers = [make("tool_provider", s) for s in cfg.tool_providers if s.enabled]
    active["chunker"] = cfg.chunker.impl
    active["tool_providers"] = ", ".join(s.impl for s in cfg.tool_providers if s.enabled) or "none"
    return Components(
        room=make("room_registry", cfg.room_registry, base_dir=base_dir),
        stt=make("stt", cfg.stt),
        llm=make("llm", cfg.llm),
        tts=make("tts", cfg.tts),
        visemes=make("viseme_mapper", cfg.viseme_mapper),
        chunker_spec=cfg.chunker,
        store=make("conversation_store", cfg.conversation_store),
        tool_providers=providers,
        settings=cfg.session,
        debug=cfg.debug,
        active=active,
    )
