"""KamariMcpToolProvider against a real in-process MCP server standing in for Kamari."""

from mcp.server.mcpserver import MCPServer

from kamari_avatar.impl.kamari_mcp import KamariMcpToolProvider
from kamari_avatar.interfaces import ToolProvider


def make_fake_kamari() -> MCPServer:
    server = MCPServer("fake-kamari")

    @server.tool()
    def weather(city: str) -> str:
        """Current weather for a city."""
        return f"Sunny in {city}"

    return server


async def test_lists_and_calls_kamari_tools_with_prefix():
    p = KamariMcpToolProvider(server=make_fake_kamari())
    assert isinstance(p, ToolProvider)
    await p.start()
    try:
        tools = await p.list_tools()
        assert [t.name for t in tools] == ["kamari.weather"]
        assert tools[0].parameters["properties"]["city"]["type"] == "string"
        result = await p.call_tool("kamari.weather", {"city": "Lisbon"})
        assert not result.is_error
        assert "Sunny in Lisbon" in str(result.content)
    finally:
        await p.stop()
