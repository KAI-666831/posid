// ===== 雙機模式：一支「收銀機」按結帳 → 另一支「掃描機」自動開相機掃證件 =====
// 兩支輸入同一組配對碼。傳的只有「這組要掃幾位、買了什麼」，不傳證件資料；一樣加密後經 ntfy.sh 轉送。
const DUO_KEY = 'posid_duo';            // { role:'solo'|'pos'|'scan', code }
const DUO_OUT = 'posid_duo_out';        // 收銀機：還沒收到掃描機回覆的組（會自動重送）
const DUO_SEEN = 'posid_duo_seen';
const DUO_LAST = 'posid_duo_last';
const DUO_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

let duo = lsGet(DUO_KEY) || { role:'solo', code:'' };
let duoOut = lsGet(DUO_OUT) || [];
let duoSeen = new Set(lsGet(DUO_SEEN) || []);
let duoEs = null, duoAes = null, duoTopic = '', duoState = '', duoPeer = 0, duoHello = false, duoRetryT = null;

const duoRole = () => (duo.code && duo.role) || 'solo';
const duoFmt = c => c.slice(0, 4) + '-' + c.slice(4);
const duoNorm = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
function duoNewCode() { const r = crypto.getRandomValues(new Uint8Array(8)); return [...r].map(x => DUO_ABC[x % DUO_ABC.length]).join(''); }
function duoSave() { lsSet(DUO_KEY, duo); lsSet(DUO_OUT, duoOut); lsSet(DUO_SEEN, [...duoSeen].slice(-300)); }

async function duoConnect() {
  if (duoEs) { duoEs.close(); duoEs = null; }
  duoAes = null; duoState = ''; duoHello = false;
  if (duoRole() === 'solo') { duoRender(); return; }
  const enc = new TextEncoder();
  const k = await crypto.subtle.digest('SHA-256', enc.encode('posid-key:' + duo.code));
  const t = await crypto.subtle.digest('SHA-256', enc.encode('posid-topic:' + duo.code));
  duoAes = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
  duoTopic = 'posid-' + b64u(t).slice(0, 24);
  duoOpen();
}
function duoOpen() {
  if (!duoTopic || (duoEs && duoEs.readyState !== 2)) return;
  const last = lsGet(DUO_LAST);                 // 斷線期間的訊息也補收（ntfy 會暫存一段時間）
  duoEs = new EventSource(`${RELAY}/${duoTopic}/sse?since=${last || '10m'}`);
  duoEs.onopen = () => {
    duoState = 'open'; duoRender();
    if (!duoHello) { duoHello = true; duoSend('hello', {}).catch(() => {}); }
    duoFlush();
  };
  duoEs.onerror = () => { duoState = 'error'; duoRender(); if (duoEs && duoEs.readyState === 2) setTimeout(duoOpen, 3000); };
  duoEs.onmessage = async e => {
    try {
      const m = JSON.parse(e.data); if (m.event !== 'message' || !m.message) return;
      lsSet(DUO_LAST, m.id);
      const raw = unb64u(m.message);
      const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv: raw.slice(0, 12) }, duoAes, raw.slice(12));
      const msg = JSON.parse(new TextDecoder().decode(plain));
      if (msg.from === duoRole() || duoSeen.has(msg.mid)) return;
      duoSeen.add(msg.mid); duoSave();
      duoOnMsg(msg);
    } catch {}
  };
}
async function duoSend(kind, data) {
  if (!duoAes) throw new Error('還沒配對');
  const msg = { from: duoRole(), mid: rand(8), kind, data, ts: Date.now() };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, duoAes, new TextEncoder().encode(JSON.stringify(msg)));
  const body = new Uint8Array(12 + ct.byteLength); body.set(iv); body.set(new Uint8Array(ct), 12);
  const r = await fetch(`${RELAY}/${duoTopic}`, { method:'POST', body: b64u(body) });
  if (!r.ok) throw new Error('傳送失敗 ' + r.status);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && duoRole() !== 'solo') { duoOpen(); duoFlush(); duoWake(); } });
window.addEventListener('online', () => { duoOpen(); duoFlush(); });

// ---------- 收銀機 ----------
// 收銀頁結帳時呼叫；回傳 true 表示交給掃描機，這支不開相機
function duoCheckout(g) {
  if (duoRole() !== 'pos') return false;
  g.state = 'sent'; grpSave(); grpRender();
  duoOut.push({ id: g.id, no: g.no, day: g.day, want: g.want, desc: g.desc, total: g.total, later: g.later, ts: g.ts, sent: 0 });
  duoSave(); duoFlush(); duoRender();
  toast(`${grpLabel(g)} 已送到掃描機：${g.want} 位${g.later ? '（等一下一起掃）' : ''}`);
  return true;
}
async function duoFlush() {
  if (duoRole() !== 'pos' || !duoAes) return;
  clearTimeout(duoRetryT);
  // 沒收到掃描機回覆的，每 20 秒重送一次（掃描機會自動略過重複的）
  for (const g of duoOut) {
    if (g.ack || Date.now() - (g.sent || 0) < 20000) continue;
    try { const { sent, ack, ...data } = g; await duoSend('group', data); g.sent = Date.now(); }
    catch { break; }
  }
  duoSave(); duoRender();
  if (duoOut.some(g => !g.ack)) duoRetryT = setTimeout(duoFlush, 20000);
}

// ---------- 收到訊息 ----------
function duoOnMsg(m) {
  duoPeer = Date.now();
  const role = duoRole();
  if (role === 'scan' && m.kind === 'group') {
    const g = m.data;
    duoSend('ack', { id: g.id }).catch(() => {});
    if (grpById(g.id)) { duoRender(); return; }
    const ng = grpAdd(g);
    duoRender();
    if (ng.later) toast(`收到${grpLabel(ng)}：${ng.want} 位，等一下一起掃`);
    else if (!cont) { showTab('id'); grpStart('auto'); }
    else if (cont.grp) contTopUI();
    else toast(`收到${grpLabel(ng)}：${ng.want} 位，結束目前的掃描後開始`);
  }
  if (role === 'pos') {
    if (m.kind === 'ack' || m.kind === 'done') { const g = duoOut.find(x => x.id === m.data.id); if (g) g.ack = true; }
    if (m.kind === 'done') {
      const d = m.data, g = grpById(d.id);
      duoOut = duoOut.filter(x => x.id !== d.id);
      if (g) { g.state = 'done'; g.got = d.got; grpSave(); grpRender(); }
      const what = g ? grpLabel(g) + ' ' : '';
      toast(d.got >= d.want ? `✓ ${what}${d.want} 位證件掃好了` : `${what}證件只掃了 ${d.got} / ${d.want} 位`, d.got < d.want);
    }
    duoSave();
  }
  duoRender();
}

// ---------- 掃描機 ----------
async function duoWake() {
  if (duoRole() !== 'scan') return;
  try { navigator.wakeLock && await navigator.wakeLock.request('screen'); } catch {}
}

// ---------- 畫面（證件／名單頁最上面那張卡） ----------
function duoSetRole(r) {
  if (r === duoRole() && (r === 'solo' || duo.code)) return;
  if (r === 'scan' && duo.role !== 'scan') duo.code = '';
  if (r === 'pos') duo.code = duo.code || duoNewCode();
  duo.role = r; if (r === 'solo') duo.code = '';
  duoSave(); duoConnect(); duoRender(); duoWake();
}
function duoUnpair() { if (!confirm('解除配對？')) return; duo = { role:'scan', code:'' }; duoSave(); duoConnect(); }
function duoJoin() {
  const c = duoNorm($('duoCode').value);
  if (c.length !== 8) { toast('配對碼是 8 個字', true); return; }
  duo = { role:'scan', code:c }; lsSet(DUO_LAST, null); duoSave(); duoConnect(); duoWake();
  toast('已連線，等收銀機結帳');
}
function duoRender() {
  const el = $('duoBody'); if (!el) return;
  const role = duoRole(), pick = duo.role || 'solo';
  document.querySelectorAll('#duoRoles button').forEach(b => b.classList.toggle('on', b.dataset.r === pick));
  const ago = duoPeer ? Math.round((Date.now() - duoPeer) / 60000) : null;
  const st = duoState === 'open'
    ? `<span class="ok">● 已連線</span>${ago === null ? '' : `・對方 ${ago < 1 ? '剛剛' : ago + ' 分鐘前'}有回應`}`
    : duoState === 'error' ? '<span class="bad">● 網路中斷，重新連線中…</span>' : '連線中…';
  if (pick === 'solo') {
    el.innerHTML = '<div class="duo-tip">這支手機自己收銀、自己掃證件（結帳後直接開相機）。</div>';
  } else if (pick === 'pos') {
    const wait = duoOut.length;
    el.innerHTML = `<div class="duo-tip">這支是<b>收銀機</b>：結帳後不開相機，送到掃描機去掃。<br>在另一支手機選「掃描機」，輸入這組配對碼：</div>
      <div class="duo-code">${esc(duoFmt(duo.code))}</div>
      <div style="font-size:14px">${st}</div>
      ${wait ? `<div style="font-size:14px;margin-top:6px">掃描機還沒掃完：${duoOut.map(g => `第${g.no}組 ${g.want} 位${g.ack ? '' : '・傳送中'}`).join('、')}
        <a href="#" onclick="if(confirm('清掉等待中的組？（掃描機那邊不受影響）')){duoOut=[];duoSave();duoRender()};return false">清除</a></div>` : ''}
      <a href="#" style="font-size:13px" onclick="if(confirm('換一組新配對碼？掃描機要重新輸入。')){duo.code=duoNewCode();duoOut=[];duoSave();duoConnect()};return false">換新配對碼</a>`;
  } else if (!duo.code) {
    el.innerHTML = `<div class="duo-tip">這支是<b>掃描機</b>：輸入收銀機上顯示的配對碼。</div>
      <input id="duoCode" class="duo-in" placeholder="XXXX-XXXX" autocapitalize="characters" autocomplete="off">
      <button onclick="duoJoin()">連線</button>`;
  } else {
    el.innerHTML = `<div class="duo-tip">這支是<b>掃描機</b>（配對碼 ${esc(duoFmt(duo.code))}）。收銀機結帳後會自動開相機，螢幕請保持開著。</div>
      <div style="font-size:14px">${st}</div>
      <div style="margin-top:6px;color:var(--muted);font-size:14px">「馬上掃」的組會自動開相機；「等一下一起掃」的組在下面「今日各組」排隊。</div>
      <a href="#" style="font-size:13px;display:block;margin-top:6px" onclick="duoUnpair();return false">解除配對</a>`;
  }
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('#duoRoles button'); if (b) duoSetRole(b.dataset.r); });
setInterval(() => { if (duoRole() !== 'solo') duoRender(); }, 30000);
