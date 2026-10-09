(() => {
  const pts = [
    [280, 750], [320, 750], [400, 750], [460, 750], [300, 740], [300, 760], [300, 766],
    [300, 762], [40, 750], [36, 750], [30, 750], [345, 765],
  ];
  const seen = new Map();
  const desc = (el) => {
    const r = el.getBoundingClientRect();
    return {
      el: el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      bg: getComputedStyle(el).backgroundColor,
      bgi: getComputedStyle(el).backgroundImage.slice(0, 90),
      pos: getComputedStyle(el).position,
    };
  };
  const hits = pts.map(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const row = { pt: [x, y], hit: el ? desc(el) : null };
    if (el) {
      const chain = [];
      let cur = el;
      for (let i = 0; i < 5 && cur; i++) { chain.push(desc(cur)); cur = cur.parentElement; }
      row.chain = chain;
      row.path = (() => { const p = []; let c = el; while (c && p.length < 8) { p.push(c.tagName + '.' + String(c.className || '').split(' ')[0]); c = c.parentElement; } return p.join(' < '); })();
    }
    return row;
  });

  // every element that actually paints a dark/opaque background in the sidebar
  const dark = [];
  for (const el of document.querySelectorAll('.BynINW_sidebarCol *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 8) continue;
    if (r.bottom < innerHeight - 200) continue;
    const cs = getComputedStyle(el);
    const d = {
      el: el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      bg: cs.backgroundColor,
      bgi: cs.backgroundImage.slice(0, 120),
      pos: cs.position,
      op: cs.opacity,
      z: cs.zIndex,
    };
    const m = String(cs.backgroundColor).match(/[\d.]+/g);
    const lum = m ? 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2] : null;
    const alpha = m && m.length >= 4 ? +m[3] : 1;
    if ((lum !== null && lum < 120 && alpha > 0.05) || cs.backgroundImage !== 'none') dark.push(d);
  }
  dark.sort((a, b) => b.rect[1] - a.rect[1]);
  return JSON.stringify({ hits, darkNearBottom: dark.slice(0, 20) }, null, 1);
})()
