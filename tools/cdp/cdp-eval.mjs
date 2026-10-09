#!/usr/bin/env node
/**
 * cdp-eval.mjs — evaluate an expression in the live DSH page over the Chrome
 * DevTools Protocol and write the result to a log. Read-only: it evaluates one
 * expression and never mutates the page.
 *
 * Usage: node cdp-eval.mjs <outLog> [port] [expressionFile]
 *   Without an expression file a built-in transparency report is used.
 */

import fs from 'node:fs'

const [outLog, portArg, exprFile] = process.argv.slice(2)
const port = Number(portArg) || 9222

const defaultExpression = `(() => {
  const out = {};
  out.platform = document.documentElement.dataset.platform || null;
  out.windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar');
  out.dataset = JSON.stringify(document.documentElement.dataset);
  const frame = document.querySelector('[class*="BynINW_frame"]');
  out.hasFrame = !!frame;
  out.frameClass = frame ? frame.className : null;
  if (frame) {
    const cs = getComputedStyle(frame);
    out.frameBackground = cs.background;
    out.frameBgColor = cs.backgroundColor;
    out.frameOutline = cs.outlineColor + ' / ' + cs.outlineWidth;
    out.frameBackdrop = cs.backdropFilter;
  }
  out.bodyBg = getComputedStyle(document.body).backgroundColor;
  out.htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const center = document.querySelector('[class*="BynINW_centerCol"]');
  out.centerBg = center ? getComputedStyle(center).backgroundColor : null;
  const side = document.querySelector('[class*="BynINW_sidebarCol"]');
  out.sidebarBg = side ? getComputedStyle(side).backgroundColor : null;
  const styles = [...document.querySelectorAll('style')];
  out.totalStyleTags = styles.length;
  out.styleTagsWithBynINW = styles.filter((s) => (s.textContent || '').includes('BynINW_frame')).length;
  // The patch injects its stylesheet from the main process (webContents.insertCSS), so it
  // arrives as a sheet without a <style> tag: count the sheets carrying our selectors.
  out.sheetsWithPatchRules = [...document.styleSheets].filter((sheet) => {
    try { return [...sheet.cssRules].some((rule) => String(rule.cssText).includes('Dc7zOa_root')) } catch { return false }
  }).length;
  out.injectedSheetCount = document.styleSheets.length;
  let myRules = 0;
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.cssText && rule.cssText.includes('BynINW_frame')) myRules += 1;
      }
    } catch (e) {}
  }
  out.rulesMentioningFrame = myRules;
  // which element actually paints an opaque surface at the top of the stack?
  const probe = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
  out.probeTag = probe ? probe.tagName + '.' + (typeof probe.className === 'string' ? probe.className : '') : null;
  const chain = [];
  let el = probe;
  while (el && chain.length < 8) {
    const cs = getComputedStyle(el);
    chain.push(el.tagName + ' bg=' + cs.backgroundColor + ' bgi=' + (cs.backgroundImage === 'none' ? 'none' : 'img'));
    el = el.parentElement;
  }
  out.paintChain = chain;
  return JSON.stringify(out, null, 1);
})()`

const expression = exprFile ? fs.readFileSync(exprFile, 'utf8') : defaultExpression
const out = []
const say = (s) => { out.push(s); fs.writeFileSync(outLog, out.join('\n'), 'utf8') }

try {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  say(`target: ${page.title} ${page.url}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error(`websocket error: ${e.message || 'unknown'}`)), { once: true })
    setTimeout(() => reject(new Error('websocket open timeout')), 8000)
  })
  say('websocket: connected')

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP reply timeout')), 15000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== 1) return
      clearTimeout(timer)
      resolve(msg)
    })
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
  })

  if (reply.result?.exceptionDetails) {
    say(`page exception: ${JSON.stringify(reply.result.exceptionDetails).slice(0, 400)}`)
  } else {
    say('value:')
    say(String(reply.result?.result?.value ?? '(no value)'))
  }
  ws.close()
} catch (error) {
  say(`FAILED: ${error.message}`)
  process.exitCode = 1
}
