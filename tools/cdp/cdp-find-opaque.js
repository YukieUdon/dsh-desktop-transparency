(() => {
  const out = {};
  const cx = Math.round(innerWidth * 0.35);
  const cy = Math.round(innerHeight * 0.75);
  const el = document.elementFromPoint(cx, cy);
  out.samplePoint = cx + ',' + cy;
  const chain = [];
  let n = el;
  let i = 0;
  while (n && i < 14) {
    const cs = getComputedStyle(n);
    const cls = typeof n.className === 'string' ? n.className : '';
    chain.push({
      tag: n.tagName,
      cls: cls.slice(0, 60),
      bg: cs.backgroundColor,
      bgi: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 70),
      backdrop: cs.backdropFilter,
      opacity: cs.opacity,
    });
    n = n.parentElement;
    i += 1;
  }
  out.chain = chain;

  // every element with a non-transparent background, largest area first
  const painters = [];
  for (const e of document.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasImg = cs.backgroundImage && cs.backgroundImage !== 'none';
    if (!hasBg && !hasImg) continue;
    const r = e.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area < innerWidth * innerHeight * 0.08) continue;
    painters.push({
      tag: e.tagName,
      cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50),
      bg: hasBg ? bg : null,
      bgi: hasImg ? cs.backgroundImage.slice(0, 50) : null,
      area: Math.round(area),
      rect: Math.round(r.width) + 'x' + Math.round(r.height),
    });
  }
  painters.sort((a, b) => b.area - a.area);
  out.bigPainters = painters.slice(0, 14);

  // any element carrying a wallpaper / custom background image?
  const wallpapers = [];
  for (const e of document.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && /url\(/.test(cs.backgroundImage)) {
      wallpapers.push({ cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50), bgi: cs.backgroundImage.slice(0, 90) });
    }
  }
  out.elementsWithUrlBackground = wallpapers.slice(0, 10);
  out.pluginStyleHints = [...document.querySelectorAll('style')]
    .map((s) => (s.textContent || ''))
    .filter((t) => /wallpaper|透明度|opacity|背景/.test(t))
    .slice(0, 3)
    .map((t) => t.slice(0, 300));
  return JSON.stringify(out, null, 1);
})()
