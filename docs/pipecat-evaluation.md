# Pipecat or the hand-built pipeline (M3)

**Decision: keep the hand-built pipeline.** Pipecat stays a candidate for two specific pieces later
(smart turn detection, a WebRTC transport), taken as components rather than as the framework.

Looked at: pipecat-ai 1.12.0 (BSD-2-Clause), October 2026: its package, its Piper, Whisper and Silero
services, the FastAPI WebSocket transport, and how it handles interruptions.

## What M3 needed, and who provides it

| Need | Pipecat | Here (M3) |
|---|---|---|
| Open mic VAD | Silero on the server (`SileroVADAnalyzer`), after the audio has crossed the network | Silero in the browser (onnxruntime-web), energy fallback; server energy VAD as a second opinion |
| Barge-in stops the audio | `InterruptionFrame` flushes the server's output queue; audio already sent to the browser keeps playing until the client is told | The browser stops its own audio and walk the moment the voice is confirmed, then tells the server |
| Avatar's own echo | Relies on the transport's echo cancelling (WebRTC does it well, a raw WebSocket does not) | Browser echo cancelling, then an echo gate that compares the mic with the avatar's output, then a transcript check on the server |
| History keeps only what was heard | The assistant aggregator keeps the text of TTS frames pushed before the interruption: what was *sent*, not what was *played* | Trimmed with `played_ms` from the browser, sentence by sentence (since M2) |
| Phoneme timings for lip sync | Its Piper service does not pass alignments; would need our own TTS service and frame type | Piper alignments to Oculus visemes (since M1) |
| Walk, gesture, look-at commands | Function calling exists; the commands, their results from the browser and their ordering would be custom processors | Director with validated tools and queued actions (since M2) |
| Protocol to the browser | Its serializers (Twilio, Protobuf, ...); ours would be a custom `FrameSerializer` | `schema/protocol.schema.json` with generated types on both sides |

## Why not adopt it now

- **The latency that matters is in the browser.** Stopping the avatar has to happen where the audio
  plays. With Pipecat's VAD on the server we would keep a browser VAD anyway, so it would run twice.
- **Our hardest parts are outside Pipecat's model.** Visemes, the walk/gesture command loop and
  trimming history by what was played are all custom either way; Pipecat would add a frame pipeline
  around them and own the design (the plan's rule: our interfaces, engines behind them).
- **Weight.** Pipecat pulls numba, onnxruntime, Pillow, soxr, resampy, protobuf and more into a
  backend that today needs FastAPI and httpx, for features we do not use.

## Where it could still earn a place

- **Smart turn detection.** Ending a turn on 700 ms of silence cuts people off mid-thought and
  waits too long after short answers. Pipecat's smart-turn model (open weights, ONNX) predicts the end
  of a turn from the audio. It could sit behind a small `EndOfTurn` interface in the browser or on the
  server without the rest of Pipecat. Worth trying if real use shows cut-offs.
- **WebRTC transport.** Browser echo cancelling works best on WebRTC audio. If the echo gate is not
  enough on real speakers, moving audio to WebRTC (Pipecat's SmallWebRTC transport, or aiortc directly)
  is the next step; it would replace `ProtocolClient`'s audio path, not the Director.
- **More engines.** Pipecat has services for many STT, TTS and LLM providers. Ours are swappable by
  config already; porting one of theirs is a small adapter when we want it.

If a later milestone needs Pipecat as a whole (telephony, multi-party), wrap it as one implementation of
the conversation pipeline behind the Director's interfaces instead of letting it own the design.
