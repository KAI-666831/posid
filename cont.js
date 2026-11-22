// ===== 連續掃描：證件放好 → 畫面穩定就自動辨識 → 成功嗶一聲存檔 → 移開換下一張 =====
let cont = null;   // { base, state, prev, still, sig, count, timer, busy }

// 提示音：成功＝高音「嗶嗶」兩聲，失敗＝低音「嗡—嗡」；用方波＋放大，比較大聲
function beep(ok = true) {
  try {
    const a = cont && cont.audio; if (!a) return;
    const comp = a.createDynamicsCompressor(); comp.connect(a.destination);
    const tone = (freq, start, dur, type) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq; o.connect(g); g.connect(comp);
      const t = a.currentTime + start;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1.0, t + 0.01);
      g.gain.setValueAtTime(1.0, t + dur - 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    if (ok) { tone(1568, 0, 0.12, 'square'); tone(2093, 0.15, 0.18, 'square'); }
    else { tone(220, 0, 0.28, 'sawtooth'); tone(185, 0.34, 0.38, 'sawtooth'); }
  } catch {}
  flash(ok);
}
// 整個畫面閃一下顏色，吵雜時也看得到
function flash(ok) {
  const f = $('contFlash'); if (!f) return;
  f.style.background = ok ? 'rgba(22,163,74,.45)' : 'rgba(220,38,38,.45)';
  f.style.opacity = '1'; setTimeout(() => f.style.opacity = '0', 350);
}

// 取框內畫面的縮圖（灰階 48x30），用來判斷有沒有動、有沒有東西
function sampleFrame() {
  const v = $('video'); if (!v.videoWidth) return null;
  const W = innerWidth, H = innerHeight, s = Math.max(W / v.videoWidth, H / v.videoHeight);
  const ox = (W - v.videoWidth*s)/2, oy = (H - v.videoHeight*s)/2, r = vidFrame();
  const c = sampleFrame.c || (sampleFrame.c = Object.assign(document.createElement('canvas'), { width:48, height:30 }));
  const g = c.getContext('2d', { willReadFrequently:true });
  g.drawImage(v, (r.x-ox)/s, (r.y-oy)/s, r.w/s, r.h/s, 0, 0, 48, 30);
  const d = g.getImageData(0, 0, 48, 30).data, out = new Float32Array(48*30);
  for (let i = 0; i < out.length; i++) out[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
  return out;
}
const frameDiff = (a, b) => { if (!a || !b) return 999; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const frameStd = a => { let m = 0; for (const x of a) m += x; m /= a.length; let v = 0; for (const x of a) v += (x-m)*(x-m); return Math.sqrt(v / a.length); };

function recordOk(r) {
  const no = EN_FIRST(r.type) ? (r.ppno && r.ppno.length >= 6) || validId(r.idno || '') : validId(r.idno || '');
  return !!(no && primaryName(r) && birthOk(r.type, r.birth));
}

function contUI(msg, color) {
  $('contMsg').textContent = msg;
  $('frame').style.borderColor = color || '#22c55e';
}

// 提示音共用同一個 AudioContext：從收銀自動跳過來時不是按鈕觸發，iPhone 可能還沒解鎖，點一下畫面就會有聲音
let contAudio = null;
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}   // iOS 17+：靜音模式下也發聲
  try { if (!contAudio) contAudio = new (window.AudioContext || window.webkitAudioContext)(); if (contAudio.state !== 'running') contAudio.resume(); } catch {}
}
document.addEventListener('touchstart', unlockAudio, { passive:true });
document.addEventListener('click', unlockAudio);

// grp：收銀的一組客人（groups.js）；chain：掃滿後接下一組（'auto'/'all'）；都沒帶就是一般連續掃描
let contOpening = false;   // 相機開啟中（避免兩組同時開）
async function openContinuous(grp, chain) {
  if (!grp || !grp.want) grp = null;
  unlockAudio();
  contOpening = true;
  try { await openCamera(); } finally { contOpening = false; }
  if (!stream) { if (grp) { grpRequeue(grp); if (typeof groupDone === 'function') groupDone(0, grp.want, grp); } return; }
  let base = 'id'; try { base = localStorage.getItem('idscan_cont_base') || 'id'; } catch {}
  if (base === 'auto') base = 'id';   // 「自」已拿掉：改成手動選證件，比較快
  cont = { base, state: 'seek', prev: null, still: 0, sig: null, count: 0, busy: false, audio: contAudio, fails: 0, grp, got: grp ? (grp.got || 0) : 0, chain: grp ? chain || null : null };
  $('shutter').style.display = 'none';
  $('contBar').style.display = 'block'; $('contCount').textContent = '0';
  contTopUI();
  cont.recent = []; renderRecent(); $('contRecent').style.display = 'block';
  $('contTypes').style.display = 'flex'; setContBase(cont.base);
  contUI('等待證件…', '#22c55e');
  cont.timer = setInterval(contTick, 250);
}
// 上方計數：一般模式「已存 N 筆」；收銀模式「本組 X / 5 位」
function contTopUI() {
  if (!cont) return;
  const top = document.querySelector('#contBar .cb-top');
  const more = cont.chain ? grpWaiting(cont.chain).length : 0;
  if (cont.grp) top.innerHTML = `${grpLabel(cont.grp)}　<b>${cont.got}</b> / ${cont.grp.want} 位${cont.grp.desc ? '<br><span style="opacity:.85;font-size:14px">' + esc(cont.grp.desc) + '</span>' : ''}${more > 0 ? `<br><span style="color:#fde047">後面還有 ${more} 組</span>` : ''}`;
  else top.innerHTML = `已存 <b id="contCount">${cont.count}</b> 筆`;
}
// 本組多一位（新存檔或之前就存過）；掃滿自動回收銀
function groupGot() {
  if (!cont || !cont.grp) return;
  cont.got++; cont.grp.got = cont.got; grpSave(); contTopUI();
  if (cont.got >= cont.grp.want) {
    if (grpAdvance()) return;   // 還有下一組：不關相機直接接
    cont.state = 'done';
    contUI(`✓ ${grpLabel(cont.grp)} ${cont.grp.want} 位都掃好了`, '#16a34a');
    setTimeout(() => { if (cont && cont.state === 'done') stopContinuous(true); }, 1300);
  }
}
// 取消／完成按鈕
function contFinish() {
  if (cont && cont.grp && cont.got < cont.grp.want && !confirm(`這組還有 ${cont.grp.want - cont.got} 位沒掃，確定結束這組？`)) return;
  stopContinuous('user');
}
function stopContinuous(reason) {
  if (!cont) return;
  clearInterval(cont.timer);
  const n = cont.count, grp = cont.grp, got = cont.got;
  cont = null;
  document.querySelector('#contBar .cb-top').innerHTML = '已存 <b id="contCount">0</b> 筆';
  $('contBar').style.display = 'none'; $('contRecent').style.display = 'none'; $('contTypes').style.display = 'none'; $('frame').style.borderColor = '#22c55e';
  closeOverlay();
  setType(TYPES[docType] ? docType : 'id');
  if (grp) {
    if (got >= grp.want || reason === 'user') grpFinish(grp, got, got < grp.want); else grpRequeue(grp);
    if (typeof groupDone === 'function') groupDone(got, grp.want, grp);
    return;
  }
  if (n) toast(`連續掃描完成，共存了 ${n} 筆`);
}

async function contTick() {
  if (!cont || cont.busy || cont.state === 'done') return;
  const f = sampleFrame(); if (!f) return;
  const d = frameDiff(f, cont.prev); cont.prev = f;

  if (cont.state === 'remove') {                 // 等你把上一張移開
    // 要真的移開（畫面大變、而且連續兩次）才算換下一張，避免手晃一下就重掃
    cont.gone = frameDiff(f, cont.sig) > 28 ? (cont.gone || 0) + 1 : 0;
    if (cont.gone >= 2) { cont.state = 'seek'; cont.still = 0; cont.seenAt = 0; cont.gone = 0; cont.cand = null; cont.tries = 0; contUI('放下一張', '#22c55e'); }
    return;
  }
  if (cont.state === 'cool') {                   // 沒讀完整：等畫面變了再試
    if (Date.now() > cont.until) { cont.state = 'seek'; cont.still = 0; cont.seenAt = Date.now() - 1500; contUI('再試一次…', '#eab308'); }
    return;
  }
  // seek：畫面要有東西、而且連續幾次幾乎不動（不模糊）才辨識
  if (frameStd(f) < 18) { cont.still = 0; cont.seenAt = 0; contUI('等待證件…'); return; }
  if (!cont.seenAt) cont.seenAt = Date.now();
  // 手拿一定會微晃：門檻放寬；而且看到證件超過 2 秒就算還在晃也直接辨識（辨識本身會多讀幾次投票）
  cont.still = d < 9 ? cont.still + 1 : 0;
  const waited = Date.now() - cont.seenAt;
  if (cont.still < 2 && waited < 2000) { contUI(d < 9 ? '拿穩…' : '偵測到證件，拿穩…', '#eab308'); return; }

  cont.busy = true; contUI('辨識中…', '#3b82f6');
  const t0 = performance.now();
  try {
    // 跟相簿匯入用同一套讀法（實測比較準：例如身分證生日 59 不會讀成 50）：找證件範圍 → 判斷種類 → 身分證用卡片比例裁切、交叉比對
    const card = cropFromVideo(highAuto() && ['id', 'arc', 'nhi'].includes(cont.base));
    await loadDet();
    const res = await recognizePhoto(card, t => contUI(t, '#3b82f6'), () => !cont, undefined, cont.base);
    if (!cont || res.cancel) return;
    let r = res.fail ? {} : res.r;
    if (!cont) return;
    if (recordOk(r) && lastParse._back) {
      // 居留證背面：剛剛用正面存過的話，直接更正那一筆（不多算人數）
      const m = arcBackMerge(r, cont.flip && cont.flip.rid);
      if (m) {
        cont.flip = null; cont.cand = null; cont.tries = 0;
        const k = cont.recent.findIndex(x => x.rid === m.rid); if (k >= 0) cont.recent[k] = { ...m }; renderRecent();
        if (dbgAllOn()) smallPhoto(card, 1400).then(img => dbgSave({ kind: 'pending', rid: m.rid + '_back', img, got: dbgPick(m), note: '居留證背面更正', ocr: ocrText(readAllLines.last) }));
        beep(true); contUI(`${m.unsure.length ? '⚠' : '✓'} 已用背面更正：${primaryName(m)}　${shownNo(m)}，請換下一位`, '#16a34a');
        clearFields(); $('cardView').style.display = 'none';
        cont.state = 'remove'; cont.sig = f; return;
      }
    }
    if (recordOk(r)) {
      // 號碼要連續讀到兩次一樣才存（檢查碼抓不到 3↔8、0↔6 這類錯）；居留證背面每段都有檢查碼，讀一次就夠
      const same = lastParse._back || (cont.cand && primaryNo(cont.cand) === primaryNo(r) && (cont.cand.birth || '') === (r.birth || ''));
      if (!same) {
        cont.tries = (cont.tries || 0) + 1;
        if (cont.tries >= 5) {
          cont.cand = null; cont.tries = 0; beep(false);
          contUI('讀了幾次結果都不一樣，請調整角度或改用單張掃描', '#dc2626');
          cont.state = 'cool'; cont.sig = f; cont.until = Date.now() + 1500; return;
        }
        cont.cand = r; cont.candUnsure = lastUnsure.slice();
        contUI(`讀到 ${primaryName(r)}，再確認一次…`, '#3b82f6');
        cont.seenAt = Date.now() - 2000; cont.still = 0;      // 馬上再讀一次
        return;
      }
      // 兩次一樣：姓名取比較可信的那個（常見姓氏、三個字優先）
      const nv = {}; [cont.cand, r].filter(Boolean).forEach(x => { const n = primaryName(x); if (n) nv[n] = (nv[n] || 0) + 1; });
      // 兩次讀到的號碼、生日一樣（上面已經比過）→ 不用再標；其他欄位兩次都標才標（只有一次標，多半是那一格畫面晃到）
      const c1 = new Set(cont.candUnsure || lastUnsure);
      const un = new Set(lastParse._back ? lastUnsure : lastUnsure.filter(k => c1.has(k) && !['idno', 'birth', 'ppno'].includes(k)));
      // 生日例外：重讀生日那一列有讀到別的日期（例如 3 月讀成 8 月），任何一次有就要標
      if (!lastParse._back && (c1.has('birth') || lastUnsure.includes('birth')) && r.type === 'id') un.add('birth');
      // 號碼是「補救」來的（兩種讀法都沒讀到，靠猜一個字或從別處找）：兩次一樣也可能是同樣猜錯，一定要標
      if (r._idGuess || (cont.cand && cont.cand._idGuess)) un.add(r.type === 'passport' ? 'ppno' : 'idno');
      if (Object.keys(nv).length > 1) un.add(EN_FIRST(r.type) ? 'nameEn' : 'name');   // 兩次讀到的名字不一樣 → 請核對
      if (!EN_FIRST(r.type)) r.name = pickName(nv) || r.name;
      cont.cand = null; cont.tries = 0;
      const c = findConflict(r);
      if (c && c.kind === 'dup') {                     // 重複：不存、不算人數，明顯提醒
        const old = load().find(x => primaryNo(r) ? primaryNo(x) === primaryNo(r) : primaryName(x) === primaryName(r));
        const og = old && old.grp && grpById(old.grp);
        beep(false);
        contUI(`⚠ 重複！${primaryName(r)} 已經掃過${og ? '（' + grpLabel(og) + '）' : ''}，這張不算，請換下一張`, '#dc2626');
      }
      else if (c) { beep(false); contUI(`⚠ ${c.msg}。沒有存檔，請看實體證件，用單張掃描確認`, '#dc2626'); }
      else {
        const rid = storeRecord(grpTag({ ...r, confirmed:false, unsure:[...un], mrz: !!lastParse._back }), lastCrop);
        cont.count++; if ($('contCount')) $('contCount').textContent = cont.count;
        cont.recent.unshift({ ...r, rid, unsure:[...un] }); renderRecent();
        sendStoredToDisplay(rid);                  // 有配對客人確認螢幕：送過去排隊給客人確認（不等）
        if (dbgAllOn()) smallPhoto(card, 1400).then(img => dbgSave({ kind: 'pending', rid, img, got: dbgPick({ ...r, unsure:[...un] }), unsure: [...un], ocr: ocrText(readAllLines.last) }));   // 測試期間：成功的也留下來
        lastOcrMs = performance.now() - t0;
        if (r.type === 'arc' && !lastParse._back && un.size) {
          // 居留證正面有 ⚠：已經存了、也算人數，請翻到背面再掃一次來更正
          cont.flip = { rid }; beep(true);
          contUI(`⚠ ${primaryName(r)} 已存，但有欄位要核對 → 請把卡片翻到背面再掃一次`, '#ea580c');
        } else {
          cont.flip = null;
          beep(true); contUI(`✓ ${primaryName(r)}　${shownNo(r)}　已存檔，請移開（${(lastOcrMs / 1000).toFixed(1)} 秒）`, '#16a34a');
        }
        groupGot();
      }
      clearFields(); $('cardView').style.display = 'none';
      if (cont.state !== 'done') { cont.state = 'remove'; cont.sig = f; }
    } else {
      cont.fails++;
      contUI('沒讀完整，稍微調整角度或避開反光', '#dc2626');
      cont.state = 'cool'; cont.sig = f; cont.until = Date.now() + 1200;
    }
  } catch (e) { contUI('辨識失敗：' + e.message, '#dc2626'); cont && (cont.state = 'cool', cont.sig = f, cont.until = Date.now() + 2500); }
  finally { if (cont) cont.busy = false; }
}

// 取景框上方：顯示這次連續掃描剛存的資料（最新的在最上面），方便一邊掃一邊核對
function renderRecent() {
  const box = $('contRecent'); if (!box || !cont) return;
  const r = frameRect();
  box.style.maxHeight = Math.max(80, r.y - 70 - box.offsetTop) + 'px';
  box.innerHTML = cont.recent.length
    ? cont.recent.map((x, i) => {
        // ⚠ 只標在有問題的那一格（名字／生日／號碼），不是整列都標
        const u = new Set(x.unsure || []);
        const wn = u.has('name') || u.has('nameEn'), wb = u.has('birth') || u.has('birthAd'), wi = u.has('idno') || u.has('ppno');
        const cell = (cls, w, v) => `<span class="${cls}${w ? ' w' : ''}">${w ? '⚠' : ''}${esc(v)}</span>`;
        const cs = x.custBad ? '<span style="color:#f87171">✗</span>' : x.confirmed ? '<span style="color:#86efac">✓</span>' : '';   // 客人確認結果
        return `<div class="cr${i === 0 ? ' new' : ''}">${cs}${cell('n', wn, primaryName(x))}${cell('b', wb, x.birth || '')}${cell('i', wi, shownNo(x))}${x.rid ? `<button class="x" onclick="contUndo('${x.rid}')">刪</button>` : ''}</div>`;
      }).join('')
    : '<div class="cr empty">掃描成功的資料會顯示在這裡</div>';
}

// 掃錯了：刪掉這筆（不算人數），同一張卡留在框裡就會馬上重掃
function contUndo(rid) {
  if (!cont) return;
  const x = cont.recent.find(y => y.rid === rid); if (!x) return;
  if (!confirm(`刪除「${primaryName(x)}」這筆？\n刪掉後把證件放回框內就會重掃。`)) return;
  const a = load(), i = a.findIndex(y => y.rid === rid);
  cancelOnDisplay(rid);
  if (i >= 0) { const rec = a[i]; delCrop(rid); a.splice(i, 1); store(a); render();
    if (cont.grp && rec.grp === cont.grp.id && cont.got > 0) { cont.got--; cont.grp.got = cont.got; grpSave(); }
    else if (rec.grp && grpById(rec.grp)) { const g = grpById(rec.grp); g.got = Math.max(0, (g.got || 0) - 1); if (g.state === 'done') g.partial = g.got < g.want; grpSave(); grpRender(); }   // 上一組（已經跳到下一組了）
  }
  cont.recent = cont.recent.filter(y => y.rid !== rid);
  cont.count = Math.max(0, cont.count - 1);
  if (cont.flip && cont.flip.rid === rid) cont.flip = null;
  contTopUI(); renderRecent();
  // 重新開始找證件：卡片還在框裡也會重讀
  cont.state = 'seek'; cont.sig = null; cont.still = 0; cont.seenAt = 0; cont.cand = null; cont.tries = 0;
  contUI(`已刪除「${primaryName(x)}」，把證件放進框內重掃`, '#f59e0b');
}

// 連續掃描畫面下方的類別按鈕：自（自動辨識）身 居 護 船 健 駕
function setContBase(b) {
  if (!cont) return;
  cont.base = b; cont.cand = null; cont.tries = 0;
  try { localStorage.setItem('idscan_cont_base', b); } catch {}
  document.querySelectorAll('#contTypes button').forEach(x => x.classList.toggle('on', x.dataset.b === b));
  placeFrame();
  const names = { auto:'自動判斷證件', id:'身分證', arc:'居留證', passport:'護照', seaman:'船員證', nhi:'健保卡', dl:'駕照' };
  $('hint').textContent = `【${names[b]}】放進框內拿穩就會辨識`;
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('#contTypes button'); if (b) setContBase(b.dataset.b); });
