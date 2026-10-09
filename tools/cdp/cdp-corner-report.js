(() => {
  const vw = innerWidth, vh = innerHeight;
  const frame = document.querySelector('[class*="BynINW_frame"]');
  const points = [
    ['TL', 2, 2],
    ['TR', vw - 3, 2],
    ['BL', 2, vh - 3],
    ['BR', vw - 3, vh - 3],
    ['TR-40', vw - 40, 40],
    ['BR-40', vw - 40, vh - 40],
  ];
  const out = {};
  for (const [name, x, y] of points) {
    const chain = [];
    let el = document.elementFromPoint(x, y);
    let i = 0;
    while (el && i < 10) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      chain.push({
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        tag: el.tagName,
        bg: cs.backgroundColor,
        bgi: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 34),
        pos: cs.position,
        z: cs.zIndex,
        rect: Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
        inFrame: frame ? frame.contains(el) : null,
      });
      el = el.parentElement;
      i += 1;
    }
    out[name] = chain;
  }
  // any fixed-position element that is NOT inside the frame (cannot be clipped by it)?
  const fixedOutside = [];
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (frame && frame.contains(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    fixedOutside.push({
      cls: (typeof e.className === 'string' ? e.className : '').slice(0, 44),
      tag: e.tagName,
      pos: cs.position,
      bg: cs.backgroundColor,
      z: cs.zIndex,
      rect: Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
    });
  }
  out.fixedOrAbsoluteOutsideFrame = fixedOutside.slice(0, 12);
  return JSON.stringify(out, null, 1);
})()
