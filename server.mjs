#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════
   server.mjs — Rayzia MCP: drives the running Rayzia SVG editor's SVL layer.

   Lets an MCP client (Claude Desktop / Claude Code / any) drive the running editor:
   discover the tool catalog, read scene state, run semantic verbs, draw, export SVG.

   ZERO dependencies (Node ≥16 built-ins only): a newline-delimited JSON-RPC MCP
   server on stdio + a tiny SSE/HTTP bridge the browser connects to (no WebSocket
   framing, no npm install). Architecture:

     MCP client ──stdio JSON-RPC──▶ THIS process ──SSE(/events)──▶ browser bridge.js
                                          ▲                              │
                                          └────── POST /reply ───────────┘
     browser bridge.js ──▶ window.__skiavgW2.host ──▶ worker SVL (72-AICommandLayer)

   RUN:  node server.mjs            (HTTP bridge on :8765, or $AI_MCP_PORT)
   Then paste bridge.js into the editor's devtools console (or wire it in).
   Point your MCP client's stdio command at this file (see README).

   ⚠ P0 SECURITY: no auth, localhost only, and the worker itself has no origin check.
   Do NOT expose the bridge port publicly. Real deployment needs a capability token +
   a worker-side command allowlist (see the design doc §Safety).
   ════════════════════════════════════════════════════════════════════════════ */
import http from 'node:http';

const PORT = parseInt(process.env.AI_MCP_PORT || '8765', 10);
// Capability token (P1): the editor's in-app bridge verifies every op carries this token,
// so a rogue local process squatting the port can't drive the canvas. The editor generates
// it (AI settings → Claude Code) and embeds it in the SKILL.md that configures this server.
const TOKEN = process.env.AI_MCP_TOKEN || '';
const log = (...a) => { try { process.stderr.write('[ai-mcp] ' + a.join(' ') + '\n'); } catch {} };  // NEVER stdout (that's the JSON-RPC channel)

/* ── HTTP bridge: one SSE client (the browser), reqId-correlated replies ────── */
let sseClient = null;                    // the connected browser's SSE response stream
const pending = new Map();               // reqId → { resolve, timer }
let seq = 0;

function sendOp(op, timeoutMs) {
  // draws replay real input tapes and renders rasterize + encode — give them longer.
  // Heavy documents (1000s of objects) make even verb/state ops legitimately slow (the
  // engine's per-edit work is O(doc)); 15s falsely reported them dead, so allow 30/60.
  const ms = timeoutMs || ((op.kind === 'draw' || op.kind === 'render') ? 60000 : 30000);
  return new Promise((resolve) => {
    if (!sseClient) { resolve({ error: 'bridge not connected — in the editor: AI panel → settings → Claude Code → Connect' }); return; }
    const reqId = 'op' + (++seq);
    const timer = setTimeout(() => { pending.delete(reqId); resolve({ error: 'bridge timeout' }); }, ms);
    pending.set(reqId, { resolve, timer });
    try { sseClient.write('data: ' + JSON.stringify({ reqId, token: TOKEN || undefined, ...op }) + '\n\n'); }
    catch { pending.delete(reqId); clearTimeout(timer); resolve({ error: 'bridge write failed' }); }
  });
}

// Access-Control-Allow-Private-Network: Chrome's Private Network Access preflights
// public-https → loopback requests; without this header the deployed editor couldn't connect.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-ai-mcp-token', 'Access-Control-Allow-Private-Network': 'true' };

/* ── panel chat: prompts typed in the editor's AI panel, pulled by the MCP client ──
   The AI Assistant panel (provider "Claude Code (local)") POSTs the user's text to
   /prompt (token-authenticated — a rogue local page must NOT be able to inject prompts
   into the agent). The MCP client long-polls wait_for_prompt to take one, does the work,
   and pushes the answer back into the panel with reply_to_user. */
let promptQueue = [];              // texts waiting for a wait_for_prompt
let promptWaiter = null;           // the currently parked wait_for_prompt, if any

function takePrompt(timeoutMs) {
  if (promptQueue.length) return Promise.resolve({ prompt: promptQueue.shift(), queued: promptQueue.length });
  return new Promise((resolve) => {
    const w = { done: false };
    w.finish = (payload) => { if (w.done) return; w.done = true; if (promptWaiter === w) promptWaiter = null; clearTimeout(w.timer); resolve(payload); };
    w.timer = setTimeout(() => w.finish({ prompt: null, timedOut: true, note: 'no prompt within ' + Math.round(timeoutMs / 1000) + 's — call wait_for_prompt again to keep listening' }), timeoutMs);
    if (promptWaiter) promptWaiter.finish({ prompt: null, timedOut: true, note: 'superseded by a newer wait_for_prompt' });
    promptWaiter = w;
  });
}
function pushPrompt(text) {
  if (promptWaiter) { promptWaiter.finish({ prompt: text, queued: promptQueue.length }); return true; }   // delivered live
  promptQueue.push(text); return false;                                                                    // parked for the next wait
}

http.createServer((req, res) => {
  // DEV-ONLY hardening: reject any request whose Host header isn't loopback. This bridge DRIVES the
  // editor, so without a Host check a malicious web page could use DNS-rebinding (resolve its own
  // hostname to 127.0.0.1) to POST /run and drive a developer's editor while they browse. A loopback
  // literal Host cannot be rebound, so this closes the rebinding/CSRF drive path.
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const url = req.url || '/';
  if (url === '/events') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    sseClient = res; log('bridge connected');
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ka); if (sseClient === res) sseClient = null; log('bridge disconnected'); });
    return;
  }
  if (url === '/reply' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body || '{}'), p = pending.get(msg.reqId);
        if (p) { clearTimeout(p.timer); pending.delete(msg.reqId); p.resolve(msg); }
      } catch (e) { log('bad /reply', e.message); }
      res.writeHead(200, CORS); res.end('ok');
    });
    return;
  }
  // Panel chat inbox: the editor's AI panel POSTs the user's typed prompt here.
  // Token-REQUIRED (header x-ai-mcp-token) — without it any local web page could inject
  // prompts into the user's agent session (prompt-injection with file access).
  if (url === '/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { msg = {}; }
      const tok = req.headers['x-ai-mcp-token'] || msg.token || '';
      if (TOKEN && tok !== TOKEN) { res.writeHead(403, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad token' })); return; }
      const text = String(msg.text || '').slice(0, 20000);
      if (!text.trim()) { res.writeHead(400, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'empty prompt' })); return; }
      const delivered = pushPrompt(text);
      log('panel prompt ' + (delivered ? 'delivered' : 'queued') + ' (' + text.length + ' chars)');
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered, listening: delivered, queued: promptQueue.length }));
    });
    return;
  }
  // Direct drive hatch: POST an op ({kind:'verb'|'command'|'draw'|'state'|'catalog'|'svg', …})
  // and get its result. Lets Claude Code (or curl) drive the editor without the MCP stdio client
  // — the "use it right now" path. GET /status to check if the browser bridge is connected.
  if (url === '/status') { res.writeHead(200, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ bridge: sseClient ? 'connected' : 'waiting', listening: !!promptWaiter, queuedPrompts: promptQueue.length })); return; }
  if (url === '/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', async () => {
      let op; try { op = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
      // waitPrompt: curl-testable twin of the wait_for_prompt MCP tool (server-local, no bridge)
      const result = (op.kind === 'waitPrompt')
        ? await takePrompt(Math.min(55, +op.timeoutSec || 25) * 1000)
        : await sendOp(op);
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(200, CORS); res.end('ai-mcp bridge alive; SSE:' + (sseClient ? 'connected' : 'waiting'));
}).listen(PORT, '127.0.0.1', () => log('HTTP bridge on http://127.0.0.1:' + PORT + '  (SSE /events, POST /reply, POST /run, GET /status)'));

/* ── MCP tools → bridge ops ─────────────────────────────────────────────────*/
const TOOLS = [
  { name: 'get_catalog', description: 'Discover everything the editor can do: semantic verbs (with param schemas), every raw command (typed where declared), effects, and tools. Call this FIRST.',
    inputSchema: { type: 'object', properties: {} }, op: () => ({ kind: 'catalog' }) },
  { name: 'get_state', description: 'Read the current scene: selection, all objects (recursed into groups) with ids+bboxes+paint, active tool, document size, view. The "observe" half of the loop.',
    inputSchema: { type: 'object', properties: {} }, op: () => ({ kind: 'state' }) },
  { name: 'run_verb', description: 'Run a high-level semantic verb (createShape, createText, setText, areaText (Area Type), textOnPath (Type on a Path), touchType (per-character transforms), applyBlend, addGradient, transformEffect, applyEnvelopeWarp, applyEffect, applyPathEffect (~200 LPEs), applyFilter (Filter Gallery presets), setPaint (also opacity/stroke-width/blur/blend via value), setLocked, setHidden, group, select (ids or marquee rect:[x,y,w,h]), useTool, runCommand, loadFont, batch, generateImage (AI text→image onto canvas, user\'s own key), placeImage (data: URL), saveAsset/listAssets/applyAsset/createAssetFolder/moveAsset/renameAsset/deleteAsset (persistent asset library with folders)). Vertical Type = writingMode:"vertical-rl" on createText/setText. Returns a result envelope {ok, affected, nodeDelta}. Each verb is one undo step. Get param schemas from get_catalog.verbs.',
    inputSchema: { type: 'object', required: ['verb'], properties: { verb: { type: 'string' }, args: { type: 'object' } } }, op: (a) => ({ kind: 'verb', verb: a.verb, args: a.args || {} }) },
  { name: 'draw', description: 'Draw with a real tool via synthetic input: verb "drawPath" (Pen, {points:[[x,y]...], closed}) or "freehand" ({points, tool|brush}). Coords are ~scene px; for exact geometry prefer run_verb createShape. Pass mods:"alt"|"ctrl"|"shift" (or per-point [x,y,"alt"]) to drive Alt/Ctrl-gated behaviors (shape-builder punch, mesh edits).',
    inputSchema: { type: 'object', required: ['verb'], properties: { verb: { type: 'string', enum: ['drawPath', 'freehand'] }, args: { type: 'object' } } }, op: (a) => ({ kind: 'draw', verb: a.verb, args: a.args || {} }) },
  { name: 'run_command', description: 'Escape hatch: run any raw engine command by name with positional args (the long tail listed in get_catalog.commands / .prefixCommands, incl. prefix-routed Selector.*/Zoom.*). Most take one options object. File/document ops (save/open/new/import) are deny-listed at the engine boundary.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, args: { type: 'array' } } }, op: (a) => ({ kind: 'command', name: a.name, args: a.args || [] }) },
  { name: 'get_svg', description: 'Export the current document as an SVG string (round-trip-safe) so you can inspect structure, ids, and paths.',
    inputSchema: { type: 'object', properties: {} }, op: () => ({ kind: 'svg' }) },
  { name: 'get_render', description: 'Render the canvas to a PNG so you can SEE the artwork (fits the whole page into view first). Returns an MCP image block — use it to check your work after structural changes.',
    inputSchema: { type: 'object', properties: { maxEdge: { type: 'number', description: 'longest image edge in px (default 1024)' } } }, op: (a) => ({ kind: 'render', maxEdge: a.maxEdge || 1024 }) },
  { name: 'wait_for_prompt', description: 'PANEL CHAT: block until the user types a prompt in the editor\'s AI Assistant panel (provider "Claude Code (local)"), then return it as {prompt}. Returns {prompt:null, timedOut:true} after ~timeoutSec — that is NORMAL, just call it again to keep listening. Loop: wait_for_prompt → do the work with the other tools → reply_to_user → wait_for_prompt. Stop when the prompt says stop/exit or the user tells you to.',
    inputSchema: { type: 'object', properties: { timeoutSec: { type: 'number', description: 'seconds to wait (default 25, cap 55 — stay under the MCP tool timeout)' } } }, local: (a) => takePrompt(Math.min(55, +a.timeoutSec || 25) * 1000) },
  { name: 'reply_to_user', description: 'PANEL CHAT: show a message in the editor\'s AI Assistant panel as the assistant reply. Answer every prompt you took with wait_for_prompt this way — keep it to 1-2 lines; the user is watching the canvas.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, op: (a) => ({ kind: 'panelReply', text: String(a.text || '').slice(0, 8000) }) },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/* ── MCP JSON-RPC over stdio (newline-delimited) ────────────────────────────*/
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rayzia', version: '0.2.0' } });
  } else if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) {
    /* no response to notifications */
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  } else if (method === 'tools/call') {
    const t = TOOL_BY_NAME[(params || {}).name];
    if (!t) { replyErr(id, -32602, 'unknown tool ' + (params || {}).name); return; }
    if (t.local) {   // server-local tool (wait_for_prompt) — no bridge round-trip
      const r = await t.local(params.arguments || {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false });
      return;
    }
    const result = await sendOp(t.op(params.arguments || {}));
    const isErr = !!(result && result.error);
    if (!isErr && result && result.image) {   // get_render → real MCP image block (base64 PNG)
      reply(id, { content: [{ type: 'image', data: result.image, mimeType: 'image/png' }, { type: 'text', text: 'rendered ' + result.w + 'x' + result.h }], isError: false });
      return;
    }
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: isErr });
  } else {
    replyErr(id, -32601, 'method not found: ' + method);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log('bad json-rpc line'); continue; }
    Promise.resolve(handle(msg)).catch((e) => { if (msg && msg.id != null) replyErr(msg.id, -32000, String(e && e.message || e)); });
  }
});
// When Claude Code spawns us as an stdio MCP server, stdin closing means "shut down". But when
// run STANDALONE (backgrounded for the /run drive hatch), stdin is already closed — don't die.
if (!process.env.AI_MCP_STANDALONE) process.stdin.on('end', () => process.exit(0));
log('MCP stdio server ready (' + TOOLS.length + ' tools). Waiting for a client + a browser bridge.');
