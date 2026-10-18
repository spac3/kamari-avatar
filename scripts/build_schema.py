# Builds schema/protocol.schema.json. Edit this file (not the JSON), then run it and scripts/gen-types.sh.
import json
S = lambda **k: {"type": "string", **k}
I = lambda **k: {"type": "integer", **k}
N = lambda **k: {"type": "number", **k}
B = {"type": "boolean"}
def obj(props, required=None, **k):
    return {"type": "object", "additionalProperties": False, "properties": props,
            "required": list(props) if required is None else required, **k}
R = lambda n: {"$ref": f"#/$defs/{n}"}
defs = {
  "Vec2": obj({"x": N(), "z": N()}, description="Point on the floor plane, metres."),
  "Target": obj({"location": S(description="Named location from the room manifest"), "point": R("Vec2"), "user": B},
                required=[], description="Exactly one of location, point or user."),
  "VisemeKey": obj({"t": I(minimum=0, description="ms from chunk start"), "v": R("Viseme")}),
  "Viseme": S(enum=["sil","PP","FF","TH","DD","kk","CH","SS","nn","RR","aa","E","I","O","U"],
              description="Oculus 15-viseme set"),
  "WordKey": obj({"t": I(minimum=0), "w": S()}),
  "AvatarSnapshot": obj({"location": {"type": ["string","null"]}, "position": R("Vec2"), "heading_deg": N()}),
}
server = {
  "session_ready": obj({"session_id": S(), "resume_token": S(), "manifest_version": S(),
                        "audio": obj({"tts_rate": I(), "mic_rate": I()})}),
  "walk_to": obj({"cmd_id": S(), "target": R("Target"), "speed": S(enum=["walk","run"], default="walk"),
                  "face_on_arrival": S(default="default"), "interrupt": S(enum=["replace","queue"], default="replace")},
                 required=["cmd_id","target"]),
  "stop_moving": obj({"cmd_id": S(), "blend_ms": I(default=300)}, required=["cmd_id"]),
  "speech_start": obj({"utterance_id": S(), "text": S(), "voice": S()}, required=["utterance_id","text"]),
  "speech_chunk": obj({"utterance_id": S(), "stream_id": I(), "seq": I(), "sample_rate": I(), "duration_ms": I(),
                       "visemes": {"type":"array","items": R("VisemeKey")}, "words": {"type":"array","items": R("WordKey")},
                       "text": S(description="The sentence this chunk speaks"), "last": B}, required=["utterance_id","stream_id","seq","sample_rate","duration_ms","last"]),
  "speech_end": obj({"utterance_id": S(), "total_chunks": I()}),
  "speech_cancel": obj({"utterance_id": S(), "reason": S()}),
  "gesture": obj({"cmd_id": S(), "name": S(), "layer": S(enum=["upper","full"], default="upper"),
                  "loop": B, "blend_ms": I(default=250)}, required=["cmd_id","name"]),
  "look_at": obj({"cmd_id": S(), "target": R("Target")}),
  "press_control": obj({"cmd_id": S(), "control": S(description="id of a control on the room's glass panel")},
                       description="Reach out and press a control on the translucent panel on the glass"),
  "set_expression": obj({"name": S(), "weight": N(minimum=0, maximum=1), "duration_ms": I()}, required=["name","weight"]),
  "listening": obj({"mode": S(enum=["ptt","open_mic","off"])}),
  "transcript": obj({"text": S(), "final": B}),
  "error": obj({"code": S(), "ref": S(), "message": S()}, required=["code","message"]),
  "state_sync": obj({"session_id": S(), "last_seq": I(), "avatar": R("AvatarSnapshot"),
                     "pending_cmds": {"type":"array","items": S()}, "speech": S(enum=["silent","talking","listening","thinking"])}),
  "pong": obj({"t": I()}),
  "turn_timing": obj({"turn_id": S(), "stt_ms": I(), "llm_first_token_ms": I(), "first_sentence_ms": I(),
                      "tts_first_audio_ms": I(), "first_audio_ms": I(), "total_ms": I()}, required=["turn_id"],
                     description="Latency of one conversational turn, each stage in ms from the end of the user's speech"),
  "token_usage": obj({"turn_id": S(), "input_tokens": I(minimum=0), "output_tokens": I(minimum=0),
                      "total_input_tokens": I(minimum=0, description="whole conversation so far"),
                      "total_output_tokens": I(minimum=0, description="whole conversation so far")},
                     description="LLM tokens one turn used (every round of it), and the conversation's running total, as the provider counted them"),
}
client = {
  "hello": obj({"client": S(), "version": S(), "room_id": S(), "device": S(enum=["desktop","mobile"]),
                "capabilities": obj({"visemes": S(), "audio_driven_lipsync": B, "mic_modes": {"type":"array","items": S(enum=["ptt","open_mic"])}}, required=[]),
                "output_latency_ms": I()}, required=["client","version","room_id"]),
  "resume": obj({"session_id": S(), "resume_token": S(), "last_seq_received": I()}),
  "visibility": obj({"state": S(enum=["hidden","visible"])}),
  "ping": obj({"t": I()}),
  "ack": obj({"cmd_id": S()}),
  "walk_started": obj({"cmd_id": S(), "path_length_m": N(), "eta_ms": I()}),
  "arrived": obj({"cmd_id": S(), "location": {"type":["string","null"]}, "position": R("Vec2")}, required=["cmd_id","position"]),
  "walk_failed": obj({"cmd_id": S(), "reason": S(enum=["unreachable","unknown_location","blocked"]), "nearest": R("Vec2")}, required=["cmd_id","reason"]),
  "command_cancelled": obj({"cmd_id": S(), "reason": S()}),
  "speech_started": obj({"utterance_id": S()}),
  "speech_finished": obj({"utterance_id": S(), "interrupted": B, "played_ms": I(), "last_word_index": I()}, required=["utterance_id","interrupted","played_ms"]),
  "gesture_finished": obj({"cmd_id": S(), "name": S()}),
  "control_pressed": obj({"control": S(), "source": S(enum=["user","avatar"]), "on": B,
                          "cmd_id": S(description="the press_control this press carried out, if any")},
                         required=["control","source"],
                         description="A control on the glass panel was pressed, by the user or the avatar; on is a toggle's new state"),
  "user_speech_start": obj({"segment_id": S(), "stream_id": I(description="stream_id of the mic audio frames for this segment"),
                            "while": S(enum=["idle","talking","walking","thinking"], description="what the avatar was doing: talking or walking means a barge-in")},
                           required=["segment_id","stream_id"], description="Open mic: the browser's VAD heard the user start speaking. Audio frames follow, starting with a little audio from before the start."),
  "user_speech_end": obj({"segment_id": S(), "duration_ms": I()}, description="Open mic: the user stopped speaking; transcribe the segment and answer it."),
  "ptt": obj({"state": S(enum=["down","up"]), "stream_id": I(description="stream_id of the mic audio frames for this press")},
              required=["state"]),
  "user_text": obj({"text": S()}),
  "state": obj({"loco": S(enum=["idle","turning","walking","arriving"]), "speech": S(enum=["silent","talking","listening","thinking"]), "position": R("Vec2"), "heading_deg": N()}),
}
def camel(n): return "".join(p.capitalize() for p in n.split("_"))
def msgs(table, side):
    names=[]
    for t, data in table.items():
        dn = camel(t) + "Data"; mn = camel(t) + "Message"
        defs[dn] = data
        env = {"v": {"const": 1, "type": "integer"}, "type": {"const": t, "type": "string"}, "id": S(), "ts": I(description="Unix ms"), "data": R(dn)}
        req = ["v","type","id","ts","data"]
        if side == "server":
            env["seq"] = I(minimum=0, description="Monotonic per session, used by resume")
            req.append("seq")
        defs[mn] = obj(env, required=req, title=mn)
        names.append(mn)
    return names
sn = msgs(server, "server"); cn = msgs(client, "client")
defs["ServerMessage"] = {"title": "ServerMessage", "oneOf": [R(n) for n in sn]}
defs["ClientMessage"] = {"title": "ClientMessage", "oneOf": [R(n) for n in cn]}
schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "https://kamari-avatar/protocol.schema.json",
  "title": "Protocol", "description": "Kamari avatar WebSocket protocol v1. Source of truth for generated Python and TypeScript types. Binary audio frames: [u8 kind][u32 stream_id][u32 seq][payload], header big-endian, PCM16 payload little-endian; kind 0x01 = mic PCM16 16 kHz (client to server), 0x02 = TTS PCM16 (server to client).",
  "oneOf": [R("ServerMessage"), R("ClientMessage")], "$defs": defs}
json.dump(schema, open(__import__("pathlib").Path(__file__).resolve().parents[1] / "schema" / "protocol.schema.json", "w"), indent=2)
print(len(defs))
