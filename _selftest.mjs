/* ai-mcp/_selftest.mjs — end-to-end proof: MCP client → server → (browser bridge) →
   host → SVL → back. Spawns server.mjs, waits for a browser bridge to connect, then
   drives real MCP tool calls. Run in background; inject bridge.js in the editor.
   PORT via AI_MCP_PORT (default 8791). Exits 0 on PASS, 1 on FAIL. */
import { spawn } from 'node:child_process';
const PORT = process.env.AI_MCP_PORT || '8791';
const srv = spawn('node', ['server.mjs'], { env: { ...process.env, AI_MCP_PORT: PORT }, stdio: ['pipe', 'pipe', 'inherit'] });
let out = ''; const byId = {};
srv.stdout.on('data', (d) => {
  out += d; let nl;
  while ((nl = out.indexOf('\n')) >= 0) { const line = out.slice(0, nl).trim(); out = out.slice(nl + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id && byId[m.id]) { byId[m.id](m); delete byId[m.id]; } } catch {} }
});
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => { const i = ++id; byId[i] = res; srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); setTimeout(() => rej(new Error('rpc timeout ' + method)), 25000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitBridge() { for (let i = 0; i < 80; i++) { try { const t = await (await fetch('http://127.0.0.1:' + PORT + '/')).text(); if (/connected/.test(t)) return true; } catch {} await sleep(500); } return false; }
const txt = (r) => { try { return JSON.parse(r.result.content[0].text); } catch { return r.result; } };

(async () => {
  try {
    const init = await rpc('initialize', {});
    console.log('SELFTEST init:', init.result.serverInfo.name, init.result.protocolVersion);
    console.log('SELFTEST waiting-for-bridge (inject bridge.js with __AI_MCP_URL=http://127.0.0.1:' + PORT + ')');
    if (!(await waitBridge())) { console.log('SELFTEST FAIL: no bridge'); srv.kill(); process.exit(1); }
    console.log('SELFTEST bridge-connected');
    const list = await rpc('tools/list', {});
    console.log('SELFTEST tools:', list.result.tools.map((t) => t.name).join(','));
    const cat = txt(await rpc('tools/call', { name: 'get_catalog', arguments: {} }));
    console.log('SELFTEST catalog: verbs=' + Object.keys(cat.catalog.verbs).length + ' cmds=' + cat.catalog.commands.length + ' effects=' + cat.catalog.effects.length + ' prefix=' + cat.catalog.prefixCommands.length);
    const mk = txt(await rpc('tools/call', { name: 'run_verb', arguments: { verb: 'createShape', args: { kind: 'rect', x: 90, y: 90, width: 140, height: 100, fill: '#22c55e', id: 'mcpRect' } } }));
    console.log('SELFTEST createShape:', JSON.stringify(mk.result));
    const grad = txt(await rpc('tools/call', { name: 'run_verb', arguments: { verb: 'addGradient', args: { target: 'mcpRect', which: 'fill', type: 'linear', angle: 45, stops: [{ color: '#f59e0b', pos: 0 }, { color: '#ef4444', pos: 100 }] } } }));
    console.log('SELFTEST addGradient:', JSON.stringify(grad.result));
    const st = txt(await rpc('tools/call', { name: 'get_state', arguments: {} }));
    console.log('SELFTEST state objects:', st.state.objects.length, JSON.stringify(st.state.objects.map((o) => o.tag)));
    const svg = txt(await rpc('tools/call', { name: 'get_svg', arguments: {} }));
    console.log('SELFTEST svg len:', (svg.svg || '').length, 'hasGradient:', /Gradient|url\(#/.test(svg.svg || ''));
    console.log('SELFTEST PASS');
    srv.kill(); process.exit(0);
  } catch (e) { console.log('SELFTEST ERROR:', e.message); srv.kill(); process.exit(1); }
})();
