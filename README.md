# kamari-avatar

The voice and body of **Kamari**: a 3D avatar in a browser room that walks, talks and gestures,
driven by a Python backend. The backend's LLM uses Kamari's plugins (an MCP server) as tools.

Everything is open source, and every component sits behind an interface chosen by config, so any
part (avatar, navigation, speech-to-text, LLM, TTS, transport) can be swapped without touching the rest.

> Status: **M2** (conversation). Hold the talk button (or the space bar) and speak: faster-whisper
> transcribes it, an LLM answers with streamed speech and tool calls ("go to the window and wave"
> walks there, then waves), and Piper speaks each sentence as soon as it is written. See the [roadmap](#roadmap).

## Layout

```
schema/protocol.schema.json   WebSocket protocol: the contract between browser and backend
scripts/build_schema.py       edit this to change the protocol, then run gen-types.sh
scripts/gen-types.sh          regenerates server/.../protocol.py and web/src/protocol.ts
rooms/studio/manifest.json    room: floor, furniture, named locations, avatar (shared by both sides)
config/backend.yaml           which implementation backs each backend interface
config/llm-ollama.yaml        the same backend with a local LLM (only the llm section differs)
server/                       Python backend (FastAPI)
  src/kamari_avatar/interfaces.py   Protocols: STT, LLM, TTS, VAD, visemes, tools, store, room
  src/kamari_avatar/director.py     one conversational turn: STT, LLM, sentence-streamed TTS, tool calls
  src/kamari_avatar/tools.py        the avatar's tools (walk_to, gesture, look_at), enums from the room
  src/kamari_avatar/impl/           implementations, incl. fakes and the Kamari MCP client
web/                          Three.js client (Vite + TypeScript)
  src/interfaces.ts           avatar, animation, navigation, room, audio, mic, transport, quality
  src/config.ts               which implementation backs each browser interface
  src/anim/                   CC0 clips retargeted onto the avatar at load, procedural fallback
  src/loco/                   path following, speed-matched walk cycle, turn to face
  src/speech/                 audio scheduling and viseme timeline lip sync on the audio clock
  src/mic/                    mic capture (AudioWorklet, 16 kHz PCM16) and push-to-talk
  src/anim/ProceduralGestures upper-body gestures and head turns layered over the clips
  src/anim/IkScreenTap        reaching out and tapping the screen (two-bone IK, finger pointing)
  src/touch/                  the screen as glass between viewer and avatar; ripple circles on touch
  public/animations/ual.glb   clips (built by scripts/build-animations.ts)
```

## Run it

Requirements: Python 3.11+, Node 22+.

```bash
# backend
cd server
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev,piper,stt]"
python -m piper.download_voices en_US-ljspeech-medium --data-dir voices   # once, ~60 MB
export LLM_API_KEY=...   # key for the hosted LLM (see "The LLM" below)
uvicorn --factory kamari_avatar.app:create_app --port 8000   # first start downloads Whisper base.en, ~145 MB

# browser client (second terminal)
cd web
npm install
npm run dev            # bakes the navmesh, then serves on http://localhost:5173
```

Open http://localhost:5173 and tap **Tap to talk to Kamari**. Hold **Hold to talk** (or the space
bar) while you speak, and let go to send. The first press asks for the microphone. The text box
sends typed messages the same way. Captions show what was heard and what Kamari says, and the
**reply in** chip shows the time from the end of your speech to the first audio.

### Kamari behind the glass

Kamari is a small green alien standing just behind your screen, facing you, framed from the waist
up. The screen works like a pane of glass that both of you can touch: tap or click anywhere and
circles ripple out from that spot (teal) while Kamari glances at it; ask Kamari to tap the screen
(or type `/tap`, or `/tap 0.4 0.6` for a spot given as fractions of the screen from the top left) and
it reaches out and presses the glass from its side with one finger (green ripples). Without a spot it
taps back where you just touched, or somewhere in front of its chest. Its arms are short, so a spot
out of reach moves to the nearest one it can press. Every touch, from either side, goes to
`glass.onTouch` in `web/src/main.ts` with its side and screen position: that is where touches will
make things happen. The view is fixed; `?debug` lets you orbit the camera again (click without
dragging to touch). `?model=jimmy` brings back the earlier human avatar, `?touchfx=none` turns the
ripples off.

Debug controls: the place buttons and `/` commands in the text box drive the avatar without the
LLM (`/go to window`, `/say Hello`, `/gesture wave`). Add `?debug` to show the navmesh, location
markers and the path being walked (on phones it also brings back the place buttons).

**Phones:** browsers only allow the microphone over HTTPS. Run `npm run dev:https` instead, open
`https://<your-ip>:5173` on the phone and accept the self-signed certificate warning once.

Anything not installed or configured falls back to a fake, and the log and `/health` say which
implementation runs each component: no Piper means a tone voice, no faster-whisper means an STT that
always hears "hello", and no LLM key means Kamari says its language model isn't set up.

### The LLM

`config/backend.yaml` points at an open-weight model (Qwen3 32B) on Groq's OpenAI-compatible API.
That hosted service is the one proprietary, paid part of the stack. Any other OpenAI-compatible
provider works by changing `base_url`, `model` and `api_key_env`; model ids change, so check the
provider's list.

To run the same conversation on a local model instead, with no code change:

```bash
ollama pull qwen2.5:1.5b
KAMARI_AVATAR_CONFIG=config/llm-ollama.yaml uvicorn --factory kamari_avatar.app:create_app --port 8000
```

CI runs a conversation against that local config on every push. A 1.5B model calls tools less
reliably than the hosted one; a bigger local model (for example `qwen2.5:7b`) fixes that if the
machine can run it.

### Latency

Every turn logs how long each stage took, measured from the end of your speech: `stt`,
`llm_first_token`, `first_sentence`, `tts_first_audio` (first audio sent) and `first_audio` (the
browser started playing). The browser shows the last one, and `GET /latency` returns the recent turns.

### Demo script

With a browser tab connected, one command walks the avatar and has it speak, then prints the
`arrived` and `speech_finished` events the browser sent back:

```bash
cd server && python -m kamari_avatar.demo                    # sofa, default line
python -m kamari_avatar.demo window "Nice view, isn't it?"
python -m kamari_avatar.demo --ask "go to the window and wave"   # a whole turn through the LLM
```

`--ask` prints what the LLM replied, the actions it took and the latency of each stage.

It uses the `/debug/run` endpoint, which has no authentication and is off by default. Start the
backend with it on for local development:

```bash
KAMARI_AVATAR_DEBUG=1 uvicorn --factory kamari_avatar.app:create_app --port 8000
```

Tests: `cd server && pytest` and `cd web && npm test`. The Piper test runs when
`KAMARI_TEST_PIPER_VOICE` points at a voice `.onnx`; add `KAMARI_TEST_WHISPER_MODEL=base.en` and
Whisper must hear what Piper said. `KAMARI_TEST_OLLAMA=1` runs a conversation on the local model.

## Swapping components

Backend: change `impl` in `config/backend.yaml`. Every interface has a `fake` implementation.

```yaml
llm:
  impl: fake          # or openai_compatible, pointed at a hosted or local model
```

A config file can start from another with `extends:` and replace whole sections, as
`config/llm-ollama.yaml` does. Pick the file with `KAMARI_AVATAR_CONFIG`.

Browser: change `src/config.ts`, or override at runtime with the query string:
`?avatar=fake&anim=procedural&nav=straight&quality=low&net=offline&mic=fake`.

To add an implementation, implement the interface and register it under a new name
(`@register("stt", "faster_whisper")` in Python, `register('avatar', 'glb', ...)` in TypeScript).

## Kamari integration

`KamariMcpToolProvider` connects to Kamari's `/mcp` endpoint with a dedicated Bearer key
(`KAMARI_API_KEY`) and offers an allowlisted subset of Kamari's tools to the avatar's LLM as
`kamari__<tool>`. Payments, infrastructure, secrets and similar tools are always blocked. Enable it
under `tool_providers` in `config/backend.yaml`. The Director offers these tools alongside the
avatar's own and reads their results back to the LLM for a spoken answer; the provider stays off
until the avatar has its own Kamari key. Details and decisions: [docs/kamari-integration.md](docs/kamari-integration.md).

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | Interfaces, registry and config with fakes; protocol schema with generated types; room, navmesh, idling VRM avatar; session resume |
| M1 | Walking along navmesh paths, Piper TTS with phoneme-timed lip sync, retargeted CC0 animation clips |
| **M2** (this) | Push-to-talk, faster-whisper, LLM with tool calling behind the Director, sentence-streamed speech, gestures and look-at, latency per stage |
| M3 | Hands-free mic with barge-in, walking and talking together |
| M4 | Gestures, expressions, audio-driven lip sync fallback, custom avatar |
| M5 | Hardening, deployment, device matrix |

## Licences

Code: MIT. Third-party libraries and assets: see [LICENSES.md](LICENSES.md).
