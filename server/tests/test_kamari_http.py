"""KamariMcpToolProvider over real HTTP framing against a Kamari look-alike."""

import httpx2
import pytest
from fake_kamari import API_KEY, create_fake_kamari

from kamari_avatar.impl.kamari_mcp import KamariMcpToolProvider


def provider(app, **kw):
    def factory(headers):
        return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://kamari", headers=headers)

    return KamariMcpToolProvider("http://kamari/mcp", http_client_factory=factory, **kw)


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("KAMARI_API_KEY", API_KEY)
    return create_fake_kamari()


async def test_only_allowlisted_tools_reach_the_llm(app):
    p = provider(app, allow=["memory_*", "calendar_*", "investec_*"], deny=["*_delete"])
    await p.start()
    try:
        names = [t.name for t in await p.list_tools()]
        # investec is allowlisted here but always denied; memory_delete hits the extra deny glob
        assert names == ["kamari__memory_get", "kamari__calendar_list"]
    finally:
        await p.stop()


async def test_calls_parse_kamari_json_results(app):
    p = provider(app, allow=["memory_*"])
    await p.start()
    try:
        await p.list_tools()
        r = await p.call_tool("kamari__memory_get", {"id": "m1"})
        assert r == r.__class__({"ok": True, "tool": "memory_get", "args": {"id": "m1"}}, False)
        err = await p.call_tool("kamari__memory_get", {"id": "missing"})
        assert err.is_error and err.content == {"error": "not found"}
    finally:
        await p.stop()


async def test_refuses_tools_outside_the_allowlist_without_calling_kamari(app):
    p = provider(app, allow=["memory_get"])
    await p.start()
    try:
        await p.list_tools()
        r = await p.call_tool("kamari__exec_run", {"cmd": "rm -rf /"})
        assert r.is_error
        assert app.state.calls == []
    finally:
        await p.stop()


async def test_needs_an_api_key(monkeypatch):
    monkeypatch.delenv("KAMARI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="KAMARI_API_KEY"):
        await provider(create_fake_kamari(), allow=["*"]).start()


async def test_tool_list_is_cached_then_refreshed(app):
    p = provider(app, allow=["memory_get"], refresh_s=3600)
    await p.start()
    try:
        first = await p.list_tools()
        assert await p.list_tools() == first
        assert await p.list_tools(force=True) == first
    finally:
        await p.stop()


def test_rejects_prefix_llm_apis_cannot_accept():
    with pytest.raises(ValueError):
        KamariMcpToolProvider("http://x/mcp", prefix="kamari.")
