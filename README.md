# Rayzia MCP — an MCP server that drives a real SVG editor

[Rayzia](https://rayzia.com) is a free online SVG/vector editor. This MCP server
lets an AI agent (Claude Code, Claude Desktop, or any MCP client) **drive the
running editor**: draw with real tools, edit the artwork already on the canvas,
read scene state back, and render PNGs so the model can see its own work.

Unlike generate-only servers that write an SVG file and hand it over, this one
gives the agent a full observe-and-act loop on a live canvas — and the human
watches every operation land, with each step one undo away.

**Docs:** [rayzia.com/mcp](https://rayzia.com/mcp/) · **Editor:** [rayzia.com/vector](https://rayzia.com/vector/)

```
MCP client ──stdio JSON-RPC──▶ server.mjs ──SSE /events──▶ browser bridge
                                    ▲                            │
                                    └──────── POST /reply ───────┘
browser bridge ──▶ editor host facade ──▶ engine (runs in a worker)
```

Zero npm dependencies — Node ≥16 built-ins only. The HTTP bridge binds to
`127.0.0.1` and every operation carries a per-browser capability token.

## Quickstart — the in-app way (recommended)

The editor has the browser side built in:

1. Open the editor at [rayzia.com/vector](https://rayzia.com/vector/).
2. Open the **AI Assistant** panel → settings (gear) → **Claude Code (local)**.
3. **Copy the SKILL.md** the pane generates — it embeds this server's code, your
   browser's capability token and the bridge port. Give it to Claude Code; it
   saves the server file and registers it as an MCP server:

   ```bash
   claude mcp add rayzia \
     --env AI_MCP_PORT=<port> --env AI_MCP_TOKEN=<token> \
     -- node /absolute/path/to/rayzia-mcp-server.mjs
   ```

4. Click **Connect**. The status dot turns green. Type in Claude Code directly,
   or chat from the panel by telling Claude Code to "listen for Rayzia panel prompts".

## Quickstart — any MCP client

1. Run the editor in a browser and connect the bridge (in-app **Connect** as
   above, or paste [`bridge.js`](bridge.js) into the editor's DevTools console).
2. Point your MCP client at the server over stdio:

   ```json
   {
     "mcpServers": {
       "rayzia": {
         "command": "node",
         "args": ["/absolute/path/to/server.mjs"],
         "env": { "AI_MCP_PORT": "8765", "AI_MCP_TOKEN": "<token>" }
       }
     }
   }
   ```

Diagnostics go to **stderr** (stdout is the JSON-RPC channel). Default bridge
port is `8765`, override with `AI_MCP_PORT`.

## Tools

| Tool | Purpose |
|---|---|
| `get_catalog` | Discover everything the editor exposes: semantic verbs with param schemas, 533 raw commands, 69 effects, 57 tools. Call it first. |
| `get_state` | Read the scene: selection, all objects (recursed into groups) with ids, bounding boxes and paints, plus active tool, document size and view. |
| `run_verb` | High-level verbs: shapes, text (area / on-path / vertical / per-character), gradients, blends, warps, ~200 live path effects, filters, lock/hide, asset library, batch. One undo step each. |
| `draw` | Draw with a real tool via synthetic input: Pen paths or freehand strokes, with modifier keys for shape-builder punches and mesh edits. |
| `run_command` | Escape hatch: any raw engine command by name. File/document ops are deny-listed at the engine boundary. |
| `get_svg` | Export the current document as a round-trip-safe SVG string. |
| `get_render` | Render the canvas to a PNG (MCP image block) so the model can see its work. |
| `wait_for_prompt` | Long-poll for the next prompt the user types in the editor's AI Assistant panel. |
| `reply_to_user` | Post a short assistant reply back into that panel. |

## Security

- The server binds to `127.0.0.1` only, and rejects requests whose `Host`
  header is not loopback (closes the DNS-rebinding drive path).
- Every operation carries a capability token (`AI_MCP_TOKEN`) generated once per
  browser; the editor bridge rejects ops with a mismatched token, so a rogue
  local process squatting the port cannot drive the canvas.
- File and document operations (save / open / new / import) are deny-listed at
  the engine boundary.
- Connecting is opt-in from the editor's side. The panel `/prompt` inbox is
  token-authenticated too, so a local web page cannot inject prompts.

Do not expose the bridge port beyond localhost.

## Self-test

`_selftest.mjs` spawns the server, waits for a browser bridge, then drives the
full round-trip (initialize → tools/list → get_catalog → createShape →
addGradient → get_state → get_svg):

```bash
AI_MCP_PORT=8791 node _selftest.mjs
```

Expect `SELFTEST PASS`.

## License

MIT © 2026 Rayzia
