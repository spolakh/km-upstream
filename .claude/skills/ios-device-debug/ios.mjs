// WebKit Remote Inspector client for the live iPad via ios-webkit-debug-proxy.
// iOS uses the MULTI-TARGET protocol: the JS context lives in a Target, so
// every command is wrapped in Target.sendMessageToTarget and replies arrive as
// Target.dispatchMessageFromTarget. Auto-discovers the app tab each run.
//
//   node ios.mjs eval '<js expression or async IIFE>'
//   node ios.mjs console <seconds>
//   node ios.mjs pages
const LIST = process.env.IWDP || 'http://localhost:9221'
const MATCH = process.env.MATCH || 'ts.net'

// Fail loud, not with a stack trace: proxy down, no device, etc. all land here.
process.on('unhandledRejection', e => { console.error('ios.mjs:', e?.message || e); process.exit(1) })

async function findPage() {
  const dev = (await (await fetch(LIST + '/json')).json())[0]
  if (!dev) throw new Error('no device (is the proxy up / iPad connected?)')
  const pages = await (await fetch('http://' + dev.url + '/json')).json()
  // A page and its ServiceWorker share a URL; the SW is never the JS app context
  // we want to eval in (and connecting to it hangs with "no target announced").
  // PAGE_INDEX picks among multiple page matches (e.g. a live PWA + a stale tab).
  const matches = pages.filter(p => (p.url || '').includes(MATCH) && p.title !== 'ServiceWorker')
  const pick = process.env.PAGE_INDEX ? Number(process.env.PAGE_INDEX) : 0
  // Fall back to the first PAGE match on an out-of-range PAGE_INDEX; only reach
  // for a raw URL match (which could be the SW) when no page matched at all.
  return { pages, page: matches[pick] || matches[0] || pages.find(p => (p.url || '').includes(MATCH)) }
}

function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let outerId = 0, innerId = 0
  const innerPending = new Map()
  const innerListeners = []
  let target = null
  let resolveTarget
  const targetReady = new Promise(r => (resolveTarget = r))

  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Target.targetCreated') {
      const ti = m.params.targetInfo
      if (!target || ti.type === 'page') { target = ti; resolveTarget(ti) }
    } else if (m.method === 'Target.dispatchMessageFromTarget') {
      const inner = JSON.parse(m.params.message)
      if (inner.id && innerPending.has(inner.id)) { innerPending.get(inner.id)(inner); innerPending.delete(inner.id) }
      else if (inner.method) innerListeners.forEach(l => l(inner))
    }
  })

  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })

  const send = async (method, params = {}) => {
    await targetReady
    const id = ++innerId
    const inner = await new Promise(res => {
      innerPending.set(id, res)
      ws.send(JSON.stringify({
        id: ++outerId, method: 'Target.sendMessageToTarget',
        params: { targetId: target.targetId, message: JSON.stringify({ id, method, params }) },
      }))
    })
    // Protocol-level failures (bad params, "domain not found", …) come back as
    // {id, error} with no result — surface them instead of silently returning {}.
    if (inner.error) { console.error(`PROTOCOL ERROR (${method}):`, JSON.stringify(inner.error)); process.exit(2) }
    return inner
  }
  open.then(() => {
    // Resolve with whatever target arrived (frame if no page target showed up).
    setTimeout(() => target && resolveTarget(target), 1500)
    // If NONE arrived, the tab is backgrounded/asleep — fail loud, don't hang.
    setTimeout(() => {
      if (!target) { console.error('no inspector target announced — is the app tab foreground and the device awake?'); process.exit(1) }
    }, 6000)
  })
  return { ws, open, send, onInner: l => innerListeners.push(l), targetReady }
}

const [mode, arg] = process.argv.slice(2)
const { pages, page } = await findPage()

if (mode === 'pages') { for (const p of pages) console.log((p.url || '(no url)')); process.exit(0) }
if (!page) { console.error(`no tab matching "${MATCH}" (${pages.length} tabs). Foreground the app tab on the iPad.`); process.exit(1) }

const s = session(page.webSocketDebuggerUrl)
await s.open
await s.targetReady
await s.send('Runtime.enable')

if (mode === 'eval') {
  // iOS WebKit ignores inline awaitPromise. Wrap in Promise.resolve(...) so sync
  // and async exprs both yield a promise objectId, then Runtime.awaitPromise it.
  const ev = (await s.send('Runtime.evaluate', { expression: `Promise.resolve((${arg}))`, returnByValue: false, includeCommandLineAPI: true })).result || {}
  if (ev.wasThrown) { console.error('THREW (eval):', JSON.stringify(ev.result, null, 2)); process.exit(2) }
  let v = ev.result || {}
  if (v.objectId) {
    const aw = (await s.send('Runtime.awaitPromise', { promiseObjectId: v.objectId, returnByValue: true })).result || {}
    if (aw.wasThrown) { console.error('REJECTED:', JSON.stringify(aw.result, null, 2)); process.exit(2) }
    v = aw.result || {}
  }
  console.log('value' in v ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2)) : JSON.stringify(v, null, 2))
  process.exit(0)
}

if (mode === 'console') {
  await s.send('Console.enable')
  s.onInner(m => {
    if (m.method === 'Console.messageAdded') {
      const x = m.params.message
      console.log(`[${x.level}] ${x.text}` + (x.url ? `  (${(x.url || '').split('/').pop()}:${x.line || '?'})` : ''))
    }
  })
  const secs = Number(arg) || 12
  console.error(`— capturing console ${secs}s; reproduce the bug on the iPad now —`)
  setTimeout(() => process.exit(0), secs * 1000)
} else { console.error('usage: node ios.mjs eval <js> | console <seconds> | pages'); process.exit(1) }
