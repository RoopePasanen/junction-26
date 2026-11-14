// Runs inside the gemini.google.com tab (stored in localStorage.__code, started with eval).
// NOTE: the live version also has a capture patch (localStorage.__code2): a MutationObserver hooks every
// <img> and copies blob: images to a canvas inside their 'load' event, because Gemini revokes the blob URL
// and swaps in a non-CORS lh3.googleusercontent.com URL right after loading. __gen then takes the first
// capture made after the prompt was sent. Restore after a reload with:
//   eval(localStorage.getItem('__code')); eval(localStorage.getItem('__code2'));
// Generates every prompt in localStorage.__P that is not in localStorage.__done,
// grabs each image while it is still a blob: URL, and downloads ZIPs of a few images at a time.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__P = JSON.parse(localStorage.getItem('__P'));
  window.__store = window.__store || {};
  window.__log = window.__log || [];
  const done = new Set(JSON.parse(localStorage.getItem('__done') || '[]'));
  window.__state = { done, attempts: {}, consecFail: 0, stuck: 0, status: 'idle', lastProgress: Date.now() };

  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const zip = async (names) => {
    const parts = [], central = []; let off = 0; const enc = new TextEncoder();
    for (const nm of names) {
      const data = new Uint8Array(await window.__store[nm].arrayBuffer()); const fn = enc.encode(nm); const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, fn.length, true);
      parts.push(new Uint8Array(h.buffer), fn, data);
      const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, fn.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), fn); off += 30 + fn.length + data.length;
    }
    const cs = central.reduce((s, a) => s + a.length, 0); const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, names.length, true); e.setUint16(10, names.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  };
  // Download everything in the store and only then mark those items done.
  window.__flush = async (zipName) => {
    const names = Object.keys(window.__store); if (!names.length) return 'EMPTY';
    const z = await zip(names);
    const a = document.createElement('a'); a.href = URL.createObjectURL(z); a.download = zipName; document.body.appendChild(a); a.click(); a.remove();
    names.forEach((n) => { const i = window.__P.findIndex((p) => p.file === n); if (i >= 0) done.add(i); });
    localStorage.setItem('__done', JSON.stringify([...done]));
    window.__store = {};
    return `FLUSH ${zipName} ${names.length} files ${z.size}B`;
  };

  const stopBtn = () => [...document.querySelectorAll('button')].find((b) => /stop/i.test(b.getAttribute('aria-label') || '') && b.offsetParent && !b.disabled);
  const sendBtn = () => [...document.querySelectorAll('button')].find((b) => /send/i.test(b.getAttribute('aria-label') || '') && !b.disabled);

  window.__gen = async (prompt, name) => {
    for (let k = 0; k < 3 && stopBtn(); k++) { stopBtn().click(); await sleep(2500); }
    const before = document.querySelectorAll('model-response').length;
    const ed = document.querySelector('.ql-editor[contenteditable]');
    if (!ed) return 'STUCK no editor';
    ed.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, prompt);
    let send; for (let k = 0; k < 10 && !send; k++) { await sleep(500); send = sendBtn(); }
    if (!send) return 'STUCK no send button';
    send.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(200);
      const rs = document.querySelectorAll('model-response');
      if (rs.length > before) {
        const imgs = [...rs[rs.length - 1].querySelectorAll('img')].filter((i) => i.naturalWidth > 300);
        const bl = imgs.find((i) => i.src.startsWith('blob:') && i.complete);
        if (bl) {
          const c = document.createElement('canvas'); c.width = bl.naturalWidth; c.height = bl.naturalHeight; c.getContext('2d').drawImage(bl, 0, 0);
          const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
          window.__store[name] = b; await sleep(1500);
          return `OK ${bl.naturalWidth}x${bl.naturalHeight} ${b.size}B ${Math.round((Date.now() - t0) / 1000)}s`;
        }
        if (imgs.length && imgs.every((i) => !i.src.startsWith('blob:')) && Date.now() - t0 > 5000) { await sleep(1500); return 'ERR lh3-only'; }
        if (!stopBtn() && !imgs.length && Date.now() - t0 > 25000) return 'NOIMG ' + rs[rs.length - 1].innerText.slice(0, 160).replace(/\s+/g, ' ');
      }
    }
    if (stopBtn()) { stopBtn().click(); await sleep(2500); }
    return 'STUCK hung 90s';
  };

  const newChat = async () => {
    const l = [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'New chat' && a.offsetParent);
    if (l) l.click(); await sleep(4000);
  };

  window.__runQ = (per = 3) => {
    if (window.__qRunning) return 'already running';
    window.__qRunning = true; window.__stop = false;
    const S = window.__state;
    (async () => {
      try {
        while (!window.__stop) {
          const todo = window.__P.map((_, i) => i).filter((i) => !done.has(i) && !(window.__P[i].file in window.__store) && (S.attempts[i] || 0) < 5);
          if (!todo.length) break;
          const i = todo[0], f = window.__P[i].file;
          S.status = 'gen ' + i;
          let r; try { r = await window.__gen(window.__P[i].prompt, f); } catch (e) { r = 'ERR ' + e.message; }
          S.attempts[i] = (S.attempts[i] || 0) + 1;
          window.__log.push(`${i} ${f.split('/')[1]} a${S.attempts[i]} ${r}`);
          if (r.startsWith('OK')) { S.consecFail = 0; S.stuck = 0; S.lastProgress = Date.now(); }
          else if (r.startsWith('STUCK')) { S.stuck++; window.__log.push('-> new chat'); await newChat(); if (S.stuck >= 3) { S.status = 'backoff'; await sleep(120000); } }
          else { S.consecFail++; await sleep(S.consecFail >= 3 ? Math.min(60000 * (S.consecFail - 2), 300000) : 3000); }
          if (Object.keys(window.__store).length >= per) window.__log.push(await window.__flush(`batch_r${String(i).padStart(3, '0')}_${Date.now() % 100000}.zip`));
        }
      } finally {
        window.__log.push(await window.__flush(`batch_tail_${Date.now()}.zip`));
        window.__qRunning = false;
        if (window.__P.every((_, i) => done.has(i))) { S.status = 'finished'; window.__log.push('ALL DONE'); } else S.status = 'stopped';
      }
    })();
    return 'queue started, done ' + done.size;
  };

  // Restart the queue if it ever exits while work is left (unless stopped on purpose).
  clearInterval(window.__sup);
  window.__sup = setInterval(() => { if (!window.__qRunning && !window.__stop && done.size < window.__P.length) window.__runQ(); }, 30000);
  return window.__runQ();
})();
