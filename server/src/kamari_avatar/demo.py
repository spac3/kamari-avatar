"""M1 demo: walk the avatar somewhere, have it say a line, and wait for the browser's events.

    python -m kamari_avatar.demo                      # sofa, default line
    python -m kamari_avatar.demo window "Nice view, isn't it?"

Needs the backend running with debug endpoints on and a browser tab connected (tap the
start button first so audio is unlocked).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("location", nargs="?", default="sofa")
    p.add_argument("line", nargs="?", default="Hello, welcome. Let me show you around the studio.")
    p.add_argument("--server", default="http://127.0.0.1:8000")
    p.add_argument("--session", help="session id (default: the most recently active browser)")
    p.add_argument("--timeout", type=float, default=60)
    a = p.parse_args(argv)

    body = {"steps": [{"walk_to": a.location}, {"say": a.line}], "timeout_s": a.timeout}
    if a.session:
        body["session_id"] = a.session
    req = urllib.request.Request(f"{a.server}/debug/run", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=a.timeout * 2 + 5) as r:
            result = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"{e.code}: {json.load(e).get('detail', e.reason)}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"cannot reach {a.server}: {e.reason}", file=sys.stderr)
        return 1

    for e in result["events"]:
        ev = e["event"]
        step = next(iter(e["step"].items()))
        detail = {k: v for k, v in ev.items() if k not in ("type", "cmd_id", "utterance_id")}
        print(f"{step[0]:8} {step[1]!r:40.40} -> {ev['type']} {json.dumps(detail)}")
    print("ok" if result["ok"] else "FAILED")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
