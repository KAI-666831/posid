// ===== 相簿一次匯入多張：先用 iPhone 相機拍好，再一次選好幾張，背景依序辨識 =====
// 每張：先在整張照片上找文字 → 裁出證件那一塊 → 判斷證件種類 → 辨識 → 存檔（可指定算進哪一組）
let batch = null;   // { gid, items:[{ file, url, st:'wait'|'run'|'ok'|'dup'|'fail', msg }], running }

function batchStart(gid) {
  const g = gid ? grpById(gid) : null;
  if (g && g.state === 'done' && g.got < g.want) { g.state = 'wait'; grpSave(); }   // 補拍沒掃滿的組
  const inp = $('batchPick');
  inp.value = '';
  inp.onchange = () => {
    const files = [...inp.files]; if (!files.length) return;
    if (!batch || batch.gid !== (gid || null)) batch = { gid: gid || null, items: [], running: false };
    files.forEach(f => batch.items.push({ file: f, url: URL.createObjectURL(f), st: 'wait', msg: '排隊中' }));
    $('batch').style.display = 'block'; batchRender(); batchRun();
  };
  inp.click();
}
function batchClose() {
  if (batch && batch.running && !confirm('還在辨識，確定關掉？（還沒辨識的會取消）')) return;
  if (batch) { batch.items.forEach(it => URL.revokeObjectURL(it.url)); batch.cancel = true; }
  batch = null; $('batch').style.display = 'none'; render(); grpRender();
}
// 失敗的那張：直接開 iPhone 相機重拍
function batchRetake(i) {
  const inp = $('batchCam');
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f || !batch) return;
    const it = batch.items[i]; URL.revokeObjectURL(it.url);
    Object.assign(it, { file: f, url: URL.createObjectURL(f), st: 'wait', msg: '排隊中' });
    batchRender(); batchRun();
  };
  inp.click();
}

async function batchRun() {
  if (!batch || batch.running) return;
  batch.running = true;
  const b = batch;
  try {
    await loadModel(); await loadDet();
    let it;
    while (!b.cancel && (it = b.items.find(x => x.st === 'wait'))) {
      it.st = 'run'; it.msg = '辨識中…'; batchRender();
      try { await batchOne(it, b); } catch (e) { it.st = 'fail'; it.msg = '辨識失敗：' + e.message; }
      batchRender();
    }
  } catch (e) { toast('辨識引擎載入失敗：' + e.message, true); }
  b.running = false; batchRender();
  if (!b.cancel) render();
}

async function loadPhoto(file, maxSide = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
// 照片上的文字框 → 去掉離群的（旁邊其他紙張的字）→ 證件大概的範圍
function docBox(boxes, W, H) {
  boxes = boxes.filter(b => (b.x1 - b.x0) * W >= (b.y1 - b.y0) * H * 0.8);
  if (boxes.length < 3) return null;
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const cx = boxes.map(b => (b.x0 + b.x1) / 2), cy = boxes.map(b => (b.y0 + b.y1) / 2);
  const mx = med(cx), my = med(cy);
  const sx = med(cx.map(v => Math.abs(v - mx))) * 3 + 0.06, sy = med(cy.map(v => Math.abs(v - my))) * 3 + 0.06;
  const keep = boxes.filter((b, i) => Math.abs(cx[i] - mx) <= sx && Math.abs(cy[i] - my) <= sy);
  if (keep.length < 3) return null;
  let x0 = Math.min(...keep.map(b => b.x0)), x1 = Math.max(...keep.map(b => b.x1));
  let y0 = Math.min(...keep.map(b => b.y0)), y1 = Math.max(...keep.map(b => b.y1));
  const mw = (x1 - x0) * 0.06, mh = (y1 - y0) * 0.08;
  return { x0: Math.max(0, x0 - mw), y0: Math.max(0, y0 - mh), x1: Math.min(1, x1 + mw), y1: Math.min(1, y1 + mh) };
}

async function batchOne(it, b) {
  const photo = await loadPhoto(it.file);
  const box = docBox(await detectLines(photo), photo.width, photo.height);
  if (!box) { it.st = 'fail'; it.msg = '找不到證件上的字（太遠、太暗或反光）'; return; }
  const sw = (box.x1 - box.x0) * photo.width, sh = (box.y1 - box.y0) * photo.height;
  const card = document.createElement('canvas'); card.width = 1600; card.height = Math.round(1600 * sh / sw);
  card.getContext('2d').drawImage(photo, box.x0 * photo.width, box.y0 * photo.height, sw, sh, 0, 0, card.width, card.height);
  const lines = await readAllLines(card, (i, n) => { it.msg = `辨識中… ${i}/${n}`; batchRender(); });
  if (b.cancel) return;
  const type = guessType(lines) || 'id';
  setType(type);
  let r = null;
  if (type === 'id') {
    // 身分證：先用「姓名」「出生」標籤的位置推算整張卡的範圍，只看卡片裡面（旁邊紙上別人的資料不會混進來）
    let idLines = lines, idCard = card;
    const cb = idCardBox(lines, card.width, card.height);
    if (cb) {
      // 直接從原始照片裁（比較清楚；而且卡片可能有一部分在剛剛的範圍外面）
      const k = sw / card.width, px = box.x0 * photo.width + cb.x * k, py = box.y0 * photo.height + cb.y * k;
      idCard = document.createElement('canvas'); idCard.width = 1600; idCard.height = Math.round(1600 / CARD);
      const g2 = idCard.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, idCard.width, idCard.height);
      g2.drawImage(photo, px, py, cb.w * k, cb.h * k, 0, 0, idCard.width, idCard.height);
      const outside = cb.x < -0.03 * card.width || cb.y < -0.03 * card.height || cb.x + cb.w > card.width * 1.03 || cb.y + cb.h > card.height * 1.03;
      const nx = v => (v * card.width - cb.x) / cb.w, ny = v => (v * card.height - cb.y) / cb.h;
      // 推算的範圍不會剛剛好：放寬一點，但卡片外面一段距離的字（旁邊紙上的）不要
      idLines = lines.map(L => ({ ...L, x0: nx(L.x0), x1: nx(L.x1), y0: ny(L.y0), y1: ny(L.y1), cx: nx(L.cx), cy: ny(L.cy) }))
        .filter(L => L.cx > -0.04 && L.cx < 1.04 && L.cy > -0.06 && L.cy < 1.04);
      if (outside) idLines = await readAllLines(idCard, (i, n) => { it.msg = `辨識中（卡片）… ${i}/${n}`; batchRender(); });   // 卡片有一部分剛剛沒讀到：整張卡重讀
    }
    // 兩種讀法都跑（專用讀法＋文字標籤），對得上才算有把握；對不上的欄位標「請核對」
    const q = parseIdLines(idLines); delete q._byLabel;
    if (cb) { const nm = await refineIdName(idLines, idCard); if (nm) q.name = nm; }
    await runOcr(idCard);
    const pr = collectRecord();
    const un = new Set(lastUnsure);
    r = { ...pr };
    // 相簿照片：以「文字標籤」讀法為主（不怕照片裁得不準），專用讀法拿來核對
    for (const k of ['name', 'birth', 'idno']) {
      const a = (pr[k] || '').trim(), bq = (q[k] || '').trim();
      const okA = k === 'idno' ? validId(a) : k === 'birth' ? birthOk('id', a) : a.length >= 2;
      const okB = k === 'idno' ? validId(bq) : k === 'birth' ? birthOk('id', bq) : bq.length >= 2;
      if (okB) { r[k] = bq; if (!okA || a !== bq) un.add(k); else un.delete(k); }   // 兩種讀法一樣才算有把握
      else { r[k] = okA ? a : ''; un.add(k); }
    }
    if (r.birth) r.birthAd = rocToAd(r.birth).replace('西元 ', '');
    r.sex = $('sex').value || inferSex(r);
    if (!cb) ['name', 'birth', 'idno'].forEach(k => un.add(k));   // 找不到卡片範圍：全部標請核對
    lastUnsure = [...un];
  } else {
    await runOcr(card, lines);
    r = collectRecord(); r.sex = $('sex').value || inferSex(r);
  }
  if (!recordOk(r)) {
    it.st = 'fail';
    it.msg = `沒讀完整（${[!primaryName(r) && '姓名', !birthOk(r.type, r.birth) && '生日', !(validId(r.idno || '') || (EN_FIRST(r.type) && r.ppno)) && '號碼'].filter(Boolean).join('、')}）`;
    return;
  }
  const c = findConflict(r);
  const og = c && c.kind === 'dup' ? (() => { const o = load().find(x => primaryNo(r) ? primaryNo(x) === primaryNo(r) : primaryName(x) === primaryName(r)); return o && o.grp && grpById(o.grp); })() : null;
  if (c && c.kind === 'dup') { it.st = 'dup'; it.msg = `⚠ 重複：${primaryName(r)} 已經存過${og ? '（' + grpLabel(og) + '）' : ''}，這張不算`; return; }
  if (c) { it.st = 'fail'; it.msg = `⚠ ${c.msg}，沒存，請看實體證件`; return; }
  const g = b.gid ? grpById(b.gid) : null;
  const rec = { ...r, confirmed: false, unsure: lastUnsure.slice() };
  if (g) rec.grp = g.id;
  storeRecord(rec, lastCrop);
  clearFields(); $('cardView').style.display = 'none';
  it.st = 'ok'; it.msg = `${(rec.unsure || []).length ? '⚠ ' : '✓ '}${primaryName(r)}　${r.birth || ''}　${primaryNo(r)}`;
  if (g) {
    g.got = (g.got || 0) + 1; grpSave();
    if (g.got >= g.want && g.state !== 'done') grpFinish(g, g.got);
  }
}

// 用「姓名」「出生」「發證日期」標籤的位置推算身分證整張卡的範圍（像素）
// 實際身分證：姓名列在卡片高度 49%、出生 67%、發證日期 81%，「姓」字左緣在卡片寬度 6%
function idCardBox(lines, cw, ch) {
  const tt = L => L.t.replace(/\s/g, '');
  const nl = lines.find(L => /^姓/.test(tt(L)) && L.x0 < 0.4);
  if (!nl) return null;
  const left = L => Math.abs(L.x0 - nl.x0) < 0.08;
  const bl = lines.find(L => L !== nl && L.cy > nl.cy && left(L) && /^出|年月日/.test(tt(L)));
  const il = lines.find(L => L !== nl && L.cy > nl.cy && left(L) && /發證|日期/.test(tt(L)));
  const est = [];
  if (bl) est.push((bl.cy - nl.cy) * ch / 0.18);
  if (il) est.push((il.cy - nl.cy) * ch / 0.32);
  if (!est.length) return null;
  const Hc = est.reduce((a, b) => a + b) / est.length;
  if (Hc < ch * 0.15) return null;
  const Wc = Hc * CARD;
  return { x: nl.x0 * cw - 0.06 * Wc, y: nl.cy * ch - 0.49 * Hc, w: Wc, h: Hc };
}

// 身分證的名字：每個字固定間距排開（約卡片寬 17%），中間的底紋常被讀成多一個字（例如「徐余啓彰」），
// 很細的字（例如「一」）又常漏掉。照固定間距對格子：不在格子上的丟掉，格子上沒讀到的單獨再讀一次。
async function refineIdName(lines, img) {
  const tt = L => L.t.replace(/\s/g, '');
  const lbl = lines.find(L => /^姓/.test(tt(L)) && L.x0 < 0.3); if (!lbl) return null;
  const h = lbl.y1 - lbl.y0;
  const row = lines.filter(L => Math.abs(L.cy - lbl.cy) < h * 1.3 && L.x1 > lbl.x0 && L.cx < 0.74);
  // 整條名字列一次讀，模型會給每個字的精確橫向位置
  // 只取名字那一列的高度（不要碰到下一列生日的「年」「月」）
  const core = row.filter(L => Math.abs(L.cy - lbl.cy) < h * 0.6);
  const by0 = Math.min(...core.map(L => L.y0)), by1 = Math.max(...core.map(L => L.y1));
  const bx0 = Math.max(lbl.x0, 0), bx1 = 0.8;   // 第三個字常在卡片寬 60～75% 的地方
  const cs = await recRegion(img, bx0, by0, bx1, by1, true);
  let cands = cs.filter(c => /[一-鿿]/.test(c.ch)).map(c => ({ c: c.ch, cx: bx0 + c.x * (bx1 - bx0), p: c.p }));
  // 去掉「姓」「名」標籤字
  const li = cands.map(c => c.c).lastIndexOf('名');
  if (li >= 0 && li <= 1) cands = cands.slice(li + 1);
  else {
    while (cands.length && /[姓名]/.test(cands[0].c)) cands.shift();
    // 沒讀到「名」：標籤那一塊如果只有「姓名」兩個字，名字從它右邊開始；標籤跟姓黏在一起時不能用它的右緣（會把姓切掉）
    if (/^姓名?$/.test(tt(lbl))) cands = cands.filter(c => c.cx > lbl.x1 - 0.01);
  }
  if (!cands.length) return null;
  const c1 = cands[0].cx;
  let best = null;
  for (let p = 0.13; p <= 0.215; p += 0.005) {
    let on = 0, off = 0;
    let err = 0;
    for (const c of cands) { const k = (c.cx - c1) / p, d = Math.abs(k - Math.round(k)); if (Math.round(k) <= 3 && d < 0.3) { on++; err += d; } else off++; }
    const sc = on - off * 0.6 - err - Math.abs(p - 0.17) * (8 / cands.length);   // 字少時比較相信實際卡片的間距
    if (!best || sc > best.sc) best = { p, sc };
  }
  // 用對上格子的字再微調一次間距
  const fit = cands.map(c => [c, Math.round((c.cx - c1) / best.p)]).filter(([c, k]) => k >= 1 && k <= 3 && Math.abs((c.cx - c1) / best.p - k) < 0.3);
  const p = Math.min(0.2, Math.max(0.145, fit.length >= 2 ? fit.reduce((s, [c, k]) => s + (c.cx - c1) / k, 0) / fit.length : best.p));
  const y0 = by0, y1 = by1;
  const cw = (y1 - y0) / CARD;   // 字寬（以卡片寬為單位，字差不多是正方形）
  let name = '';
  for (let k = 0; k <= 3; k++) {
    const sx = c1 + k * p; if (sx > 0.78) break;
    const hit = cands.filter(c => Math.abs(c.cx - sx) < p * 0.3).sort((a, b) => Math.abs(a.cx - sx) - Math.abs(b.cx - sx))[0];
    let ch = hit && (k < 3 || (hit.p || 0) > 0.9) ? hit.c : '';   // 第 4 個字（複姓）要很有把握才算，不然常是照片、防偽圖案
    if (!ch && img && k <= 2 && !cands.some(c => Math.abs(c.cx - sx) < p * 0.6)) {   // 第 4 格不補讀（會讀到照片）   // 這一格附近完全沒讀到字：單獨裁這一格再讀
      const t = await recRegion(img, sx - cw * 0.7, y0, sx + cw * 0.7, y1);
      const m = (t || '').match(/[一-鿿]/);
      if (m && (recRegion.lastMinP || 0) > 0.5) ch = m[0];
    }
    if (!ch) break;                                     // 名字是連續的格子，空一格就結束
    name += ch;
  }
  return /^[一-鿿]{2,4}$/.test(name) && !LABELS.test(name) ? name : null;
}

// 身分證：用文字標籤找（跟專用讀法互相核對）
function parseIdLines(lines) {
  const r = {};
  // 證號：可能拍到旁邊紙上別人的號碼 → 取最靠右下的（身分證的號碼在右下角）
  const inZone = L => L.cx > 0.5 && L.cx < 1.05 && L.cy > 0.68 && L.cy < 1.0;   // 身分證號碼在右下角
  const ids = findIds(lines).sort((a, b) => (inZone(b.L) - inZone(a.L)) || ((b.L.cx + b.L.cy) - (a.L.cx + a.L.cy)));
  if (ids.length) r.idno = ids[0].v;
  // 生日：「民國 84 年 10 月 27 日」，「年」被反光蓋掉也要能讀；排除發證日期那一行；有好幾個取最早的
  const bs = [];
  const bLbl = lines.find(L => /^出|年月日/.test(L.t.replace(/\s/g, '')) && L.x0 < 0.3);
  for (const L of lines) {
    const t = L.t.replace(/\s/g, '');
    if (/發證|補發|換發|初發|[(（](.{1,3})[)）]/.test(t)) continue;
    const m = t.match(/民國?(\d{2,3})[^\d]{0,3}(\d{1,2})月(\d{1,2})日?/) || t.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日?$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) bs.push([+m[1], `${+m[1]}/${pad2(m[2])}/${pad2(m[3])}`, L]);
  }
  // 跟「出生年月日」標籤同一列的優先（旁邊紙上的日期不要），沒有標籤才取最早的
  const rowD = L => bLbl ? Math.abs(L.cy - bLbl.cy) / Math.max(0.01, bLbl.y1 - bLbl.y0) : 0;
  bs.sort((a, b) => (rowD(a[2]) < 1.2) !== (rowD(b[2]) < 1.2) ? (rowD(a[2]) < 1.2 ? -1 : 1) : a[0] - b[0]);
  if (bs.length) r.birth = bs[0][1];
  // 姓名：「姓 名」標籤（可能被切成「姓」「名」兩塊，或跟名字黏在一起）同一列右邊的中文接起來
  const tt = L => L.t.replace(/\s/g, '');
  const lbl = lines.find(L => /^姓/.test(tt(L)) && L.x0 < 0.25);
  if (lbl) {
    const h = lbl.y1 - lbl.y0;
    const row = [lbl, ...lines.filter(L => L !== lbl && Math.abs(L.cy - lbl.cy) < h * 1.2 && L.x0 > lbl.x0 && L.x0 < 0.68)]
      .sort((a, b) => a.x0 - b.x0).map(L => tt(L).replace(/[^一-鿿]/g, '')).join('').replace(/^姓名?|^名/, '').replace(/^名/, '');
    if (/^[一-鿿]{2,4}$/.test(row) && !LABELS.test(row)) { r.name = row; r._byLabel = true; }
  }
  return r;
}

function batchRender() {
  const el = $('batch'); if (!el || !batch) return;
  const g = batch.gid ? grpById(batch.gid) : null;
  const done = batch.items.filter(x => x.st === 'ok').length, n = batch.items.length;
  const icon = { wait:'⏳', run:'🔍', ok:'', dup:'', fail:'✗' };
  el.innerHTML = `<div class="b-top"><b>${g ? grpLabel(g) + '　' + esc(g.desc) : '相簿匯入（不分組）'}</b>
      <div>${g ? `本組 ${g.got || 0} / ${g.want} 位・` : ''}這次 ${n} 張：成功 ${done}${batch.running ? '，辨識中…' : ''}</div></div>
    <div class="b-list">${batch.items.map((it, i) => `<div class="b-row ${it.st}">
      <img src="${it.url}" alt="">
      <div class="b-msg">${icon[it.st] || ''} ${esc(it.msg)}
        ${it.st === 'fail' || it.st === 'dup' ? `<div><button class="g-btn" onclick="batchRetake(${i})">📷 重拍這張</button></div>` : ''}</div></div>`).join('')}</div>
    <div class="b-bot"><button class="sec" onclick="batchStart(${batch.gid ? `'${batch.gid}'` : 'null'})">＋ 再加照片</button><button onclick="batchClose()">完成</button></div>`;
}
