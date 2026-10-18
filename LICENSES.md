# Third-party licences

Every component is open source. Keep this file current when adding a library or asset.

## Assets

| Asset | Source | Licence | Notes |
|---|---|---|---|
| `web/public/avatars/cool-alien.vrm` (default avatar) | [100Avatars](https://github.com/PolygonalMind/100Avatars) #002 "Cool Alien" by Polygonal Mind | CC BY 4.0 (repository licence; the VRM metadata says CC0) | Unmodified. Attribution: "Cool Alien" by Polygonal Mind, from 100Avatars. Polygonal Mind asks that the avatars are not sold as-is. |
| `web/public/avatars/jimmy.vrm` (`?model=jimmy`) | [100Avatars](https://github.com/PolygonalMind/100Avatars) #003 "Jimmy" by Polygonal Mind | CC BY 4.0 (repository licence; the VRM metadata says CC0) | Unmodified. Attribution: "Jimmy" by Polygonal Mind, from 100Avatars. Polygonal Mind asks that the avatars are not sold as-is. |
| `web/public/animations/ual.glb` | [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) (free Standard version) by Quaternius | CC0 1.0 | 9 clips and the skeleton, mesh removed, built with `web/scripts/build-animations.ts`. Taken from the [glTF mirror](https://github.com/J-Ponzo/gltf-universal-animation-library) of the itch.io download. |
| Whisper model (not committed; downloaded on first start) | [Systran/faster-whisper-base.en](https://huggingface.co/Systran/faster-whisper-base.en), converted from OpenAI Whisper | MIT | Any faster-whisper model can be set in `config/backend.yaml`. |
| Local LLM weights (optional, pulled by Ollama) | e.g. Qwen2.5 1.5B Instruct | Apache-2.0 | Check each model's licence before switching. |
| Piper voice (not committed; downloaded per install) | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) `en_US-ljspeech-medium` | Trained on LJ Speech (public domain) | Voices have individual licences: read each voice's MODEL_CARD before switching. Several (e.g. lessac) are not cleared for commercial use. |

## Libraries

| Library | Licence | Used for |
|---|---|---|
| three.js | MIT | rendering |
| @pixiv/three-vrm | MIT | VRM avatars |
| recast-navigation-js | MIT | navmesh bake and pathfinding |
| Vite, Vitest, TypeScript | MIT / Apache-2.0 | web tooling |
| json-schema-to-typescript | MIT | protocol types (TS) |
| FastAPI, Starlette, Uvicorn | MIT / BSD-3 | backend |
| Pydantic | MIT | protocol models |
| MCP Python SDK | MIT | client for the Kamari MCP server |
| PyYAML | MIT | config |
| datamodel-code-generator | MIT | protocol types (Python) |
| glTF-Transform | MIT | trimming the animation file (build script only) |
| Piper (`piper-tts`, OHF-Voice/piper1-gpl) | **GPL-3.0** | text to speech with phoneme timings. Optional extra, runs in the backend only. GPL matters if you distribute a bundled build; replace it behind `TTSEngine` (e.g. Kokoro, Apache-2.0) if that is a problem. |
| eSpeak NG (bundled in piper-tts) | GPL-3.0 | phonemizer used by Piper |
| ONNX / ONNX Runtime | Apache-2.0 / MIT | running and patching the Piper voice; Silero VAD in faster-whisper |
| faster-whisper, CTranslate2 | MIT | speech to text (optional `stt` extra) |
| Silero VAD (bundled in faster-whisper) | MIT | trims silence before transcription |
| openai Python SDK | Apache-2.0 | client for any OpenAI-compatible LLM endpoint (hosted or Ollama) |
| Ollama (optional, runs separately) | MIT | local LLM server |
| @vitejs/plugin-basic-ssl | MIT | self-signed HTTPS in development, for phone mic access |

## Services

| Service | Open? | Notes |
|---|---|---|
| Hosted LLM API (default: Groq, OpenAI-compatible) | **No: proprietary, paid per token** | The one closed part, allowed until local hardware exists. The model is open-weight (Qwen3), so it can be self-hosted once there is hardware; `config/llm-ollama.yaml` already switches to a small local model with no code change. Conversation text leaves the machine. |
