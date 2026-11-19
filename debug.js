// ===== 除錯紀錄：相簿匯入辨識失敗、人工改過的資料 → 保存照片＋辨識原文，匯出 ZIP 傳給開發者 =====
// 只存在這支手機；裡面有客人的證件照片，傳完請按「清除」
const DBG_DB = 'posid-debug', DBG_KEEP = 80;
function dbgDb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DBG_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('d', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function dbgTx(mode, fn) {
  const db = await dbgDb();
  return new Promise((ok, no) => { const t = db.transaction('d', mode); const req = fn(t.objectStore('d')); t.oncomplete = () => ok(req && req.result); t.onerror = () => no(t.error); });
}
const dbgAll = () => dbgTx('readonly', st => st.getAll()).catch(() => []);
const DBG_VER = () => { const m = (document.querySelector('.sub span') || {}).textContent || ''; return m.replace(/.*版本\s*/, ''); };
const canvasBlob = (c, q = 0.85) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
async function smallPhoto(canvas, max = 1600) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return canvasBlob(c);
}
const dbgPick = r => { const o = {}; ['type', 'name', 'nameEn', 'birth', 'idno', 'ppno', 'nat'].forEach(k => { if (r && r[k]) o[k] = r[k]; }); return o; };

// 相簿匯入每一張都先留著照片（人工改了才會變成「修正」紀錄）；失敗的直接記成「失敗」
async function dbgSave(entry) {
  try {
    await dbgTx('readwrite', st => st.add({ t: new Date().toISOString(), ver: DBG_VER(), ...entry }));
    const all = await dbgAll();
    const old = all.filter(x => x.kind === 'pending'); if (old.length > DBG_KEEP) await dbgTx('readwrite', st => old.slice(0, old.length - DBG_KEEP).forEach(x => st.delete(x.id)));
    const rest = all.filter(x => x.kind !== 'pending'); if (rest.length > DBG_KEEP) await dbgTx('readwrite', st => rest.slice(0, rest.length - DBG_KEEP).forEach(x => st.delete(x.id)));
  } catch (e) { console.log('debug save', e); }
  dbgRender();
}
// 核對畫面按「正確」時：有改過任何欄位 → 記成「修正」（辨識結果 vs 正確答案）
async function dbgFix(rec, before) {
  const after = dbgPick(rec), changed = Object.keys({ ...before, ...after }).filter(k => (before[k] || '') !== (after[k] || ''));
  if (!changed.length) return;
  try {
    const all = await dbgAll();
    const p = all.find(x => x.kind === 'pending' && x.rid === rec.rid);
    if (p) await dbgTx('readwrite', st => st.put({ ...p, kind: 'fix', fixed: after, changed, fixedAt: new Date().toISOString() }));
    else {
      const img = rec.rid ? await getCrop(rec.rid) : null;
      await dbgTx('readwrite', st => st.add({ t: new Date().toISOString(), ver: DBG_VER(), kind: 'fix', rid: rec.rid, img, got: before, fixed: after, changed, ocr: '' }));
    }
  } catch (e) { console.log('debug fix', e); }
  dbgRender();
}
async function dbgExport() {
  const all = (await dbgAll()).filter(x => x.kind !== 'pending');
  if (!all.length) { alert('目前沒有除錯紀錄'); return; }
  const files = [], enc = new TextEncoder(); let report = '';
  for (const s of all) {
    const dt = new Date(s.t), q = n => String(n).padStart(2, '0');
    const base = `${String(s.id).padStart(4, '0')}_${s.kind === 'fail' ? '失敗' : '修正'}_${s.got && s.got.type || s.type || ''}_${q(dt.getMonth() + 1)}${q(dt.getDate())}_${q(dt.getHours())}${q(dt.getMinutes())}`;
    if (s.img) files.push({ name: base + '.jpg', data: new Uint8Array(await s.img.arrayBuffer()) });
    report += `=== ${base}（版本 ${s.ver || '?'}）\n`;
    if (s.kind === 'fail') report += `錯誤：${s.msg || ''}\n讀到：${JSON.stringify(s.got || {})}\n`;
    else report += `辨識：${JSON.stringify(s.got || {})}\n正確：${JSON.stringify(s.fixed || {})}\n改了：${(s.changed || []).join('、')}\n`;
    report += `--- 辨識原文 ---\n${s.ocr || '（無）'}\n\n`;
  }
  files.push({ name: 'report.txt', data: enc.encode(report) });
  const d = new Date(), p = n => String(n).padStart(2, '0');
  shareFile(makeZip(files), `debug_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`, 'application/zip');
}
async function dbgClear() {
  if (!confirm('清除所有除錯紀錄（含照片）？')) return;
  try { await dbgTx('readwrite', st => st.clear()); } catch {}
  dbgRender();
}
async function dbgRender() {
  const el = $('dbgBody'); if (!el) return;
  const all = await dbgAll();
  const nf = all.filter(x => x.kind === 'fail').length, nx = all.filter(x => x.kind === 'fix').length;
  el.innerHTML = `<div style="font-size:14px;margin-bottom:6px">辨識失敗 <b>${nf}</b> 張・人工修正 <b>${nx}</b> 筆</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:8px">相簿匯入讀不出來的照片、以及你在核對畫面改過的資料，會自動留下照片和辨識原文。匯出後傳給開發者，就能照實際的錯誤調整。<br>裡面有客人的證件照片，只存在這支手機，傳完請按「清除」。</div>
    <button class="sec" onclick="dbgExport()">匯出除錯資料 ZIP</button>
    <button class="danger" onclick="dbgClear()">清除除錯紀錄</button>`;
}
