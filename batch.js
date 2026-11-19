// ===== 相簿一次匯入多張：先用 iPhone 相機拍好，再一次選好幾張，背景依序辨識 =====
// 每張：先在整張照片上找文字 → 裁出證件那一塊 → 判斷證件種類 → 辨識 → 存檔（可指定算進哪一組）
let batch = null;   // { gid, items:[{ file, url, st:'wait'|'run'|'ok'|'dup'|'fail', msg }], running }

function batchStart(gid) {
  const g = gid ? grpById(gid) : null;
  if (g && g.state === 'done' && g.got < g.want) { g.state = 'wait'; grpSave(); }   // 補拍沒掃滿的組
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
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
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
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
  await runOcr(card, type === 'id' ? undefined : lines);
  let r = collectRecord(); r.sex = $('sex').value || inferSex(r);
  if (type === 'id' && !recordOk(r)) {                 // 身分證專用讀法要裁得很準；不準時改用文字標籤找
    const p = parseIdLines(lines);
    r = { ...r, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => v && !(k === 'idno' && validId(r.idno || '')))) };
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

// 身分證：用文字標籤找（照片沒裁準時的備案）
function parseIdLines(lines) {
  const r = {};
  const ids = findIds(lines); if (ids.length) r.idno = ids[0].v;
  for (const L of lines) {
    const m = L.t.replace(/\s/g, '').match(/民國(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
    if (m) { r.birth = `${+m[1]}/${pad2(m[2])}/${pad2(m[3])}`; break; }
  }
  const lbl = lines.find(L => /^姓名/.test(L.t.replace(/\s/g, '')));
  const clean = L => L.t.replace(/\s/g, '').replace(/^姓名/, '');
  let cand = lines.filter(L => /^[一-鿿]{2,4}$/.test(clean(L)) && !LABELS.test(clean(L)) && !/身分證|中華民國|出生|發證|性別|日期/.test(clean(L)));
  if (lbl) {
    const same = cand.filter(L => Math.abs(L.cy - lbl.cy) < (lbl.y1 - lbl.y0) * 1.2);
    if (same.length) cand = same;
  }
  const best = cand.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0))[0];   // 名字字最大
  if (best) r.name = clean(best);
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
