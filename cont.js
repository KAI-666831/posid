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
  const ox = (W - v.videoWidth*s)/2, oy = (H - v.videoHeight*s)/2, r = frameRect();
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

// grp：從收銀結帳過來 { want: 要掃幾位, order, desc }；沒帶就是一般連續掃描
async function openContinuous(grp) {
  if (!grp || !grp.want) grp = null;
  unlockAudio();
  await openCamera();
  if (!stream) { if (grp && typeof groupDone === 'function') groupDone(0, grp.want); return; }
  let base = 'auto'; try { base = localStorage.getItem('idscan_cont_base') || 'auto'; } catch {}
  cont = { base, state: 'seek', prev: null, still: 0, sig: null, count: 0, busy: false, audio: contAudio, fails: 0, grp, got: 0 };
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
  if (cont.grp) top.innerHTML = `本組 <b>${cont.got}</b> / ${cont.grp.want} 位${cont.grp.desc ? '　<span style="opacity:.8">' + esc(cont.grp.desc) + '</span>' : ''}`;
  else top.innerHTML = `已存 <b id="contCount">${cont.count}</b> 筆`;
}
// 本組多一位（新存檔或之前就存過）；掃滿自動回收銀
function groupGot() {
  if (!cont || !cont.grp) return;
  cont.got++; contTopUI();
  if (cont.got >= cont.grp.want) {
    cont.state = 'done';
    contUI(`✓ ${cont.grp.want} 位都掃好了，回到收銀…`, '#16a34a');
    setTimeout(() => { if (cont && cont.state === 'done') stopContinuous(true); }, 1300);
  }
}
// 取消／完成按鈕
function contFinish() {
  if (cont && cont.grp && cont.got < cont.grp.want && !confirm(`這組還有 ${cont.grp.want - cont.got} 位沒掃，確定回收銀？`)) return;
  stopContinuous();
}
function stopContinuous() {
  if (!cont) return;
  clearInterval(cont.timer);
  const n = cont.count, grp = cont.grp, got = cont.got;
  cont = null;
  document.querySelector('#contBar .cb-top').innerHTML = '已存 <b id="contCount">0</b> 筆';
  $('contBar').style.display = 'none'; $('contRecent').style.display = 'none'; $('contTypes').style.display = 'none'; $('frame').style.borderColor = '#22c55e';
  closeOverlay();
  setType(TYPES[docType] ? docType : 'id');
  if (grp) { if (typeof groupDone === 'function') groupDone(got, grp.want); return; }
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
  try {
    const card = cropFromVideo();
    if (cont.base === 'auto') {
      // 通用自動辨識：先讀出所有文字判斷是哪種證件；身分證用身分證專用的讀法，其他用剛讀到的文字直接解析
      await loadDet();
      const lines = await readAllLines(card, (i, n) => contUI(`辨識中… ${i}/${n}`, '#3b82f6'));
      if (!cont) return;
      const g = guessType(lines) || 'id';
      setType(g);
      await runOcr(card, g === 'id' ? undefined : lines);
    } else {
      setType(cont.base);
      await runOcr(card);
    }
    let r = collectRecord(); r.sex = $('sex').value || inferSex(r);
    // 選「身分證」卻放了其他證件：改用通用辨識（會自動判斷類別）
    if (!recordOk(r) && cont.base === 'id') {
      setType('arc'); await runOcr(card);
      r = collectRecord(); r.sex = $('sex').value || inferSex(r);
    }
    if (!cont) return;
    if (recordOk(r)) {
      // 號碼要連續讀到兩次一樣才存（檢查碼抓不到 3↔8、0↔6 這類錯）
      const same = cont.cand && primaryNo(cont.cand) === primaryNo(r) && (cont.cand.birth || '') === (r.birth || '');
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
      const nv = {}; [cont.cand, r].forEach(x => { const n = primaryName(x); if (n) nv[n] = (nv[n] || 0) + 1; });
      const un = new Set([...(cont.candUnsure || []), ...lastUnsure]);
      if (Object.keys(nv).length > 1) un.add(EN_FIRST(r.type) ? 'nameEn' : 'name');   // 兩次讀到的名字不一樣 → 請核對
      if (!EN_FIRST(r.type)) r.name = pickName(nv) || r.name;
      cont.cand = null; cont.tries = 0;
      const c = findConflict(r);
      if (c && c.kind === 'dup' && cont.grp) {        // 收銀模式：老客人之前存過，也算這組的一位
        beep(true); contUI(`✓ ${primaryName(r)} 之前存過，算這組 1 位，請移開`, '#16a34a');
        cont.recent.unshift({ ...r, unsure:[] }); renderRecent(); groupGot();
      }
      else if (c && c.kind === 'dup') { beep(false); contUI(`${c.msg}，請換下一張`, '#eab308'); }
      else if (c) { beep(false); contUI(`⚠ ${c.msg}。沒有存檔，請看實體證件，用單張掃描確認`, '#dc2626'); }
      else {
        storeRecord({ ...r, confirmed:false, unsure:[...un] }, lastCrop);
        cont.count++; if ($('contCount')) $('contCount').textContent = cont.count;
        cont.recent.unshift({ ...r, unsure:[...un] }); renderRecent();
        beep(true); contUI(`✓ ${primaryName(r)}　${primaryNo(r)}　已存檔，請移開`, '#16a34a');
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
    ? cont.recent.map((x, i) => `<div class="cr${i === 0 ? ' new' : ''}${(x.unsure || []).length ? ' un' : ''}"><span class="n">${(x.unsure || []).length ? '⚠ ' : ''}${esc(primaryName(x))}</span><span class="b">${esc(x.birth || '')}</span><span class="i">${esc(primaryNo(x))}</span></div>`).join('')
    : '<div class="cr empty">掃描成功的資料會顯示在這裡</div>';
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
