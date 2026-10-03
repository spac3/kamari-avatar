"""A stand-in for Kamari's hand-written MCP endpoint, matching its observed behaviour:
protocol 2024-11-05, POST /mcp with one JSON-RPC object and a plain JSON reply, Bearer
auth on every method (401 + WWW-Authenticate without it), -32601 for anything beyond
initialize/ping/tools, and tool results as one text item holding a JSON dict."""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

API_KEY = "test-key"

TOOLS = [
    {"name": "memory_get", "description": "Get a memory by id", "capability": "memory.get",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "memory_delete", "description": "Delete a memory", "capability": "memory.delete",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}}},
    {"name": "calendar_list", "description": "List calendar events", "capability": "calendar.list",
     "inputSchema": {"type": "object", "properties": {"days": {"type": "integer"}}}},
    {"name": "investec_transfer", "description": "Move money", "capability": "investec.transfer",
     "inputSchema": {"type": "object"}},
    {"name": "exec_run", "description": "Run a shell command", "capability": "exec.run",
     "inputSchema": {"type": "object"}},
]


def create_fake_kamari() -> FastAPI:
    app = FastAPI()
    app.state.calls = []

    def ok(id_: Any, result: dict) -> JSONResponse:
        return JSONResponse({"jsonrpc": "2.0", "id": id_, "result": result})

    @app.post("/mcp")
    async def mcp(request: Request) -> Response:
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {API_KEY}" and request.headers.get("x-api-key") != API_KEY:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"'})
        msg = await request.json()
        method, id_ = msg.get("method"), msg.get("id")
        if id_ is None:  # notification
            return Response(status_code=202)
        if method == "initialize":
            return ok(id_, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                            "serverInfo": {"name": "kamari", "version": "1.0.80"}})
        if method == "ping":
            return ok(id_, {})
        if method == "tools/list":
            return ok(id_, {"tools": [{k: t[k] for k in ("name", "description", "inputSchema")} for t in TOOLS]})
        if method == "tools/call":
            name, args = msg["params"]["name"], msg["params"].get("arguments") or {}
            app.state.calls.append((name, args))
            if name == "memory_get" and args.get("id") == "missing":
                payload, is_error = {"error": "not found"}, True
            else:
                payload, is_error = {"ok": True, "tool": name, "args": args}, False
            return ok(id_, {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": is_error,
                            "_meta": {"task_id": "t_1"}})
        return JSONResponse({"jsonrpc": "2.0", "id": id_, "error": {"code": -32601, "message": "Method not found"}})

    @app.get("/mcp")
    async def mcp_get() -> Response:
        return Response(status_code=405)

    return app
