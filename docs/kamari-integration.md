# Talking to Kamari

How kamari-avatar's backend connects to Kamari, based on a read-only look at the Kamari
source (v1.0.80) on 2026-10-03.

## What Kamari offers

- **MCP endpoint:** `POST /mcp`, Streamable HTTP with plain JSON replies (no SSE stream, no
  `Mcp-Session-Id`, no batching), protocol `2024-11-05`. Methods: `initialize`, `ping`,
  `tools/list`, `tools/call`; everything else is `-32601`. A legacy HTTP+SSE transport also
  exists at `GET /mcp`. No stdio.
- **Auth:** every method needs `Authorization: Bearer <key>` (or `X-Api-Key`). Kamari's OAuth 2.1
  server is on by default, so unauthenticated calls get `401` with a `WWW-Authenticate` challenge.
  `tools/list` only returns tools the key's capabilities allow, and `tools/call` re-checks.
- **Tools:** ~315 from 52 plugins, no resources or prompts. Plugins can hot-reload, and Kamari
  sends no `listChanged`, so clients re-poll `tools/list`.
- **Calls:** synchronous and blocking (job timeout 600 s by default). No progress or streaming.
  The result is one text item holding the plugin's dict as JSON, with `isError` on failure, and
  `_meta.task_id`. For long work there is a REST side channel: `POST /mcp/invoke/{tool}` returns a
  `task_id`, then `GET|DELETE /mcp/tasks/{id}`.
- **Voice/LLM pieces already in Kamari:** `llm_chat` (local Ollama, single-turn, no history),
  `tts_synthesize` (Kokoro or Polly; returns `audio_url`, `duration_ms`), `stt_transcribe`
  (`audio_b64`), `audio_bridge` (`/ws/audio`), per-user memory tools, an event feed at
  `/ws/messages`, and OIDC login with stable user ids.

## How kamari-avatar uses it (implemented)

`KamariMcpToolProvider` (`server/src/kamari_avatar/impl/kamari_mcp.py`):

- MCP Python SDK client over Streamable HTTP in `legacy` mode (initialize handshake, matching
  Kamari's 2024-11-05), Bearer key from `KAMARI_API_KEY`.
- Two filters: Kamari's server-side capabilities for the avatar's key, then the `allow` globs in
  `config/backend.yaml`. A built-in deny list blocks payments (`investec_*`), infrastructure
  (`terraform_*`, `ansible_*`, `exec_*`), secrets and config (`vault_*`, `config_*`), files,
  backups and outbound messaging, whatever the allowlist says.
- Tool names reach the LLM as `kamari__<tool>` (LLM APIs only accept `[a-zA-Z0-9_-]`).
- `tools/list` is cached for `refresh_s` and re-polled after that (no `listChanged` from Kamari).
- JSON text results are parsed back into dicts.

Tested against a look-alike of Kamari's endpoint (`server/tests/fake_kamari.py`) over HTTP.

## Setup on the Kamari side

1. Create a dedicated user or API key for the avatar, granted only the capabilities it should
   have (memory, calendar, tasks, daily plan, people, reading notifications).
2. Put the key in the backend's environment as `KAMARI_API_KEY` (never in the config file).
3. Set `url` and `enabled: true` under `tool_providers` in `config/backend.yaml`.

## Decisions for later milestones

- **Speech stays in the avatar's own pipeline (default).** Kamari's TTS returns a finished file
  URL with no phoneme timings, and MCP calls block, which would add a full sentence of latency and
  force the less precise audio-driven lip sync. Kamari-backed `TTSEngine`/`STTEngine`
  implementations can still be added behind the same interfaces if one voice service is preferred.
- **The conversation brain stays in the avatar's Director.** Kamari's `llm_chat` is single-turn
  with no history; the Director keeps history and calls Kamari tools.
- **Long tools:** the Director should speak a filler ("let me check") when a Kamari call runs past
  ~1 s, and use `/mcp/invoke` + task polling for tools known to be slow (M2).
- **Identity:** log users in through Kamari's OIDC so memory tools act for the right person (M5).
- **Events:** `/ws/messages` could let the avatar react to Kamari events (a reminder fires, a
  notification arrives); add as a `CommandSource` for the Director later.
