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


def test_text_box_walks_and_speaks():
    with TestClient(create_app()) as client, client.websocket_connect("/ws") as ws:
        ready(ws)
        ws.send_json(msg("user_text", {"text": "go to the sofa"}))
        assert ws.receive_json()["type"] == "transcript"
        walk = ws.receive_json()
        assert walk["type"] == "walk_to" and walk["data"]["target"] == {"location": "sofa"}

        ws.send_json(msg("user_text", {"text": "walk to the moon"}))
        ws.receive_json()
        err = ws.receive_json()
        assert err["type"] == "error" and err["data"]["code"] == "unknown_location"

        ws.send_json(msg("user_text", {"text": "say Hi Bob"}))
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
