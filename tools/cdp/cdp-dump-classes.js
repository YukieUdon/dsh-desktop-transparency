(() => {
  const list = new Set();
  document.querySelectorAll('[class]').forEach((el) => {
    String(el.className).split(/\s+/).forEach((c) => { if (c) list.add(c); });
  });
  return JSON.stringify({ live: [...list] }, null, 1);
})()
