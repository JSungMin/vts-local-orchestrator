#!/usr/bin/env node
/*
 * dashboard.mjs — local web UI to WATCH the local-LLM↔vts agent work in real time.
 *   node dashboard.mjs            # then open http://127.0.0.1:7878
 *   PORT=8080 node dashboard.mjs
 *
 * 127.0.0.1 only, no external deps, no CDN — same zero-transmission posture as vts's own dashboard.
 * Submits a task -> the agent loop runs server-side -> every event (token deltas, tool calls, results,
 * final answer, tok/s) is pushed to the browser over SSE and rendered as a live timeline.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "./agent-core.mjs";
import { loadConfig } from "./config-loader.mjs";
import { readActivity, ACTIVITY_FILE } from "./activity-log.mjs";

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

// Watch the shared activity bus so the tree refreshes the instant ANY qvts entry point (CLI/daemon/hook/this
// dashboard) appends a record. fs.watch can miss events on some platforms, so a slow poll backs it up.
function pingActivity() { broadcast({ type: "activity-changed" }); }
try {
  fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, ""); // so watch has a target
  fs.watch(ACTIVITY_FILE, { persistent: false }, () => pingActivity());
} catch { /* watch unavailable — the poll below covers it */ }
setInterval(pingActivity, 5000);

const HTML = String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>local LLM ↔ vts live</title>
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
  .tabs{display:flex;gap:6px;margin-bottom:10px}
  .tab{background:var(--panel);border:1px solid var(--bd);color:var(--mut);font-weight:600;padding:6px 12px;border-radius:6px}
  .tab.on{background:var(--acc);color:#0d1117}
  details.grp{border:1px solid var(--bd);border-radius:8px;margin:6px 0;background:var(--panel)}
  details.grp>summary{padding:7px 10px;cursor:pointer;font-weight:700;list-style:none}
  details.grp>summary::-webkit-details-marker{display:none}
  details.grp>summary:before{content:"▸ ";color:var(--mut)} details.grp[open]>summary:before{content:"▾ "}
  details.kind{margin:4px 8px 4px 16px;border-left:2px solid var(--bd)}
  details.kind>summary{padding:5px 10px;cursor:pointer;color:var(--tool);font-weight:600;list-style:none}
  details.kind>summary::-webkit-details-marker{display:none}
  .runs{padding:2px 0 6px 14px}
  .run{border-top:1px solid var(--bd);padding:5px 10px;font-size:12px}
  .run .top{display:flex;gap:8px;align-items:center;color:var(--mut)}
  .run .task{color:var(--fg);font-weight:600} .run .res{color:var(--mut);margin-top:2px;white-space:pre-wrap;word-break:break-word}
  .badge{font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid var(--bd);color:var(--mut)}
  .badge.dash{color:var(--acc);border-color:var(--acc)} .badge.cli{color:var(--ok);border-color:var(--ok)}
  .badge.daemon{color:var(--warn);border-color:var(--warn)} .badge.hook{color:var(--tool);border-color:var(--tool)}
  .badge.cache{color:var(--warn)} .save{color:var(--ok);margin-left:auto}
</style></head><body>
<header>
  <span><span class="dot" id="dot"></span><b id="hmodel">local LLM</b> <span style="color:var(--mut)">↔ vts</span> live</span>
  <span class="pill" id="proj">connecting…</span>
  <span class="pill" id="model"></span>
</header>
<div class="wrap">
  <main>
    <form id="f"><input type="text" id="q" placeholder="예: where is UGameInstance declared? / TakeDamage 호출처" autocomplete="off"><button id="go">Run</button></form>
    <div class="tabs">
      <button class="tab on" data-t="live">Live run</button>
      <button class="tab" data-t="act">Activity — 모든 qvts <span class="pill" id="actCount"></span></button>
    </div>
    <div id="log"></div>
    <div id="tree" style="display:none"></div>
  </main>
  <aside>
    <h3>run stats</h3>
    <div class="stat"><span>status</span><b id="st">idle</b></div>
    <div class="stat"><span>step</span><b id="step">–</b></div>
    <div class="stat"><span>tool calls</span><b id="tc">0</b></div>
    <div class="stat"><span>tok/s</span><b id="tps">–</b></div>
    <div class="stat"><span>elapsed</span><b id="ms">–</b></div>
    <h3>토큰 절약 (이번 실행)</h3>
    <div class="stat"><span title="Claude가 실제로 받는 양 = 로컬 모델 요약">A 위임 (이 방식)</span><b id="sa">–</b></div>
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
    <h3>all-time saved (ledger)</h3>
    <div class="stat"><span>delegations</span><b id="ld">0</b></div>
    <div class="stat"><span>saved vs vts</span><b id="lv" style="color:var(--ok)">0</b></div>
    <div class="stat"><span>saved vs grep</span><b id="lg" style="color:var(--ok)">0</b></div>
    <pre class="ps" id="lt">–</pre>
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
    if(ev.model)document.getElementById('hmodel').textContent=ev.model;
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
  else if(ev.type==='activity-changed'){loadActivity();}
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
// All-time persistent ledger (qvts CLI/daemon savings), refreshed periodically.
async function loadLedger(){try{const j=await (await fetch('/savings')).json();
  set('ld',fmt(j.delegations));
  set('lv',fmt(Math.max(0,(j.ccVtsTok||0)-(j.delegateTok||0))));
  set('lg',fmt(Math.max(0,(j.ccGrepTok||0)-(j.delegateTok||0))));
  const tools=Object.entries(j.byTool||{}).sort((a,b)=>(b[1].rawTok||0)-(a[1].rawTok||0));
  document.getElementById('lt').textContent=tools.length?tools.map(([t,v])=>t+': '+v.calls+' call(s)').join('\n'):'(no data yet)';
}catch{}}
loadLedger(); setInterval(loadLedger,5000);

// ---- Activity tab: project > kind > run hierarchy (every qvts unit of work, all entry points) ----
const tabs=document.querySelectorAll('.tab');
tabs.forEach(t=>t.addEventListener('click',()=>{
  tabs.forEach(x=>x.classList.remove('on'));t.classList.add('on');
  const act=t.dataset.t==='act';
  document.getElementById('tree').style.display=act?'block':'none';
  document.getElementById('log').style.display=act?'none':'block';
  if(act)loadActivity();
}));
const KIND_ICON={locate:'🧭',def_search:'🎯',digest:'📑',['digest-dir']:'📚',triage:'🩺',web:'🌐'};
const short=p=>{if(!p)return '(no project)';const s=p.replace(/[\\/]+$/,'').split(/[\\/]/);return s.slice(-2).join('/');};
function hhmmss(ts){try{return new Date(ts).toLocaleTimeString();}catch{return '';}}
function renderActivity(items){
  const tree=document.getElementById('tree');
  document.getElementById('actCount').textContent=items.length;
  if(!items.length){tree.innerHTML='<div class="pill" style="padding:10px">아직 활동 없음 — qvts가 (대시보드/CLI/위임/hook 어디서든) 일하면 여기 쌓입니다.</div>';return;}
  // group: project → kind → runs
  const byProj={};
  for(const a of items){const p=a.project||'(no project)';(byProj[p]=byProj[p]||{});const k=a.kind||'?';(byProj[p][k]=byProj[p][k]||[]).push(a);}
  // preserve open/closed state across refreshes
  const openState={};tree.querySelectorAll('details').forEach(d=>{if(d.dataset.key)openState[d.dataset.key]=d.open;});
  tree.innerHTML='';
  for(const p of Object.keys(byProj).sort()){
    const kinds=byProj[p];const pTot=Object.values(kinds).reduce((n,a)=>n+a.length,0);
    const pSave=Object.values(kinds).flat().reduce((n,a)=>n+((a.savings&&a.savings.savedVsGrep)||0),0);
    const pd=document.createElement('details');pd.className='grp';pd.dataset.key='p:'+p;pd.open=openState['p:'+p]!==false;
    const ps=document.createElement('summary');ps.innerHTML='<b>'+esc(short(p))+'</b> <span class="pill">'+pTot+' runs · ~'+fmt(pSave)+' tok saved</span>';
    pd.appendChild(ps);
    for(const k of Object.keys(kinds).sort()){
      const runs=kinds[k].slice().reverse();
      const kSave=runs.reduce((n,a)=>n+((a.savings&&a.savings.savedVsGrep)||0),0);
      const kd=document.createElement('details');kd.className='kind';kd.dataset.key='k:'+p+'/'+k;kd.open=!!openState['k:'+p+'/'+k];
      const ks=document.createElement('summary');ks.innerHTML=(KIND_ICON[k]||'•')+' '+esc(k)+' <span class="pill">'+runs.length+' · ~'+fmt(kSave)+' saved</span>';
      kd.appendChild(ks);
      const box=document.createElement('div');box.className='runs';
      for(const a of runs){
        const r=document.createElement('div');r.className='run';
        const via=a.via||'cli';const sg=(a.savings&&a.savings.savedVsGrep)||0;
        const top=document.createElement('div');top.className='top';
        top.innerHTML='<span>'+hhmmss(a.ts)+'</span>'
          +'<span class="badge '+via+'">'+via+'</span>'
          +(a.cached?'<span class="badge cache">cache</span>':'')
          +(a.ms!=null?'<span>'+(a.ms/1000).toFixed(1)+'s</span>':'')
          +(sg?'<span class="save">↓'+fmt(sg)+' tok</span>':'');
        const task=document.createElement('div');task.className='task';task.textContent=a.task||'';
        const res=document.createElement('div');res.className='res';res.textContent=(a.result||'').slice(0,300);
        r.appendChild(top);r.appendChild(task);if(a.result)r.appendChild(res);
        if(a.tools&&a.tools.length){const tl=document.createElement('div');tl.className='pill';tl.textContent=a.tools.join(' → ');r.appendChild(tl);}
        box.appendChild(r);
      }
      kd.appendChild(box);pd.appendChild(kd);
    }
    tree.appendChild(pd);
  }
}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
async function loadActivity(){try{const j=await (await fetch('/activity?limit=800')).json();renderActivity(j);}catch{}}
loadActivity();
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
  if (url === "/activity") {
    // The shared activity bus — every qvts unit of work (locate/def_search/digest/digest-dir/triage/web)
    // from the CLI, daemon, Read-hook, and this dashboard. Local read only. ?limit=N (default 800).
    const q = (req.url || "").split("?")[1] || "";
    const limit = Math.min(5000, Math.max(1, Number(new URLSearchParams(q).get("limit")) || 800));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(readActivity(limit)));
  }
  if (url === "/savings") {
    // cumulative token-savings ledger (~/.vts-local/savings.json) — local read only.
    const p = process.env.QVTS_SAVINGS_FILE || path.join(os.homedir(), ".vts-local", "savings.json");
    let led = { delegations: 0, delegateTok: 0, ccVtsTok: 0, ccGrepTok: 0, byTool: {} };
    try { led = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* none yet */ }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(led));
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.error(`\n  local-LLM↔vts dashboard:  http://${HOST}:${PORT}\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { agent?.close(); } catch { /* */ } process.exit(0); });
