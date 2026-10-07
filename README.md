# kamari-avatar

The voice and body of **Kamari**: a 3D avatar in a browser room that walks, talks and gestures,
driven by a Python backend. The backend's LLM uses Kamari's plugins (an MCP server) as tools.

Everything is open source, and every component sits behind an interface chosen by config, so any
part (avatar, navigation, speech-to-text, LLM, TTS, transport) can be swapped without touching the rest.

> Status: **M1** (walk and talk). The backend can walk the avatar to any named spot and make it
> speak with Piper, with lip sync timed from Piper's phoneme alignments. Conversation (speech
> recognition and the LLM) arrives in M2. See the [roadmap](#roadmap).

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
  src/anim/                   CC0 clips retargeted onto the avatar at load, procedural fallback
  src/loco/                   path following, speed-matched walk cycle, turn to face
  src/speech/                 audio scheduling and viseme timeline lip sync on the audio clock
  public/animations/ual.glb   clips (built by scripts/build-animations.ts)
```

## Run it

Requirements: Python 3.11+, Node 22+.

```bash
# backend
cd server
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev,piper]"
python -m piper.download_voices en_US-ljspeech-medium --data-dir voices   # once, ~60 MB
uvicorn --factory kamari_avatar.app:create_app --port 8000

# browser client (second terminal)
cd web
npm install
npm run dev            # bakes the navmesh, then serves on http://localhost:5173
```

Open http://localhost:5173 and tap **Tap to talk to Kamari**. The location buttons send the avatar
there, and the text box makes it speak (type `go to window` to walk instead). Add `?debug` to show
the navmesh, location markers and the path being walked. The dev server listens
on your LAN, so a phone on the same network can open `http://<your-ip>:5173` (mic access later needs HTTPS).

Without Piper or the voice, the backend falls back to a tone voice (the log says so, and
`/health` lists which implementation runs each component).

### Demo script

With a browser tab connected, one command walks the avatar and has it speak, then prints the
`arrived` and `speech_finished` events the browser sent back:

```bash
cd server && python -m kamari_avatar.demo                    # sofa, default line
python -m kamari_avatar.demo window "Nice view, isn't it?"
```

It uses the `/debug/run` endpoint, which is on in `config/backend.yaml` for development. Turn
`debug.endpoints` off on anything reachable from other machines.

Tests: `cd server && pytest` and `cd web && npm test`. The Piper test runs when
`KAMARI_TEST_PIPER_VOICE` points at a voice `.onnx`.

## Swapping components

Backend: change `impl` in `config/backend.yaml`. Every interface has a `fake` implementation.

```yaml
llm:
  impl: fake          # later: openai_compatible, pointed at a hosted or local model
```

Browser: change `src/config.ts`, or override at runtime with the query string:
`?avatar=fake&anim=procedural&nav=straight&quality=low&net=offline`.

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
| M0 | Interfaces, registry and config with fakes; protocol schema with generated types; room, navmesh, idling VRM avatar; session resume |
| **M1** (this) | Walking along navmesh paths, Piper TTS with phoneme-timed lip sync, retargeted CC0 animation clips |
| M2 | Push-to-talk, faster-whisper, LLM with tool calling behind the Director, Kamari tools live |
| M3 | Hands-free mic with barge-in, walking and talking together |
| M4 | Gestures, expressions, audio-driven lip sync fallback, custom avatar |
| M5 | Hardening, deployment, device matrix |

## Licences

Code: MIT. Third-party libraries and assets: see [LICENSES.md](LICENSES.md).
