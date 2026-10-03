from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..interfaces import Location
from ..registry import register


@register("room_registry", "json")
class JsonRoomRegistry:
    """Room manifest shared with the browser: named locations, gestures, avatar."""

    def __init__(self, path: str | Path, base_dir: str | Path | None = None) -> None:
        p = Path(path)
        if not p.is_absolute() and base_dir is not None:
            p = Path(base_dir) / p
        self._manifest: dict[str, Any] = json.loads(p.read_text())
        self.room_id: str = self._manifest["room_id"]
        self.manifest_version: str = self._manifest["manifest_version"]
        self._locations = {
            loc["name"]: Location(loc["name"], loc.get("label", loc["name"]), loc["position"]["x"],
                                  loc["position"]["z"], loc.get("heading_deg", 0.0))
            for loc in self._manifest["locations"]
        }

    def locations(self) -> list[Location]:
        return list(self._locations.values())

    def location(self, name: str) -> Location | None:
        return self._locations.get(name)

    def gestures(self) -> list[str]:
        return list(self._manifest.get("gestures", []))

    def manifest(self) -> dict[str, Any]:
        return self._manifest
