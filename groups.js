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
function grpStart(mode, g) {
  if (cont) return;
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
// 之前存過的老客人：把舊紀錄改成這一組
function grpTagExisting(r) {
  if (!cont || !cont.grp) return;
  const a = load(), no = primaryNo(r), nm = primaryName(r);
  const i = a.findIndex(x => no ? primaryNo(x) === no : (primaryName(x) === nm && (x.birth || '') === (r.birth || '')));
  if (i >= 0) { a[i].grp = cont.grp.id; store(a); }
}
function grpNames(g) { return load().filter(r => r.grp === g.id).map(r => primaryName(r) || primaryNo(r)); }

// ---------- 畫面：今日各組 ----------
function grpRender() {
  const el = $('grpBody'); if (!el) return;
  const pos = typeof duoRole === 'function' && duoRole() === 'pos';
  const d = dayStr(), today = groups.filter(g => g.day === d || g.state === 'wait').sort((a, b) => b.ts - a.ts);
  const wait = grpWaiting('all'), ppl = wait.reduce((s, g) => s + g.want - (g.got || 0), 0);
  const money = n => '$' + Number(n || 0).toLocaleString();
  el.innerHTML = (wait.length && !pos ? `<button onclick="grpStart('all')">📷 開始掃描待掃的 ${wait.length} 組（共 ${ppl} 位）</button>` : '') +
    (today.length ? today.map(g => {
      const names = pos ? [] : grpNames(g);
      let st;
      if (g.state === 'wait') st = `<span class="g-wait">待掃 ${g.got || 0}/${g.want}</span>`;
      else if (g.state === 'scan') st = `<span class="g-wait">掃描中</span>`;
      else if (g.state === 'sent') st = `<span class="g-wait">已送掃描機 · 0/${g.want}</span>`;
      else if (g.got >= g.want) st = `<span class="ok">✓ ${g.got}/${g.want}</span>`;
      else st = `<span class="bad">只掃 ${g.got}/${g.want}</span>${pos ? '' : ` <a href="#" onclick="grpStart(null,grpById('${g.id}'));return false">補掃</a>`}`;
      const skip = g.state === 'wait' && !pos ? ` <a href="#" style="font-size:13px" onclick="if(confirm('${grpLabel(g)}不掃了？')){grpFinish(grpById('${g.id}'),grpById('${g.id}').got||0,true)};return false">略過</a>` : '';
      return `<div class="g-row"><div class="g-h"><b>${grpLabel(g)}</b>${g.day !== d ? `<small>${g.day.slice(5)}</small>` : ''}<span class="g-amt">${g.total ? money(g.total) : ''}</span></div>
        <div class="g-items">${esc(g.desc)}</div>
        <div class="g-st">${st}${skip}${names.length ? '　' + names.map(esc).join('、') : ''}</div></div>`;
    }).join('') : '<div style="color:var(--muted);font-size:14px">今天還沒有結帳的組</div>');
  // 上方分頁列的「待掃」按鈕
  const q = $('qBtn');
  if (q) { q.style.display = wait.length && !pos ? '' : 'none'; q.textContent = `📷 待掃 ${wait.length}`; }
}
