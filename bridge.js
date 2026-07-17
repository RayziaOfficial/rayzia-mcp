/* ════════════════════════════════════════════════════════════════════════════
   bridge.js — browser side of the Rayzia MCP adapter.

   Connects the running editor to server.mjs and forwards MCP ops to the
   engine via the existing host facade (window.__skiavgW2.host) — no engine edits.

   NOTE: the editor now has this BUILT IN — AI panel → settings → Claude Code →
   Connect (src/ai/cc-bridge.js). This console-paste copy remains for debugging a
   broken UI. Set window.__AI_MCP_URL / window.__AI_MCP_TOKEN before pasting.

   Transport: SSE (GET /events) for server→browser ops; fetch POST (/reply) back.
   Correlates SVL replies by reqId; export/replay have no reqId so they're awaited
   per-op (ops are serialized). Mirrors the design's reqId-correlation table.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  var SERVER = window.__AI_MCP_URL || 'http://127.0.0.1:8765';
  var TOKEN = window.__AI_MCP_TOKEN || '';   // if set, ops must carry the same token
  var w2 = window.__skiavgW2, host = w2 && w2.host;
  if (!host) { console.error('[ai-mcp bridge] window.__skiavgW2.host not found — is the W2 editor loaded?'); return; }
  if (window.__aiMcpBridge) { try { window.__aiMcpBridge.stop(); } catch (e) {} }

  var waiters = {};   // key → resolve  (svl replies keyed by reqId; export/replay by a fixed key)
  host.onState(function (m) {
    if (!m || !m.type) return;
    if (m.type === 'svl-catalog' && waiters[m.reqId]) waiters[m.reqId]({ catalog: m.catalog });
    else if (m.type === 'svl-state' && waiters[m.reqId]) waiters[m.reqId]({ state: m.state });
    else if (m.type === 'svl-result' && waiters[m.reqId]) waiters[m.reqId]({ result: m.result });
    else if (m.type === 'svl-tape' && waiters['tape:' + m.reqId]) waiters['tape:' + m.reqId]({ tape: m.tape });
    else if (m.type === 'export-svg-result' && waiters['export']) waiters['export']({ svg: m.svg, w: m.w, h: m.h });
    else if (m.type === 'replay-done' && waiters['replay']) waiters['replay']({ ok: true });
    else if (m.type === 'bugshot-result' && waiters['bugshot']) waiters['bugshot']({ px: m.px, w: m.w, h: m.h, error: m.error });
  });

  function reply(reqId, payload) {
    var body = JSON.stringify(Object.assign({ reqId: reqId }, payload));
    fetch(SERVER + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }).catch(function () {});
  }
  var seq = 0;
  function wait(key, fire, ms) {
    return new Promise(function (res) {
      waiters[key] = function (p) { delete waiters[key]; res(p); };
      try { fire(); } catch (e) { delete waiters[key]; res({ error: String(e && e.message || e) }); return; }
      setTimeout(function () { if (waiters[key]) { delete waiters[key]; res({ error: 'timeout' }); } }, ms || 12000);
    });
  }
  function settle(ms) { return new Promise(function (r) { setTimeout(r, ms || 150); }); }

  // render: RGBA framebuffer → downscaled PNG base64, encoded on the main thread
  function encodePng(px, w, h, maxEdge) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
    var sw = w, sh = h, m = Math.max(w, h);
    if (m > maxEdge) { var k = maxEdge / m; sw = Math.max(1, Math.round(w * k)); sh = Math.max(1, Math.round(h * k)); }
    var c2 = document.createElement('canvas'); c2.width = sw; c2.height = sh;
    c2.getContext('2d').drawImage(c, 0, 0, sw, sh);
    return { image: c2.toDataURL('image/png').split(',')[1], w: sw, h: sh };
  }

  async function handle(op) {
    var rid = op.reqId, x;
    if (TOKEN && op.token !== TOKEN) { reply(rid, { error: 'bad token' }); return; }
    try {
      if (op.kind === 'catalog') { x = 'r' + (++seq); reply(rid, await wait(x, function () { host.runCommand('SVL_CATALOG', { reqId: x }); })); }
      else if (op.kind === 'state') { x = 'r' + (++seq); reply(rid, await wait(x, function () { host.runCommand('SVL_STATE', { reqId: x }); })); }
      else if (op.kind === 'verb') { x = 'r' + (++seq); reply(rid, await wait(x, function () { host.runCommand('SVL_INVOKE', { reqId: x, verb: op.verb, args: op.args || {} }); })); }
      // command routes through the SVL runCommand verb (NOT raw host.runCommand) so it gets
      // the engine deny-list + prefix routing (Selector.*/Zoom.*/PAINT_SWAP) + a result envelope.
      else if (op.kind === 'command') { x = 'r' + (++seq); reply(rid, await wait(x, function () { host.runCommand('SVL_INVOKE', { reqId: x, verb: 'runCommand', args: { name: op.name, args: op.args || [] } }); })); }
      else if (op.kind === 'svg') { reply(rid, await wait('export', function () { host.exportSVG(); })); }
      else if (op.kind === 'panelReply') { console.log('[ai-mcp bridge] reply_to_user:', op.text); reply(rid, { ok: true, note: 'console bridge has no AI panel — message logged to console' }); }
      else if (op.kind === 'render') {
        var wk = w2 && w2.worker;
        if (!wk) { reply(rid, { error: 'no worker for render' }); return; }
        try { host.runCommand('Zoom.fitPage'); } catch (e) {}
        await settle(200);
        var shot = await wait('bugshot', function () { wk.postMessage({ type: 'bugshot-request' }); }, 8000);
        if (shot.error || !shot.px) { reply(rid, { error: 'bugshot failed: ' + (shot.error || 'no pixels') }); return; }
        reply(rid, encodePng(shot.px, shot.w, shot.h, op.maxEdge || 1024));
      }
      else if (op.kind === 'draw') {
        x = 'r' + (++seq);
        var tp = await wait('tape:' + x, function () { host.runCommand('SVL_COMPILE_DRAW', { reqId: x, verb: op.verb, args: op.args || {} }); });
        if (tp && tp.tape) { var done = await wait('replay', function () { host.replayTape(tp.tape); }, 20000); reply(rid, { ok: !!(done && done.ok) }); }
        else reply(rid, { error: 'compile failed' });
      } else reply(rid, { error: 'unknown op ' + op.kind });
    } catch (e) { reply(rid, { error: String(e && e.message || e) }); }
  }

  var es = new EventSource(SERVER + '/events');
  es.onmessage = function (e) { try { handle(JSON.parse(e.data)); } catch (x) {} };
  es.onopen = function () { console.log('[ai-mcp bridge] connected to', SERVER, '— driving window.__skiavgW2.host'); };
  es.onerror = function () { /* EventSource auto-reconnects */ };
  window.__aiMcpBridge = { es: es, stop: function () { try { es.close(); } catch (e) {} window.__aiMcpBridge = null; } };
  console.log('[ai-mcp bridge] starting → ' + SERVER);
})();
