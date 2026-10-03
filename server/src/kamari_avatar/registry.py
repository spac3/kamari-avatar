"""Name -> factory registry. Implementations register themselves; config picks one by name."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

Factory = Callable[..., Any]

_registry: dict[str, dict[str, Factory]] = {}


def register(kind: str, name: str) -> Callable[[Factory], Factory]:
    def deco(factory: Factory) -> Factory:
        impls = _registry.setdefault(kind, {})
        if name in impls:
            raise ValueError(f"{kind} implementation {name!r} is already registered")
        impls[name] = factory
        return factory

    return deco


def create(kind: str, name: str, **options: Any) -> Any:
    try:
        factory = _registry[kind][name]
    except KeyError:
        known = ", ".join(sorted(_registry.get(kind, {}))) or "none"
        raise LookupError(f"no {kind} implementation named {name!r} (known: {known})") from None
    return factory(**options)


def available(kind: str) -> list[str]:
    return sorted(_registry.get(kind, {}))
