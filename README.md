# kamari-avatar

The voice and body of **Kamari**: a 3D avatar in a browser room that walks, talks and gestures,
driven by a Python backend. The backend's LLM uses Kamari's plugins (an MCP server) as tools.

Everything is open source, and every component sits behind an interface chosen by config, so any
part (avatar, navigation, speech-to-text, LLM, TTS, transport) can be swapped without touching the rest.

> Status: **M0** (scene skeleton and contracts). The avatar idles in the room; walking, speech and
> conversation arrive in M1 and M2. See the [technical plan](#roadmap).

## Layout

```
schema/protocol.schema.json   WebSocket protocol: the contract between browser and backend
scripts/build_schema.py       edit this to change the protocol, then run gen-types.sh
scripts/gen-types.sh          regenerates server/.../protocol.py and web/src/protocol.ts
rooms/studio/manifest.json    room: floor, furniture, named locations, avatar (shared by both sides)
config/backend.yaml           which implementation backs each backend interface
server/                       Python backend (FastAPI)
  src/kamari_avatar/interfaces.py   Protocols: STT, LLM, TTS, VAD, visemes, tools, store, room
  src/kamari_avatar/impl/           implementations, incl. fakes and the Kamari MCP client
web/                          Three.js client (Vite + TypeScript)
  src/interfaces.ts           avatar, animation, navigation, room, audio, mic, transport, quality
  src/config.ts               which implementation backs each browser interface
```

## Run it

Requirements: Python 3.11+, Node 22+.

```bash
# backend
cd server
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn --factory kamari_avatar.app:create_app --port 8000

# browser client (second terminal)
cd web
npm install
npm run dev            # bakes the navmesh, then serves on http://localhost:5173
```

Open http://localhost:5173 and tap **Tap to talk to Kamari**. Add `?debug` to show the navmesh and
location markers; the location buttons preview the path the avatar will walk. The dev server listens
on your LAN, so a phone on the same network can open `http://<your-ip>:5173` (mic access later needs HTTPS).

Tests: `cd server && pytest` and `cd web && npm test`.

## Swapping components

Backend: change `impl` in `config/backend.yaml`. Every interface has a `fake` implementation.

```yaml
llm:
  impl: fake          # later: openai_compatible, pointed at a hosted or local model
```

Browser: change `src/config.ts`, or override at runtime with the query string:
`?avatar=fake&nav=straight&quality=low&net=offline`.

To add an implementation, implement the interface and register it under a new name
(`@register("stt", "faster_whisper")` in Python, `register('avatar', 'glb', ...)` in TypeScript).

## Kamari integration

`KamariMcpToolProvider` connects to Kamari's `/mcp` endpoint with a dedicated Bearer key
(`KAMARI_API_KEY`) and offers an allowlisted subset of Kamari's tools to the avatar's LLM as
`kamari__<tool>`. Payments, infrastructure, secrets and similar tools are always blocked. Enable it
under `tool_providers` in `config/backend.yaml`. Details and decisions: [docs/kamari-integration.md](docs/kamari-integration.md).

## Roadmap

| Milestone | Scope |
|---|---|
| **M0** (this) | Interfaces, registry and config with fakes; protocol schema with generated types; room, navmesh, idling VRM avatar; session resume |
| M1 | Walking along navmesh paths, Piper TTS with phoneme-timed lip sync, retargeted CC0 animation clips |
| M2 | Push-to-talk, faster-whisper, LLM with tool calling behind the Director, Kamari tools live |
| M3 | Hands-free mic with barge-in, walking and talking together |
| M4 | Gestures, expressions, audio-driven lip sync fallback, custom avatar |
| M5 | Hardening, deployment, device matrix |

## Licences

Code: MIT. Third-party libraries and assets: see [LICENSES.md](LICENSES.md).
