(() => {
  const out = { viewport: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio };
  const fades = [...document.querySelectorAll('[class*="_9lTDKa_fade"]')];
  out.fadeCount = fades.length;
  out.fades = fades.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: String(el.className).slice(0, 80),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      backgroundImage: cs.backgroundImage,
      removed: cs.display === 'none',
    };
  });
  // Which CSS reached the page: an insertCSS sheet can refuse cssRules access, so the
  // reliable evidence is the computed style of the elements the patch targets, plus the
  // fade element's own display below.
  let transparencyRules = 0;
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.cssText && rule.cssText.includes('_9lTDKa_fade')) transparencyRules += 1;
      }
    } catch (e) { }
  }
  out.stylesheetRulesMentioningFade = transparencyRules;
  out.frameBg = (() => { const f = document.querySelector('[class*="BynINW_frame"]'); return f ? getComputedStyle(f).backgroundColor : null; })();
  out.htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const sideEl = document.querySelector('.BynINW_sidebarCol');
  out.sidebarBg = sideEl ? getComputedStyle(sideEl).backgroundColor : null;
  // The fade we hid has display:none, so its own rect is 0x0 and cannot be used to
  // locate the band in a screenshot. Use the session list's box instead: that keeps the
  // measurement correct at any window size (the window was resized twice during the fix).
  const treeBody = document.querySelector('[class*="_9lTDKa_treeBody"]');
  const box = treeBody || sideEl;
  if (box) {
    const r = box.getBoundingClientRect();
    out.band = {
      x: r.left + 12,
      y: r.bottom - 24,
      w: Math.max(40, r.width - 24),
      h: 24,
      source: treeBody ? '_9lTDKa_treeBody' : 'sidebarCol',
    };
  }
  out.verdict = (out.fadeCount > 0 && out.fades.every((f) => f.removed)) ? 'BLACK BAR REMOVED (fade display:none from the installed patch)' : 'STILL PRESENT';
  return JSON.stringify(out, null, 1);
})()
