// ===== 分組：收銀每結帳一次＝一組客人（買了什麼、要掃幾位、掃到誰）=====
// 可以「結帳馬上掃」，也可以「先結帳，證件等一下一起掃」（排隊，第1組、第2組…依序掃）
const GRP_KEY = 'posid_groups';
let groups = lsGet(GRP_KEY) || [];
const dayStr = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const grpLabel = g => `第${g.no}組`;
const grpById = id => groups.find(g => g.id === id);
function grpSave() {
  const cut = Date.now() - 14 * 864e5;            // 留兩週
  groups = groups.filter(g => g.ts > cut || g.state === 'wait');
  lsSet(GRP_KEY, groups);
}
function grpNewNo() { const d = dayStr(); return groups.filter(g => g.day === d).reduce((m, g) => Math.max(m, g.no || 0), 0) + 1; }
// d: { id, want, desc, total, later, no?, day?, ts? }
function grpAdd(d) {
  let g = grpById(d.id); if (g) return g;
  g = { id: d.id, no: d.no || grpNewNo(), day: d.day || dayStr(), ts: d.ts || Date.now(), want: d.want, desc: d.desc || '',
        total: d.total || 0, later: !!d.later, state: 'wait', got: 0 };
  groups.push(g); grpSave(); grpRender(); return g;
}
// 等著掃的組（舊的先）；mode 'auto'＝只接「馬上掃」的，'all'＝全部
const grpWaiting = mode => groups.filter(g => g.state === 'wait' && (mode === 'all' || !g.later)).sort((a, b) => a.ts - b.ts);

// 開始掃：g 指定一組（不接下一組）；不給 g 就照順序一組接一組
// 標成「掃描中」但其實沒在掃的（例如 app 被切走、相機沒開成）：放回待掃
function grpFix() {
  let ch = false;
  groups.forEach(g => { if (g.state === 'scan' && !(cont && cont.grp === g) && !contOpening) { g.state = 'wait'; ch = true; } });
  if (ch) lsSet(GRP_KEY, groups);
}
function grpStart(mode, g) {
  if (cont || contOpening) return;
  grpFix();
  g = g || grpWaiting(mode)[0]; if (!g) { toast('沒有待掃的組'); return; }
  g.state = 'scan'; grpSave();
  openContinuous(g, g && mode ? mode : null);
}
// 一組結束（掃滿，或手動結束）
function grpFinish(g, got, partial) {
  if (!g || g.state === 'done') return;
  g.state = 'done'; g.got = got; g.partial = !!partial; grpSave(); grpRender();
  if (typeof duoRole === 'function' && duoRole() === 'scan') duoSend('done', { id: g.id, got, want: g.want }).catch(() => {});
}
// 相機打不開等：放回待掃
function grpRequeue(g) { if (g && g.state === 'scan') { g.state = 'wait'; grpSave(); grpRender(); } }
// 掃滿：要接下一組就不關相機，直接換
function grpAdvance() {
  if (!cont || !cont.grp) return false;
  grpFinish(cont.grp, cont.got);
  if (!cont.chain) return false;
  const next = grpWaiting(cont.chain)[0]; if (!next) return false;
  next.state = 'scan'; grpSave();
  cont.grp = next; cont.got = next.got = 0; contTopUI();
  contUI(`✓ 上一組完成。換${grpLabel(next)}：${next.want} 位`, '#16a34a');
  return true;
}
// 掃到一位：存檔的紀錄標上是哪一組
function grpTag(r) { if (cont && cont.grp) r.grp = cont.grp.id; return r; }
function grpNames(g) { return load().filter(r => r.grp === g.id).map(r => primaryName(r) || primaryNo(r)); }

// 收銀刪掉那筆結帳（按錯）：這一組也刪掉。組號不重排（盒子裡的格子號碼才不會亂）
function grpVoid(id, fromPeer) {
  const g = grpById(id); if (!g) return;
  if (cont && cont.grp === g) { toast(`${grpLabel(g)} 正在掃，先結束掃描再刪`, true); return; }
  groups = groups.filter(x => x !== g); grpSave(); grpRender();
  const n = grpNames(g).length;
  toast(`${grpLabel(g)} 已刪除${n ? `（已掃的 ${n} 位還留在名單）` : ''}`);
  if (typeof duoRole === 'function' && !fromPeer) {
    if (duoRole() === 'pos') { duoOut = duoOut.filter(x => x.id !== id); duoSave(); duoSend('void', { id }).catch(() => {}); duoRender(); }
  }
}

// 手動刪一組（例如更新前留下的舊組）。只刪「組」，已掃的人留在名單；收銀的那筆結帳不受影響
function grpDelete(id) {
  const g = grpById(id); if (!g) return;
  if (!confirm(`刪除${grpLabel(g)}？\n（收銀那筆結帳不會刪；要連結帳一起刪，請到收銀「今日統計」刪那一筆）`)) return;
  grpVoid(id);
}
function grpClearAll() {
  if (cont) { toast('正在掃描，先結束再清除', true); return; }
  if (!confirm('清除「今日各組」全部的組？\n（名單裡已掃的人和收銀的結帳紀錄都不會刪）')) return;
  const ids = groups.map(g => g.id);
  groups = []; grpSave(); grpRender();
  if (typeof duoRole === 'function' && duoRole() === 'pos') { duoOut = []; duoSave(); ids.forEach(id => duoSend('void', { id }).catch(() => {})); duoRender(); }
  toast('已清除全部組');
}

// ---------- 畫面：今日各組 ----------
function grpRender() {
  const el = $('grpBody'); if (!el) return;
  grpFix();
  const pos = typeof duoRole === 'function' && duoRole() === 'pos';
  const d = dayStr(), today = groups.filter(g => g.day === d || g.state === 'wait').sort((a, b) => b.ts - a.ts);
  const wait = grpWaiting('all'), ppl = wait.reduce((s, g) => s + g.want - (g.got || 0), 0);
  const money = n => '$' + Number(n || 0).toLocaleString();
  el.innerHTML = (wait.length && !pos ? `<button onclick="grpStart('all')">📷 依序掃全部待掃 ${wait.length} 組（共 ${ppl} 位）</button>
      <div style="font-size:13px;color:var(--muted);margin:4px 0 6px">只想掃某一組：按那一組的「📷 掃這組」</div>` : '') +
    (today.length ? today.map(g => {
      const names = pos ? [] : grpNames(g);
      let st;
      const imp = pos ? '' : ` <button class="g-btn" onclick="batchStart('${g.id}')">🖼 相簿匯入</button>`;
      if (g.state === 'wait') st = `<span class="g-wait">待掃 ${g.got || 0}/${g.want}</span>${pos ? '' : ` <button class="g-btn" onclick="grpStart(null,grpById('${g.id}'))">📷 掃這組</button>`}${imp}`;
      else if (g.state === 'scan') st = `<span class="g-wait">掃描中</span>`;
      else if (g.state === 'sent') st = `<span class="g-wait">已送掃描機 · 0/${g.want}</span>`;
      else if (g.got >= g.want) st = `<span class="ok">✓ ${g.got}/${g.want}</span>`;
      else st = `<span class="bad">只掃 ${g.got}/${g.want}</span>${pos ? '' : ` <button class="g-btn" onclick="grpStart(null,grpById('${g.id}'))">📷 補掃</button>`}${imp}`;
      const skip = g.state === 'wait' && !pos ? ` <a href="#" style="font-size:13px;color:#9ca3af;margin-left:6px" onclick="if(confirm('${grpLabel(g)}不掃了？')){grpFinish(grpById('${g.id}'),grpById('${g.id}').got||0,true)};return false">略過</a>` : '';
      const delA = g.state === 'scan' ? '' : `<a href="#" class="g-del" onclick="grpDelete('${g.id}');return false">刪除</a>`;
      return `<div class="g-row"><div class="g-h"><b>${grpLabel(g)}</b>${g.day !== d ? `<small>${g.day.slice(5)}</small>` : ''}<span class="g-amt">${g.total ? money(g.total) : ''}</span>${delA}</div>
        <div class="g-items">${esc(g.desc)}</div>
        <div class="g-st">${st}${skip}${names.length ? '　' + names.map(esc).join('、') : ''}</div></div>`;
    }).join('') + `<a href="#" class="g-del" style="display:inline-block;margin-top:10px" onclick="grpClearAll();return false">清除全部組</a>`
    : '<div style="color:var(--muted);font-size:14px">今天還沒有結帳的組</div>');
  // 上方分頁列的「待掃」按鈕
  const q = $('qBtn');
  if (q) { q.style.display = wait.length && !pos ? '' : 'none'; q.textContent = `📷 待掃 ${wait.length}`; }
}
