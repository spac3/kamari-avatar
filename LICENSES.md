# Third-party licences

Every component is open source. Keep this file current when adding a library or asset.

## Assets

| Asset | Source | Licence | Notes |
|---|---|---|---|
| `web/public/avatars/jimmy.vrm` | [100Avatars](https://github.com/PolygonalMind/100Avatars) #003 "Jimmy" by Polygonal Mind | CC BY 4.0 (repository licence; the VRM metadata says CC0) | Unmodified. Attribution: "Jimmy" by Polygonal Mind, from 100Avatars. Polygonal Mind asks that the avatars are not sold as-is. |
| `web/public/animations/ual.glb` | [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) (free Standard version) by Quaternius | CC0 1.0 | 9 clips and the skeleton, mesh removed, built with `web/scripts/build-animations.ts`. Taken from the [glTF mirror](https://github.com/J-Ponzo/gltf-universal-animation-library) of the itch.io download. |
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
| ONNX / ONNX Runtime | Apache-2.0 / MIT | running and patching the Piper voice |
