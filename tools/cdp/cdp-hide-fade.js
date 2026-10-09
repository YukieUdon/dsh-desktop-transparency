(() => {
  const before = [];
  for (const el of document.querySelectorAll('[class*="_9lTDKa_fade"]')) {
    const r = el.getBoundingClientRect();
    before.push({ rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], bgi: getComputedStyle(el).backgroundImage });
  }
  document.querySelectorAll('[class*="_9lTDKa_fade"]').forEach((el) => { el.style.setProperty('display', 'none', 'important'); });
  return JSON.stringify({ found: before.length, before }, null, 1);
})()
