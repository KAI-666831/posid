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

// 居留證正面有 ⚠：拍背面，讀完會更正那一筆（新增一列顯示結果）
function batchFlip(i) {
  const inp = $('batchCam');
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f || !batch) return;
    batch.items.push({ file: f, url: URL.createObjectURL(f), st: 'wait', msg: '排隊中（背面）', flipRid: batch.items[i].rid });
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
  // 中心用「依字的大小加權」的中位數：後面別張證件的字小又碎，不會把中心拉過去；越靠照片中間權重越大
  const wt = boxes.map((b, i) => (b.x1 - b.x0) * (b.y1 - b.y0) * (1.2 - Math.hypot(cx[i] - 0.5, cy[i] - 0.5)));
  const wmed = a => { const o = a.map((v, i) => [v, wt[i]]).sort((x, y) => x[0] - y[0]); const tot = wt.reduce((x, y) => x + y, 0); let acc = 0; for (const [v, w] of o) { acc += w; if (acc >= tot / 2) return v; } return o[o.length - 1][0]; };
  const mx = wmed(cx), my = wmed(cy);
  const sx = med(cx.map(v => Math.abs(v - mx))) * 3 + 0.06, sy = med(cy.map(v => Math.abs(v - my))) * 3 + 0.06;
  const keep = boxes.filter((b, i) => Math.abs(cx[i] - mx) <= sx && Math.abs(cy[i] - my) <= sy);
  if (keep.length < 3) return null;
  let x0 = Math.min(...keep.map(b => b.x0)), x1 = Math.max(...keep.map(b => b.x1));
  let y0 = Math.min(...keep.map(b => b.y0)), y1 = Math.max(...keep.map(b => b.y1));
  const mw = (x1 - x0) * 0.06, mh = (y1 - y0) * 0.08;
  return { x0: Math.max(0, x0 - mw), y0: Math.max(0, y0 - mh), x1: Math.min(1, x1 + mw), y1: Math.min(1, y1 + mh) };
}

function rotCanvas(img, deg) {
  const c = document.createElement('canvas'), r = deg % 180 !== 0;
  c.width = r ? img.height : img.width; c.height = r ? img.width : img.height;
  const g = c.getContext('2d'); g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(img, -img.width / 2, -img.height / 2);
  return c;
}
async function batchOne(it, b, rot) {
  let photo = await loadPhoto(it.file);
  let boxes = await detectLines(photo);
  // 證件直放拍（字是直的）：直的框比橫的多 → 轉 90 度再讀
  if (rot === undefined) {
    const tall = boxes.filter(q => (q.y1 - q.y0) * photo.height > (q.x1 - q.x0) * photo.width * 1.5).length;
    const wide = boxes.filter(q => (q.x1 - q.x0) * photo.width > (q.y1 - q.y0) * photo.height * 1.5).length;
    rot = tall > wide && tall >= 4 ? 90 : 0;
  }
  if (rot) { photo = rotCanvas(photo, rot); boxes = await detectLines(photo); }
  const box = docBox(boxes, photo.width, photo.height);
  const logFail = async (msg, r, ls) => dbgSave({ kind: 'fail', img: await smallPhoto(photo), msg, got: dbgPick(r), ocr: ocrText(ls) });
  if (!box) { it.st = 'fail'; it.msg = '找不到證件上的字（太遠、太暗或反光）'; await logFail(it.msg, {}, []); return; }
  const sw = (box.x1 - box.x0) * photo.width, sh = (box.y1 - box.y0) * photo.height;
  const card = document.createElement('canvas'); card.width = 1600; card.height = Math.round(1600 * sh / sw);
  card.getContext('2d').drawImage(photo, box.x0 * photo.width, box.y0 * photo.height, sw, sh, 0, 0, card.width, card.height);
  const lines = await readAllLines(card, (i, n) => { it.msg = `辨識中… ${i}/${n}`; batchRender(); });
  if (b.cancel) return;
  // 轉了 90 度還認不出是什麼證件：可能轉反了，換另一個方向
  if (rot === 90 && !guessType(lines)) return batchOne(it, b, 270);
  const type = guessType(lines) || 'id';
  setType(type);
  let r = null;
  if (type === 'id') {
    // 身分證：先用「姓名」「出生」標籤的位置推算整張卡的範圍，只看卡片裡面（旁邊紙上別人的資料不會混進來）
    let idLines = lines, idCard = card, cbP = null;
    const cb = idCardBox(lines, card.width, card.height);
    if (cb) {
      // 直接從原始照片裁（比較清楚；而且卡片可能有一部分在剛剛的範圍外面）
      const k = sw / card.width, px = box.x0 * photo.width + cb.x * k, py = box.y0 * photo.height + cb.y * k;
      cbP = { x: px, y: py, w: cb.w * k, h: cb.h * k };
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
    if (q.name) q.name = toTrad(q.name);
    await runOcr(idCard);
    const pr = collectRecord();
    const un = new Set(lastUnsure);
    r = { ...pr };
    // 相簿照片：以「文字標籤」讀法為主（不怕照片裁得不準），專用讀法拿來核對
    for (const k of ['name', 'birth', 'idno']) {
      const a = (pr[k] || '').trim(), bq = (q[k] || '').trim();
      const okA = k === 'idno' ? validId(a) : k === 'birth' ? birthOk('id', a) : a.length >= 2;
      const okB = k === 'idno' ? validId(bq) : k === 'birth' ? birthOk('id', bq) : bq.length >= 2;
      // 兩種讀法讀到「不一樣」才標請核對；只有一種讀到（另一種沒讀到）時：號碼有檢查碼、生日有對齊標籤，不標；名字還是標
      if (okA && okB) { r[k] = bq; if (a !== bq) un.add(k); else un.delete(k); }
      else if (okA || okB) { r[k] = okB ? bq : a; if (k === 'name') un.add(k); else un.delete(k); }
      else { r[k] = ''; un.add(k); }
    }
    // 兩種讀法都沒讀到號碼：在整張照片的字裡找「姓名」右下方、最靠右下角的（標請核對）
    if (!validId(r.idno || '')) {
      const nl = lines.find(L => /^姓/.test(L.t.replace(/\s/g, '')) && L.x0 < 0.5);
      const c2 = findIds(lines).filter(x => !nl || (x.L.cy > nl.cy && x.L.cx > nl.cx)).sort((a, b) => (b.L.cx + b.L.cy) - (a.L.cx + a.L.cy))[0];
      if (c2) { r.idno = c2.v; un.add('idno'); }
      else {
        // 讀到像號碼的字但檢查碼不對（有一個字讀錯）：用模型的「第二選擇」逐字試，剛好只有一種改法對得上才用（標請核對）
        const shaped = lines.filter(L => /[A-Z][12A-D89]\d{8}/.test(L.t.replace(/\s/g, '').toUpperCase()) && (!nl || (L.cy > nl.cy && L.cx > nl.cx)));
        for (const L of shaped) { const v = await fixIdByAlt(card, L); if (v) { r.idno = v; un.add('idno'); break; } }
      }
    }
    // 還是沒有：直接讀卡片右下角號碼的位置（反光時偵測常漏掉這一塊）
    if (!validId(r.idno || '')) {
      // 推算的卡片範圍裡試幾個高度；再用「發證日期」那一列的高度，在裁切照片的右半邊找
      // 卡片範圍推算可能偏小：從原始照片裁「卡片右下角再往右多一點」
      const zone = (fx0, fy0, fx1, fy1) => {
        const x0 = Math.max(0, cbP.x + fx0 * cbP.w), y0 = Math.max(0, cbP.y + fy0 * cbP.h), x1 = Math.min(photo.width, cbP.x + fx1 * cbP.w), y1 = Math.min(photo.height, cbP.y + fy1 * cbP.h);
        const c = document.createElement('canvas'); c.width = Math.max(16, Math.round(x1 - x0)); c.height = Math.max(8, Math.round(y1 - y0));
        c.getContext('2d').drawImage(photo, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height); return c;
      };
      const tries = cbP ? [[0.82, 0.97], [0.78, 0.93], [0.86, 1.02], [0.80, 1.0]].map(([a, b2]) => [zone(0.62, a, 1.15, b2), 0, 0, 1, 1]) : [];
      const il = lines.find(L => /發證|发证|日期/.test(L.t.replace(/\s/g, '')) && L.x0 < 0.4);
      if (il) { const h = il.y1 - il.y0; tries.push([card, 0.58, il.y0 - h * 0.4, 1.0, il.y1 + h * 0.5], [card, 0.58, il.y0 - h, 1.0, il.y1], [card, 0.58, il.y0, 1.0, il.y1 + h]); }
      for (const [img, x0, y0, x1, y1] of tries) {
        const s = (await recRegion(img, x0, y0, x1, y1)).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const m = s.match(/[A-Z][12]\d{8}/);
        if (m && validId(m[0])) { r.idno = m[0]; un.add('idno'); break; }
      }
    }
    // 生日被拆成好幾段（「民國」「84」「10月27日」）：把出生那一列的字接起來再找
    if (!birthOk('id', r.birth)) {
      const bl = idLines.find(L => /^出|年月日/.test(L.t.replace(/\s/g, '')) && L.x0 < 0.3);
      if (bl) {
        const row = idLines.filter(L => L !== bl && L.x0 > bl.x1 - 0.02 && L.cx < 0.66 && L.y0 < bl.y1 + 0.03 && L.y1 > bl.y0 - 0.06).sort((a, b) => a.x0 - b.x0);
        const t = row.map(L => L.t).join('').replace(/\s/g, '');
        // 「年」被讀掉時「8410月」分不出來：年份試 2 位和 3 位，取合理的
        for (const yl of [2, 3]) {
          const m = t.match(new RegExp(`民[國国]?(\\d{${yl}})\\D{0,3}(\\d{1,2})月(\\d{1,2})`));
          const v = m && `${+m[1]}/${pad2(m[2])}/${pad2(m[3])}`;
          if (v && +m[2] >= 1 && +m[2] <= 12 && birthOk('id', v)) { r.birth = v; un.add('birth'); break; }
        }
      }
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
    // 號碼貼著照片邊緣、只讀到 7～9 碼：是被切到了
    if (!validId(r.idno || '') && lines.some(L => /^[A-Z][12]\d{5,7}$/.test(L.t.replace(/\s/g, '')) && (L.x1 > 0.93 || L.y1 > 0.97))) it.msg += '：號碼在照片邊緣被切到，請整張拍進去';
    else if (lines.some(L => ARC_BACK.test(L.t))) it.msg += '：居留證背面，請拍近一點，讓卡片佔滿大半個畫面、下面三行英數字清楚';
    else if (!box || (box.x1 - box.x0) * (box.y1 - box.y0) < 0.12) it.msg += '：證件在照片裡太小，請拍近一點';
    await logFail(it.msg, r, lines);
    return;
  }
  if (lastParse._back) {
    // 居留證背面：這個人剛剛用正面存過 → 更正那一筆，不另外存
    const m = arcBackMerge(r, it.flipRid);
    if (m) {
      const mk = m.unsure.length ? '⚠' : '✓';
      it.st = 'ok'; it.msg = `${mk} 已用背面更正：${primaryName(m)}　${m.birth || ''}　${shownNo(m)}`;
      const o = b.items.find(x => x.rid === m.rid && x !== it); if (o) { o.flip = false; o.msg = `${mk} ${primaryName(m)}　${m.birth || ''}　${shownNo(m)}（已用背面更正）`; }
      clearFields(); $('cardView').style.display = 'none'; return;
    }
  }
  const c = findConflict(r);
  const og = c && c.kind === 'dup' ? (() => { const o = load().find(x => primaryNo(r) ? primaryNo(x) === primaryNo(r) : primaryName(x) === primaryName(r)); return o && o.grp && grpById(o.grp); })() : null;
  if (c && c.kind === 'dup') { it.st = 'dup'; it.msg = `⚠ 重複：${primaryName(r)} 已經存過${og ? '（' + grpLabel(og) + '）' : ''}，這張不算`; return; }
  if (c) { it.st = 'fail'; it.msg = `⚠ ${c.msg}，沒存，請看實體證件`; await logFail(it.msg, r, lines); return; }
  const g = b.gid ? grpById(b.gid) : null;
  const rec = { ...r, confirmed: false, unsure: lastUnsure.slice(), mrz: !!lastParse._back };
  if (g) rec.grp = g.id;
  const rid = storeRecord(rec, lastCrop);
  dbgSave({ kind: 'pending', rid, img: await smallPhoto(photo, dbgAllOn() ? 1400 : 1600), got: dbgPick(rec), unsure: rec.unsure, ocr: ocrText(lines) });   // 之後在核對畫面改了才會變成「修正」紀錄
  clearFields(); $('cardView').style.display = 'none';
  it.st = 'ok'; it.msg = `${(rec.unsure || []).length ? '⚠ ' : '✓ '}${primaryName(r)}　${r.birth || ''}　${shownNo(r)}`;
  it.rid = rid; it.flip = r.type === 'arc' && !lastParse._back && (rec.unsure || []).length > 0;   // 居留證正面有 ⚠：可以補拍背面更正
  if (g) {
    g.got = (g.got || 0) + 1; grpSave();
    if (g.got >= g.want && g.state !== 'done') grpFinish(g, g.got);
  }
}

// 號碼檢查碼不對：重讀那一條，看每個字模型的第二選擇；只有「剛好一種」單字改法能過檢查碼才採用
async function fixIdByAlt(img, L) {
  const W = img.width, H = img.height;
  const x0 = Math.max(0, L.x0 - 0.01), x1 = Math.min(1, L.x1 + 0.01), y0 = Math.max(0, L.y0 - 0.005), y1 = Math.min(1, L.y1 + 0.005);
  const sw = (x1 - x0) * W, sh = (y1 - y0) * H, h = 48, w = Math.max(16, Math.round(sw * h / sh));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x0 * W, y0 * H, sw, sh, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data, n = h * w, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 127.5 - 1; f[n + i] = px[i * 4 + 1] / 127.5 - 1; f[2 * n + i] = px[i * 4 + 2] / 127.5 - 1; }
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, h, w]) });
  const o = out[sess.outputNames[0]], [, T, C] = o.dims, d = o.data;
  const chars = []; let prev = -1;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -Infinity;
    for (let k = 0; k < C; k++) { const v = d[t * C + k]; if (v > bv) { bi = k; bv = v; } }
    if (bi !== 0) {
      const ch = (dict[bi] || '').trim().toUpperCase();
      if (bi !== prev && ch) chars.push({ ch, p: bv, alt: {} });
      const cur = chars[chars.length - 1];
      if (cur) for (let k = 1; k < C; k++) {     // 這個字的其他候選（不算空白、不算自己）
        if (k === bi) continue; const v = d[t * C + k]; if (v < 0.005) continue;
        const a = (dict[k] || '').trim().toUpperCase(); if (a && a !== cur.ch) cur.alt[a] = Math.max(cur.alt[a] || 0, v);
      }
    }
    prev = bi;
  }
  const s = chars.map(c => c.ch).join('');
  const m = s.match(/[A-Z][0-9]{9}/); if (!m) return null;
  if (validId(m[0])) return m[0];
  const base = chars.slice(m.index, m.index + 10), fixes = [];
  base.forEach((c, i) => Object.entries(c.alt).forEach(([a, pa]) => {
    if (i === 0 ? !/[A-Z]/.test(a) : !/[0-9]/.test(a)) return;
    const v = base.map((x, j) => j === i ? a : x.ch).join('');
    if (validId(v)) fixes.push([v, pa / c.p]);
  }));
  fixes.sort((a, b) => b[1] - a[1]);
  // 只有一種改法，或第一名比第二名有把握 3 倍以上才用；不然寧可請你重拍
  return fixes.length && (fixes.length === 1 || fixes[0][1] > fixes[1][1] * 3) ? fixes[0][0] : null;
}

// 用「姓名」「出生」「發證日期」標籤的位置推算身分證整張卡的範圍（像素）
// 實際量真的身分證：姓名列在卡片高度 50%、出生 71%、發證日期 90%，「姓」字左緣在卡片寬度 1.5%
function idCardBox(lines, cw, ch) {
  const tt = L => L.t.replace(/\s/g, '');
  const nl = lines.find(L => /^姓/.test(tt(L)) && L.x0 < 0.4);
  if (!nl) return null;
  const left = L => Math.abs(L.x0 - nl.x0) < 0.08;
  // 「出 生／年月日」可能分成兩行：取兩行合起來的中心
  const bls = lines.filter(L => L !== nl && L.cy > nl.cy && L.cy < nl.cy + 0.5 && left(L) && /^出|年月日|^生/.test(tt(L)));
  const bcy = bls.length ? (Math.min(...bls.map(L => L.y0)) + Math.max(...bls.map(L => L.y1))) / 2 : 0;
  const il = lines.find(L => L !== nl && L.cy > nl.cy && left(L) && /發證|发证|日期/.test(tt(L)));
  const est = [];
  if (bcy) est.push((bcy - nl.cy) * ch / 0.21);
  if (il) est.push((il.cy - nl.cy) * ch / 0.40);
  if (!est.length) return null;
  const Hc = est.reduce((a, b) => a + b) / est.length;
  if (Hc < ch * 0.15) return null;
  const Wc = Hc * CARD;
  return { x: nl.x0 * cw - 0.015 * Wc, y: nl.cy * ch - 0.50 * Hc, w: Wc, h: Hc };
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
  cands = cands.filter(c => c.cx > 0.13);   // 卡片寬 13% 以左是「姓 名」標籤（「名」常被讀錯成「石」之類）
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
    if (/發證|发证|補|补|換|换|初發|初发|[市縣县]|[(（](.{1,3})[)）]/.test(t)) continue;   // 發證日期那一行（有「換發」「高市」）
    const m = t.match(/民[國国]?(\d{2,3})[^\d]{0,3}(\d{1,2})月(\d{1,2})日?/) || t.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日?$/);
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
        ${it.st === 'fail' || it.st === 'dup' ? `<div><button class="g-btn" onclick="batchRetake(${i})">📷 重拍這張</button></div>` : ''}
        ${it.flip ? `<div><button class="g-btn" onclick="batchFlip(${i})">📷 補拍背面</button></div>` : ''}</div></div>`).join('')}</div>
    <div class="b-bot"><button class="sec" onclick="batchStart(${batch.gid ? `'${batch.gid}'` : 'null'})">＋ 再加照片</button><button onclick="batchClose()">完成</button></div>`;
}
