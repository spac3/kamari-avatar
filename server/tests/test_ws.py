from fastapi.testclient import TestClient

from kamari_avatar.app import create_app


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
