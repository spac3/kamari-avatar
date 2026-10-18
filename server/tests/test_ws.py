import struct
import threading
from pathlib import Path

from fastapi.testclient import TestClient

from kamari_avatar.app import create_app as _create_app

TEST_CONFIG = Path(__file__).with_name("backend.test.yaml")


def create_app():
    return _create_app(TEST_CONFIG)


def msg(type_, data, id_="c1"):
    return {"v": 1, "type": type_, "id": id_, "ts": 0, "data": data}


HELLO = msg("hello", {"client": "test", "version": "0", "room_id": "studio", "device": "mobile"})


def test_handshake_ping_and_resume():
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(HELLO)
            ready = ws.receive_json()
            assert ready["type"] == "session_ready" and ready["seq"] == 1
            sid, token = ready["data"]["session_id"], ready["data"]["resume_token"]
            ws.send_json(msg("ping", {"t": 42}))
            assert ws.receive_json()["data"] == {"t": 42}
            ws.send_json(msg("arrived", {"cmd_id": "c_1", "location": "sofa", "position": {"x": -2.6, "z": -1.5}}))
        # connection dropped (phone backgrounded); session survives
        with client.websocket_connect("/ws") as ws:
            ws.send_json(msg("resume", {"session_id": sid, "resume_token": token, "last_seq_received": 2}))
            sync = ws.receive_json()
            assert sync["type"] == "state_sync"
            assert sync["data"]["avatar"]["location"] == "sofa"
            assert sync["seq"] == 3


def test_rejects_bad_resume_and_messages_before_hello():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ws.send_json(msg("ping", {"t": 1}))
        assert ws.receive_json()["data"]["code"] == "no_session"
        ws.send_json({"type": "walk_to"})
        assert ws.receive_json()["data"]["code"] == "bad_message"
        ws.send_json(msg("resume", {"session_id": "s_x", "resume_token": "nope", "last_seq_received": 0}))
        assert ws.receive_json()["data"]["code"] == "resume_failed"


def test_health_and_manifest():
    with TestClient(create_app()) as client:
        assert client.get("/health").json()["room"] == "studio"
        assert any(loc["name"] == "window" for loc in client.get("/manifest").json()["locations"])


def ready(ws):
    ws.send_json(HELLO)
    return ws.receive_json()["data"]["session_id"]


def test_slash_commands_walk_and_speak():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ready(ws)
        ws.send_json(msg("user_text", {"text": "/go to the sofa"}))
        assert ws.receive_json()["type"] == "transcript"
        walk = ws.receive_json()
        assert walk["type"] == "walk_to" and walk["data"]["target"] == {"location": "sofa"}

        ws.send_json(msg("user_text", {"text": "/walk to the moon"}))
        ws.receive_json()
        err = ws.receive_json()
        assert err["type"] == "error" and err["data"]["code"] == "unknown_location"

        ws.send_json(msg("user_text", {"text": "/say Hi Bob"}))
        ws.receive_json()
        start = ws.receive_json()
        assert start["type"] == "speech_start" and start["data"]["text"] == "Hi Bob"
        chunk = ws.receive_json()
        assert chunk["type"] == "speech_chunk" and chunk["data"]["visemes"][-1]["v"] == "sil"
        frame = ws.receive_bytes()
        kind, stream_id, seq = struct.unpack(">BII", frame[:9])
        assert (kind, stream_id, seq) == (2, chunk["data"]["stream_id"], 0)
        samples = (len(frame) - 9) // 2
        assert samples * 1000 // chunk["data"]["sample_rate"] == chunk["data"]["duration_ms"]
        end = ws.receive_json()
        assert end["type"] == "speech_end" and end["data"]["total_chunks"] == 1


def test_debug_run_waits_for_the_browser():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        sid = ready(ws)
        result = {}
        steps = [{"walk_to": "sofa"}, {"say": "Hello, welcome."}]
        t = threading.Thread(target=lambda: result.update(client.post("/debug/run", json={"steps": steps}).json()))
        t.start()
        walk = ws.receive_json()
        assert walk["type"] == "walk_to"
        ws.send_json(msg("arrived", {"cmd_id": walk["data"]["cmd_id"], "location": "sofa",
                                     "position": {"x": -2.6, "z": -1.5}}))
        start = ws.receive_json()
        assert start["type"] == "speech_start"
        uid = start["data"]["utterance_id"]
        ws.receive_json(), ws.receive_bytes()
        assert ws.receive_json()["type"] == "speech_end"
        ws.send_json(msg("speech_started", {"utterance_id": uid}))
        ws.send_json(msg("speech_finished", {"utterance_id": uid, "interrupted": False, "played_ms": 1200}))
        t.join(10)
        assert result["ok"] and result["session_id"] == sid
        assert [e["event"]["type"] for e in result["events"]] == ["arrived", "speech_finished"]


def test_debug_run_needs_a_browser():
    with TestClient(create_app()) as client:
        assert client.post("/debug/run", json={"steps": [{"say": "hi"}]}).status_code == 404


def test_debug_endpoints_are_off_by_default(monkeypatch):
    monkeypatch.delenv("KAMARI_AVATAR_DEBUG", raising=False)
    with TestClient(_create_app()) as client:
        assert client.post("/debug/run", json={"steps": []}).status_code == 404
    monkeypatch.setenv("KAMARI_AVATAR_DEBUG", "1")
    with TestClient(_create_app()) as client:
        assert client.post("/debug/run", json={"steps": [{"say": "hi"}]}).status_code == 404  # on, no browser


def test_health_lists_every_component():
    with TestClient(create_app()) as client:
        comps = client.get("/health").json()["components"]
    assert comps["chunker"] == "punctuation" and comps["tts"] == "fake" and comps["tool_providers"] == "none"


def test_stale_socket_does_not_disconnect_a_resumed_session():
    app = create_app()
    with TestClient(app) as client, client.websocket_connect("/ws") as old:
        old.send_json(HELLO)
        ready = old.receive_json()["data"]
        with client.websocket_connect("/ws") as new:
            new.send_json(msg("resume", {"session_id": ready["session_id"], "resume_token": ready["resume_token"],
                                         "last_seq_received": 1}))
            assert new.receive_json()["type"] == "state_sync"
            old.close()
            new.send_json(msg("ping", {"t": 1}))
            assert new.receive_json()["type"] == "pong"  # old socket's exit has been processed
            assert [s.id for s in app.state.sessions.connected()] == [ready["session_id"]]


def test_disconnect_ends_the_utterance_in_progress():
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            sid = ready(ws)
            ws.send_json(msg("user_text", {"text": "/say Hello there"}))
            ws.receive_json()
            uid = ws.receive_json()["data"]["utterance_id"]
        director = app.state.hub.directors[sid]
        result = client.portal.call(director.wait, uid, 5)
        assert result["type"] == "speech_cancel" and result["reason"] == "disconnected"


def receive_until(ws, wanted, limit=50):
    """Messages (JSON, or ("audio", bytes)) until every type in `wanted` has been seen."""
    got, wanted = [], set(wanted)
    for _ in range(limit):
        frame = ws.receive()
        m = ("audio", frame["bytes"]) if frame.get("bytes") is not None else __import__("json").loads(frame["text"])
        got.append(m)
        wanted.discard(m[0] if isinstance(m, tuple) else m["type"])
        if not wanted:
            return got
    raise AssertionError(f"never saw {wanted}")


def types(got):
    return [m[0] if isinstance(m, tuple) else m["type"] for m in got]


def test_typed_text_goes_to_the_llm():
    # backend.test.yaml's fake LLM answers "Sure, heading to the sofa now." and calls walk_to(sofa)
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ready(ws)
        ws.send_json(msg("user_text", {"text": "go to the sofa"}))
        got = receive_until(ws, ["transcript", "speech_start", "speech_chunk", "audio", "speech_end", "walk_to"])
        start = next(m for m in got if isinstance(m, dict) and m["type"] == "speech_start")
        assert start["data"]["text"] == "Sure, heading to the sofa now."
        walk = next(m for m in got if isinstance(m, dict) and m["type"] == "walk_to")
        assert walk["data"]["target"] == {"location": "sofa"}
        uid = start["data"]["utterance_id"]
        ws.send_json(msg("speech_started", {"utterance_id": uid}))
        timing = receive_until(ws, ["turn_timing"])[-1]["data"]
        assert {"llm_first_token_ms", "tts_first_audio_ms", "first_audio_ms"} <= timing.keys()
        assert client.get("/latency").json()["turns"][-1]["turn_id"] == timing["turn_id"]


def test_push_to_talk_over_the_socket():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ready(ws)
        ws.send_json(msg("ptt", {"state": "down", "stream_id": 3}))
        assert receive_until(ws, ["listening"])[-1]["data"] == {"mode": "ptt"}
        for seq in range(5):  # 5 x 20 ms of 16 kHz PCM16
            ws.send_bytes(struct.pack(">BII", 1, 3, seq) + b"\x00\x01" * 320)
        ws.send_json(msg("ptt", {"state": "up", "stream_id": 3}))
        got = receive_until(ws, ["transcript", "walk_to", "speech_end"])
        assert got[0]["data"] == {"mode": "off"}
        assert next(m for m in got if isinstance(m, dict) and m["type"] == "transcript")["data"]["text"] == "go to the sofa"


def test_open_mic_segment_over_the_socket():
    app = create_app()
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        sid = ready(ws)
        ws.send_json(msg("user_speech_start", {"segment_id": "seg_1", "stream_id": 4, "while": "idle"}))
        assert receive_until(ws, ["listening"])[-1]["data"] == {"mode": "open_mic"}
        for seq in range(25):  # 500 ms of a loud 16 kHz square wave: plenty of speech for the server VAD
            ws.send_bytes(struct.pack(">BII", 1, 4, seq) + (b"\x00\x30" * 20 + b"\x00\xd0" * 20) * 8)
        ws.send_json(msg("user_speech_end", {"segment_id": "seg_1", "duration_ms": 500}))
        got = receive_until(ws, ["transcript"])
        assert got[-1]["data"]["text"] == "go to the sofa"
        assert app.state.hub.directors[sid].stats["segments"] == 1
        assert client.get("/latency").json()["open_mic"] == {"segments": 1}


def test_hiding_the_tab_stops_the_reply():
    app = create_app()
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        sid = ready(ws)
        ws.send_json(msg("user_text", {"text": "/say A long line that is still playing when the phone locks."}))
        uid = receive_until(ws, ["speech_start"])[-1]["data"]["utterance_id"]
        ws.send_json(msg("visibility", {"state": "hidden"}))
        got = receive_until(ws, ["speech_cancel"])
        assert got[-1]["data"] == {"utterance_id": uid, "reason": "hidden"}
        assert app.state.hub.directors[sid].session.visible is False


def test_debug_run_asks_a_whole_turn():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ready(ws)
        result = {}
        t = threading.Thread(target=lambda: result.update(
            client.post("/debug/run", json={"steps": [{"ask": "go to the sofa"}], "timeout_s": 10}).json()))
        t.start()
        got = receive_until(ws, ["speech_start", "speech_end", "walk_to"])
        uid = next(m for m in got if isinstance(m, dict) and m["type"] == "speech_start")["data"]["utterance_id"]
        ws.send_json(msg("speech_started", {"utterance_id": uid}))
        ws.send_json(msg("speech_finished", {"utterance_id": uid, "interrupted": False, "played_ms": 900}))
        t.join(10)
        ev = result["events"][0]["event"]
        assert result["ok"] and ev["type"] == "turn_done" and ev["actions"] == ["walk_to(sofa)"]
        assert ev["speech"]["type"] == "speech_finished" and "first_audio_ms" in ev["timing"]


def test_pages_from_other_sites_cannot_connect():
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with TestClient(create_app()) as client:
        with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()
        # the app's own page, served by the backend or through the dev proxy (same Host)
        with client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
            ws.send_json(HELLO)
            assert ws.receive_json()["type"] == "session_ready"


def test_panel_presses_reach_the_director():
    app = create_app()
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        sid = ready(ws)
        ws.send_json(msg("control_pressed", {"control": "lights", "source": "user", "on": False}))
        ws.send_json(msg("ping", {"t": 7}))
        assert ws.receive_json()["type"] == "pong"  # accepted, no bad_message error
        director = app.state.hub.directors[sid]
        assert director._notes == ["The user pressed Lights on the panel (now off)."]
