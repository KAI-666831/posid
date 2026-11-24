// ===== 進出港名單「背面」：出港安檢表（船舶資料、發航前確認、經營計畫、緊急聯絡、船長簽名）=====
// 固定資料存在這支手機（很少改）；出海／返港日期時間每次可調整
const BACK_KEY = 'posid_back';
const BACK_DEF = {
  ship: '「大益8號」漁船（CT3－6283）', ton: '49.25', cap: '46', mmsi: '416006178',
  vest: '50', ring: '4', flare: '4', officer: '2', crewN: '2',
  licFrom: '115年5月29日', licTo: '116年6月15日', item: '觀賞漁撈作業',
  ecName: '', ecRel: '', ecTel: '0912800200', ecAddr: '高雄市三民區十全一路456號',
  via: '', to: '',
};
const backCfg = () => { try { return { ...BACK_DEF, ...(JSON.parse(localStorage.getItem(BACK_KEY)) || {}) }; } catch { return { ...BACK_DEF }; } };
function backSave() {
  const c = backCfg();
  document.querySelectorAll('#backForm [data-b]').forEach(i => { c[i.dataset.b] = i.value.trim(); });
  try { localStorage.setItem(BACK_KEY, JSON.stringify(c)); } catch {}
}
const bp2 = n => String(n).padStart(2, '0');
function backInit() {
  sigInit(); sigStateUI();
  const c = backCfg();
  document.querySelectorAll('#backForm [data-b]').forEach(i => { i.value = c[i.dataset.b] || ''; });
  // 出海：今天、現在（取整 10 分）；返港：預設同一天 18:00
  const d = new Date(), ymd = `${d.getFullYear()}-${bp2(d.getMonth() + 1)}-${bp2(d.getDate())}`;
  if (!$('bkOutD').value) $('bkOutD').value = ymd;
  if (!$('bkOutT').value) $('bkOutT').value = `${bp2(d.getHours())}:${bp2(Math.floor(d.getMinutes() / 10) * 10)}`;
  if (!$('bkInD').value) $('bkInD').value = ymd;
  if (!$('bkInT').value) $('bkInT').value = '18:00';
}
const bkDt = (dv, tv) => { const [y, m, d] = (dv || '').split('-').map(Number), [h, mi] = (tv || '').split(':').map(Number); return { y: y ? y - 1911 : '', m: m || '', d: d || '', h: isNaN(h) ? '' : h, mi: isNaN(mi) ? '' : bp2(mi) }; };

// ---------- 船長手寫簽名（簽一次存在手機，背面自動印上去）----------
const SIG_KEY = 'posid_sig';
let sigImg = null;
function sigLoad() { try { const d = localStorage.getItem(SIG_KEY); if (d) { sigImg = new Image(); sigImg.src = d; } else sigImg = null; } catch {} sigStateUI(); }
function sigStateUI() { const el = document.getElementById('sigState'); if (el) el.textContent = localStorage.getItem(SIG_KEY) ? '✓ 已存簽名，背面會自動印上去' : '還沒存簽名（背面會留空白讓你手寫）'; }
let sigDirty = false;
function sigInit() {
  const c = $('sigPad'); if (!c || c._init) return; c._init = true;
  const g = c.getContext('2d'); g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#000';
  let down = false;
  const pos = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener('pointerdown', e => { down = true; c.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...pos(e)); sigDirty = true; });
  c.addEventListener('pointermove', e => { if (!down) return; g.lineTo(...pos(e)); g.stroke(); });
  c.addEventListener('pointerup', () => { down = false; });
  // 已存的簽名先畫上去
  if (sigImg) { const draw = () => g.drawImage(sigImg, 0, 0, c.width, c.height); sigImg.complete ? draw() : (sigImg.onload = draw); }
}
function sigClear() { const c = $('sigPad'); c.getContext('2d').clearRect(0, 0, c.width, c.height); sigDirty = false; try { localStorage.removeItem(SIG_KEY); } catch {} sigImg = null; sigStateUI(); }
function sigSave() {
  const c = $('sigPad');
  // 裁掉空白邊
  const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0) { alert('框裡還沒簽名'); return; }
  const pad = 10, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2, o = document.createElement('canvas'); o.width = w; o.height = h;
  o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
  try { localStorage.setItem(SIG_KEY, o.toDataURL('image/png')); } catch { alert('存不進去'); return; }
  sigLoad(); toast('簽名已儲存');
}
sigLoad();

function renderBackCanvas() {
  backSave();
  const c = backCfg(), o = bkDt($('bkOutD').value, $('bkOutT').value), r = bkDt($('bkInD').value, $('bkInT').value);
  const W = 2000, H = Math.round(W * 297 / 210);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#000'; g.strokeStyle = '#000';
  const F = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
  const FS = 46;
  const text = (t, x, y, size = FS, align = 'left', weight = '') => { g.font = `${weight} ${size}px ${F}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(t, x, y); };
  const line = (x1, y1, x2, y2, w = 3) => { g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  const rect = (x, y, w, h, lw = 3) => { g.lineWidth = lw; g.strokeRect(x, y, w, h); };
  const yes = '■有□無', ok = '■是□否';

  const X0 = 90, X1 = W - 90, LX = X0 + 110;            // 左邊一欄是直寫的分區標題
  let y = 140;
  text('臺端駕船從事娛樂漁業活動，請於出海前填妥本表，置放於施行安全檢查之安檢站。', W / 2, y, 44, 'center');
  y += 70;
  const top = y, LH = 88;          // 撐滿 A4，跟紙本差不多大
  const sections = [];
  const sec = (title, rows) => { const y0 = y; rows.forEach(t => { if (typeof t === 'function') t(y + LH / 2); else text(t, LX + 30, y + LH / 2); y += LH; }); sections.push([title, y0, y]); };

  sec('漁船資料', [
    `船名：${c.ship}`,
    `總噸位：${c.ton}`,
    `載客人數：${c.cap}`,
    '具備設備類別：',
    `1. A 級船舶自動識別系統船載臺（AIS）：${yes}（MMSI碼：${c.mmsi}）`,
    `2. 船位回報器（VMS）：${yes}`,
    `3. 無線電對講機（DSB）：${yes}`,
    `4. 應急指位無線電示標（EPIRB）：${yes}`,
    '5. 通訊範圍距漁業通訊電臺 24 浬以外者，應增設單邊帶無線電話臺',
    `　 （SSB）：${yes}`,
    `6. 救生設備：${yes}（救生衣：${c.vest} 件；救生圈：${c.ring} 只；信號彈：${c.flare} 枚）`,
    `7. 衛星電話：${yes}`,
  ]);
  sec('發航前應確認事項', [
    '發航前船長應確認事項：',
    `1. 氣象或海象適合航行：${ok}`,
    `2. 搭載乘客未超過乘客定額：${ok}`,
    `3. 乘客均已穿著救生衣：${ok}`,
    `4. 依第十三條附表二規定配置娛樂漁業漁船船員：幹部：${c.officer} 人，船員：${c.crewN} 人`,
    `5. 向行政院農業委員會漁業署漁業監控中心查詢並確認船位訊號已回報：${ok}`,
    `6. 維持通訊設備與通訊電臺正常通聯：${ok}`,
  ]);
  sec('經營計畫', [
    `1. ${o.y} 年 ${o.m} 月 ${o.d} 日 ${o.h} 時 ${o.mi} 分出海。`,
    `2. 經 ${c.via || '＿＿＿＿'} 前往 ${c.to || '＿＿＿＿'}；預計返港時間：${r.m} 月 ${r.d} 日 ${r.h} 時 ${r.mi} 分`,
    `3. 娛樂漁業執照效期：${c.licFrom} 至 ${c.licTo}`,
    `4. 經營娛樂漁業活動項目：${c.item}。`,
    '5. 經營載客潛水是否經核准：□是□否（未經核准載客潛水者免填列）',
  ]);
  sec('緊急聯絡', [
    `姓名：${c.ecName}　　　　　　關係：${c.ecRel}`,
    `電話：${c.ecTel}`,
    `地址：${c.ecAddr}`,
  ]);
  const bottom = y;
  // 外框、分區線、左欄直寫標題
  rect(X0, top, X1 - X0, bottom - top, 4);
  line(LX, top, LX, bottom, 3);
  sections.forEach(([t, a, b], i) => {
    if (i) line(X0, a, X1, a, 3);
    const chars = [...t], step = Math.min(64, (b - a - 30) / chars.length);
    chars.forEach((ch, k) => text(ch, (X0 + LX) / 2, a + (b - a) / 2 + (k - (chars.length - 1) / 2) * step, Math.min(44, step * 0.85), 'center'));
  });
  // 船長簽名（留空手寫）
  y = bottom + 120;
  text('船長簽名：', X0 + 20, y, 58);
  line(X0 + 330, y + 42, X0 + 1200, y + 42, 3);
  // 存過的手寫簽名：印在線上
  if (sigImg && sigImg.complete && sigImg.naturalWidth) {
    const hh = 150, ww = Math.min(860, sigImg.naturalWidth * hh / sigImg.naturalHeight);
    g.drawImage(sigImg, X0 + 350, y + 40 - hh + 10, ww, hh);
  }
  return { canvas: cv };
}

// 多頁 PDF：每頁一張圖，A4 直式
function pdfFromCanvases(canvases, name) {
  Promise.all(canvases.map(cv => new Promise(res => cv.toBlob(async b => res({ cv, jpg: new Uint8Array(await b.arrayBuffer()) }), 'image/jpeg', 0.92)))).then(pages => {
    const PW = 595.28, PH = 841.89, M = 12, enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const push = p => { const u = typeof p === 'string' ? enc.encode(p) : p; parts.push(u); len += u.length; };
    const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
    pages.forEach(({ cv, jpg }, i) => {
      const s = Math.min((PW - 2 * M) / cv.width, (PH - 2 * M) / cv.height);
      const w = cv.width * s, h = cv.height * s, x = (PW - w) / 2, yy = PH - M - h;
      const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${yy.toFixed(2)} cm /Im0 Do Q`;
      const pn = 3 + i * 3;
      obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>`));
      obj(pn + 1, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
      obj(pn + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push('\nendstream'); });
    });
    const total = 3 + n * 3, xref = len;
    let x2 = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let k = 1; k < total; k++) x2 += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
    push(x2 + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    shareFile(new Blob(parts, { type: 'application/pdf' }), name, 'application/pdf');
  });
}
// 正面＋背面（雙面列印）、只印背面
function manifestPdf2() { pdfFromCanvases([renderManifestCanvas().canvas, renderBackCanvas().canvas], manifestName('pdf')); }
function backPdf() { pdfFromCanvases([renderBackCanvas().canvas], manifestName('pdf').replace('出船乘客名單', '出港安檢表')); }
function backPreview() { const { canvas } = renderBackCanvas(); $('bkPrev').src = canvas.toDataURL('image/jpeg', 0.7); $('bkPrev').style.display = 'block'; }
