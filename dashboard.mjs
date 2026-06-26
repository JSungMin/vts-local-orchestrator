#!/usr/bin/env node
/*
 * dashboard.mjs — local web UI to WATCH the Qwen↔vts agent work in real time.
 *   node dashboard.mjs            # then open http://127.0.0.1:7878
 *   PORT=8080 node dashboard.mjs
 *
 * 127.0.0.1 only, no external deps, no CDN — same zero-transmission posture as vts's own dashboard.
 * Submits a task -> the agent loop runs server-side -> every event (token deltas, tool calls, results,
 * final answer, tok/s) is pushed to the browser over SSE and rendered as a live timeline.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createAgent } from "./agent-core.mjs";
import { loadConfig } from "./config-loader.mjs";

const HOST = "127.0.0.1";
const PORT = loadConfig().port;

const clients = new Set(); // SSE responses
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* dropped */ } }
}

let agent = null;
let busy = false;
createAgent({ onEvent: broadcast })
  .then((a) => { agent = a; console.error(`[dashboard] agent ready. project=${a.project} model=${a.model}`); })
  .catch((e) => console.error(`[dashboard] agent init failed: ${e.message}`));

// periodic `ollama ps` -> GPU/placement panel
const ollamaPs = () =>
  new Promise((resolve) => {
    const exe = process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama", "ollama.exe")
      : "ollama";
    const p = spawn(exe, ["ps"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
setInterval(async () => { const ps = await ollamaPs(); if (ps) broadcast({ type: "ps", text: ps }); }, 4000);

const HTML = String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Qwen ↔ vts live</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#58a6ff;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--tool:#bc8cff}
  *{box-sizing:border-box} body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--bg);color:var(--fg)}
  header{padding:10px 14px;border-bottom:1px solid var(--bd);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header b{color:var(--acc)} .dot{width:9px;height:9px;border-radius:50%;background:var(--mut);display:inline-block;margin-right:5px}
  .dot.on{background:var(--ok)} .dot.run{background:var(--warn);animation:pulse 1s infinite}
  @keyframes pulse{50%{opacity:.3}}
  .wrap{display:grid;grid-template-columns:1fr 320px;gap:0;height:calc(100vh - 52px)}
  main{overflow:auto;padding:14px} aside{border-left:1px solid var(--bd);padding:14px;overflow:auto;background:var(--panel)}
  form{display:flex;gap:8px;margin-bottom:14px}
  input[type=text]{flex:1;background:var(--panel);border:1px solid var(--bd);color:var(--fg);padding:9px 11px;border-radius:6px;font:inherit}
  button{background:var(--acc);border:0;color:#0d1117;font-weight:700;padding:9px 16px;border-radius:6px;cursor:pointer}
  button:disabled{opacity:.4;cursor:default}
  .ev{border:1px solid var(--bd);border-radius:8px;margin:8px 0;background:var(--panel);overflow:hidden}
  .ev .h{padding:6px 10px;font-weight:700;display:flex;justify-content:space-between;align-items:center}
  .ev .b{padding:8px 10px;border-top:1px solid var(--bd);white-space:pre-wrap;word-break:break-word;color:var(--mut)}
  .ev.tool .h{color:var(--tool)} .ev.res .h{color:var(--ok)} .ev.res.bad .h{color:var(--bad)}
  .ev.think .h{color:var(--acc)} .ev.final .h{color:var(--ok)} .ev.stop .h{color:var(--warn)}
  .pill{font-size:11px;color:var(--mut);font-weight:400}
  .args{color:var(--fg);font-size:12px}
  h3{margin:14px 0 6px;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .stat{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--bd)}
  .stat b{color:var(--fg)} pre.ps{white-space:pre;overflow:auto;font-size:11px;color:var(--mut);margin:0}
  .cur{color:var(--fg)}
</style></head><body>
<header>
  <span><span class="dot" id="dot"></span><b>Qwen ↔ vts</b> live</span>
  <span class="pill" id="proj">connecting…</span>
  <span class="pill" id="model"></span>
</header>
<div class="wrap">
  <main>
    <form id="f"><input type="text" id="q" placeholder="예: where is UGameInstance declared? / TakeDamage 호출처" autocomplete="off"><button id="go">Run</button></form>
    <div id="log"></div>
  </main>
  <aside>
    <h3>run stats</h3>
    <div class="stat"><span>status</span><b id="st">idle</b></div>
    <div class="stat"><span>step</span><b id="step">–</b></div>
    <div class="stat"><span>tool calls</span><b id="tc">0</b></div>
    <div class="stat"><span>tok/s</span><b id="tps">–</b></div>
    <div class="stat"><span>elapsed</span><b id="ms">–</b></div>
    <h3>토큰 절약 (이번 실행)</h3>
    <div class="stat"><span title="Claude가 실제로 받는 양 = Qwen 요약">A 위임 (이 방식)</span><b id="sa">–</b></div>
    <div class="stat"><span title="CC가 vs-search 직접 = capped 결과 전부">B CC+VTS</span><b id="sb">–</b></div>
    <div class="stat"><span title="CC가 grep/raw = uncapped 응답 (vts 실측비율 추정)">C CC+Grep</span><b id="sc">–</b></div>
    <div class="stat"><span>↓ vs VTS</span><b id="sv" style="color:var(--ok)">–</b></div>
    <div class="stat"><span>↓ vs Grep</span><b id="sg" style="color:var(--ok)">–</b></div>
    <h3>누적 절약 (세션)</h3>
    <div class="stat"><span>vs VTS</span><b id="cv">0</b></div>
    <div class="stat"><span>vs Grep</span><b id="cg" style="color:var(--ok)">0</b></div>
    <div class="pill" style="margin-top:4px">tok ≈ chars/4 추정 · C는 vts savings.json 툴별 raw:out 비율 기반</div>
    <h3>tools (locator)</h3>
    <div id="tools" class="pill"></div>
    <h3>ollama ps (GPU)</h3>
    <pre class="ps" id="ps">–</pre>
  </aside>
</div>
<script>
const log=document.getElementById('log'),dot=document.getElementById('dot');
let curThink=null,tcCount=0;
function el(cls,head,body){const d=document.createElement('div');d.className='ev '+cls;
  d.innerHTML='<div class="h"></div>'+(body!=null?'<div class="b"></div>':'');
  d.querySelector('.h').append(...(Array.isArray(head)?head:[head]));
  if(body!=null)d.querySelector('.b').textContent=body;log.appendChild(d);log.scrollTop=1e9;return d;}
function set(id,v){document.getElementById(id).textContent=v;}
const es=new EventSource('/events');
es.onmessage=e=>{const ev=JSON.parse(e.data);
  if(ev.type==='ready'){document.getElementById('proj').textContent=ev.project||'(no project)';
    document.getElementById('model').textContent=ev.model;document.getElementById('tools').textContent=(ev.tools||[]).join(', ');dot.className='dot on';}
  else if(ev.type==='task'){log.innerHTML='';tcCount=0;set('tc','0');set('tps','–');set('ms','–');set('st','running');dot.className='dot run';el('user','🧑 task',ev.task);curThink=null;}
  else if(ev.type==='step'){set('step',ev.step);}
  else if(ev.type==='delta'){if(!curThink){curThink=el('think',['🧠 model ',mk('span','pill','thinking…')],'');}
    const b=curThink.querySelector('.b');b.textContent+=ev.text;log.scrollTop=1e9;}
  else if(ev.type==='assistant_done'){if(curThink&&ev.stats&&ev.stats.evalCount){curThink.querySelector('.pill').textContent=ev.stats.evalCount+' tok';}curThink=null;}
  else if(ev.type==='tool_call'){tcCount++;set('tc',tcCount);
    const head=[mk('span','', (ev.dup?'🔁 ':'🔧 ')+ev.tool)];el(ev.dup?'tool':'tool',head,JSON.stringify(ev.args,null,1));}
  else if(ev.type==='tool_result'){el('res'+(ev.ok?'':' bad'),(ev.ok?'✅ ':'⚠️ ')+ev.tool,ev.text.slice(0,1500));}
  else if(ev.type==='final'){dot.className='dot on';set('st','done');applyStats(ev.stats);el('final','🟢 final answer',ev.answer);}
  else if(ev.type==='stopped'){dot.className='dot on';set('st','stopped');applyStats(ev.stats);el('stop','🟡 stopped: '+ev.reason,'');}
  else if(ev.type==='ps'){document.getElementById('ps').textContent=ev.text;}
};
let cumV=0,cumG=0;
const fmt=n=>(n||0).toLocaleString();
const pct=(a,b)=>b>0?' ('+Math.round(a/b*100)+'%)':'';
function applyStats(s){if(!s)return;if(s.tokPerSec)set('tps',s.tokPerSec);if(s.ms!=null)set('ms',(s.ms/1000).toFixed(1)+'s');
  const v=s.savings;if(v){set('sa',fmt(v.delegateTok));set('sb',fmt(v.ccVtsTok));set('sc',fmt(v.ccGrepTok));
    set('sv',fmt(v.savedVsVts)+pct(v.savedVsVts,v.ccVtsTok));set('sg',fmt(v.savedVsGrep)+pct(v.savedVsGrep,v.ccGrepTok));
    cumV+=v.savedVsVts;cumG+=v.savedVsGrep;set('cv',fmt(cumV));set('cg',fmt(cumG));}}
function mk(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e;}
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();
  const q=document.getElementById('q').value.trim();if(!q)return;
  document.getElementById('go').disabled=true;
  try{await fetch('/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:q})});}
  catch(err){alert(err.message);} finally{document.getElementById('go').disabled=false;}
});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(HTML);
  }
  if (url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`retry: 2000\n\n`);
    clients.add(res);
    if (agent) broadcast({ type: "ready", project: agent.project, model: agent.model, tools: agent.tools });
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url === "/run" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (!agent) { res.writeHead(503); return res.end("agent not ready"); }
      if (busy) { res.writeHead(409); return res.end("busy"); }
      let task;
      try { task = JSON.parse(body).task; } catch { res.writeHead(400); return res.end("bad json"); }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      busy = true;
      try { await agent.run(String(task || "")); }
      catch (e) { broadcast({ type: "stopped", reason: "error: " + e.message }); }
      finally { busy = false; }
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.error(`\n  Qwen↔vts dashboard:  http://${HOST}:${PORT}\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { agent?.close(); } catch { /* */ } process.exit(0); });
