"""The avatar's own tools for the LLM, generated from the room so the model cannot invent a place."""

from __future__ import annotations

from typing import Any

from .interfaces import RoomRegistry, ToolSpec

AVATAR = "avatar"
USER = "user"


def avatar_tools(room: RoomRegistry) -> list[ToolSpec]:
    locs = room.locations()
    names = [loc.name for loc in locs]
    # Only labels that add something: "window (Window)" made a small model answer "Window".
    places = ", ".join(loc.name if loc.label.lower() == loc.name.lower() else f"{loc.name} ({loc.label})"
                       for loc in locs)

    def one(prop: str, enum: list[str], description: str) -> dict[str, Any]:
        return {"type": "object", "additionalProperties": False, "required": [prop],
                "properties": {prop: {"type": "string", "enum": enum, "description": description}}}

    return [
        ToolSpec("walk_to", "Walk to a place in the room. Returns at once: you can keep talking while you walk.",
                 one("location", names, f"Where to go: {places}"), AVATAR),
        ToolSpec("gesture", "Play a body gesture. If you also asked to walk in this reply, it plays on arrival.",
                 one("name", room.gestures(), "Which gesture"), AVATAR),
        ToolSpec("look_at", "Turn your head to look at a place in the room, or back at the user.",
                 one("target", [*names, USER], "A place, or 'user'"), AVATAR),
        ToolSpec("stop_moving", "Stop walking right away.",
                 {"type": "object", "additionalProperties": False, "properties": {}}, AVATAR),
    ]


def normalize(spec: ToolSpec, args: dict[str, Any]) -> dict[str, Any]:
    """Maps enum values given in another case or with spaces ("Window") to the listed one."""
    props: dict[str, Any] = spec.parameters.get("properties", {})
    out = dict(args)
    for name, value in args.items():
        enum = props.get(name, {}).get("enum")
        if enum and isinstance(value, str) and value not in enum:
            key = value.strip().lower().replace(" ", "_")
            match = [e for e in enum if str(e).lower() == key]
            if len(match) == 1:
                out[name] = match[0]
    return out


def validate(spec: ToolSpec, args: dict[str, Any]) -> str | None:
    """Checks arguments against the tool's flat JSON Schema. Returns an error for the LLM, or None."""
    if "_invalid_json" in args:
        return "arguments were not valid JSON"
    props: dict[str, Any] = spec.parameters.get("properties", {})
    for name in spec.parameters.get("required", []):
        if name not in args:
            return f"missing argument {name!r}"
    for name, value in args.items():
        if name not in props:
            return f"unknown argument {name!r}"
        enum = props[name].get("enum")
        if enum is not None and value not in enum:
            return f"{value!r} is not one of: {', '.join(map(str, enum))}"
    return None
