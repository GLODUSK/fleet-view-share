import type { EngineInterface, Register } from 'claude-code'

// Fleet View's live feed. Fleet View reads each session's state from its log and from Claude Code's
// sessions/<pid>.json, and has to guess whether a turn is still open: a turn that went quiet for 5 minutes
// may be a long command or a stuck one (STALLED?). This mod knows. On every turn start and end and every
// tool call it writes <Fleet View's folder>/live/<sessionId>.json (feedDir below), which Fleet View reads with the
// pid files. The file is the whole state each time, so a missed write is healed by the next one.
// Bump .claude-plugin/plugin.json's version with every change here: each Claude login keeps its own copy of this
// mod, and Fleet View (feed-mod.js) refreshes those copies only when the version differs.

const VERSION = 1

type Running = { id: string; tool: string; what: string; agent: string | null; at: number }

// what the session is doing now; the module's variables start over on a reload, as the process does
const loadedAt = Date.now()
let turnOpen = false
let turnAt = 0
let lastTurn: { reason: string; at: number; ms: number } | null = null
const running = new Map<string, Running>()
let seq = 0

// a turn's start and end are the main loop's: a background subagent's calls run on past them
const clearMain = () => { for (const [id, r] of running) if (!r.agent) running.delete(id) }

// one line on what a tool call does, from its arguments: the command, the file, the pattern
const whatOf = (e: Record<string, unknown>): string => {
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const v = e[k]
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 160)
  }
  return ''
}

// Fleet View's folder, as platform.js dataDir() picks it, + live: %LOCALAPPDATA%\fleet-view\live on Windows,
// ~/Library/Application Support/fleet-view/live on macOS, ${XDG_STATE_HOME:-~/.local/state}/fleet-view/live
// elsewhere. There is no platform call here: Windows is told by its variables, macOS by its Library folder. null
// when nothing gives an absolute folder, as a relative one would land in the session's working directory
const winAbs = (p?: string): p is string => !!p && /^([A-Za-z]:[\\/]|\\\\)/.test(p)
const trim = (p: string) => p.replace(/[\\/]+$/, '')
async function feedDir($: EngineInterface): Promise<string | null> {
  const local = await $.env.get('LOCALAPPDATA')
  if (winAbs(local)) return `${trim(local)}\\fleet-view\\live`
  const profile = await $.env.get('USERPROFILE')
  if (winAbs(profile)) return `${trim(profile)}\\AppData\\Local\\fleet-view\\live`
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) return null
  const h = trim(home)
  if (await $.fs.exists(`${h}/Library/Application Support`)) return `${h}/Library/Application Support/fleet-view/live`
  const state = await $.env.get('XDG_STATE_HOME')
  return `${state && state.startsWith('/') ? trim(state) : `${h}/.local/state`}/fleet-view/live`
}

let dir: string | null | undefined // undefined until looked up once; null: nowhere to write
let chain: Promise<void> = Promise.resolve()

// writes in order, one at a time; a failed write (a full disk, a locked file) never touches the session
function publish($: EngineInterface) {
  const n = ++seq
  chain = chain.then(async () => {
    if (n !== seq) return // a newer state is queued behind this one: write that instead
    try {
      if (dir === undefined) dir = await feedDir($)
      if (!dir) return
      const sessionId = await $.session.id()
      const tools = [...running.values()]
      await $.fs.write(`${dir}${dir.startsWith('/') ? '/' : '\\'}${sessionId}.json`, JSON.stringify({
        v: VERSION, sessionId, loadedAt, at: Date.now(),
        turnOpen, turnAt: turnOpen ? turnAt : null, lastTurn,
        tools: tools.slice(-8),
      }))
    } catch {}
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    publish($)
    return r
  })

  on('turn.start', async ($, e, next) => {
    turnOpen = true
    turnAt = Date.now()
    clearMain()
    publish($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    turnOpen = false
    lastTurn = { reason: e.reason, at: Date.now(), ms: e.durationMs }
    clearMain()
    publish($)
    return next(e)
  })

  // the tool runs inside next(): it is running from here until next settles (a permission prompt included,
  // which sessions/<pid>.json reports as waiting)
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id || `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    running.set(id, { id, tool: String(e.tool), what: whatOf(e as unknown as Record<string, unknown>), agent: e.agentId || null, at: Date.now() })
    publish($)
    try {
      return await next(e)
    } finally {
      running.delete(id)
      publish($)
    }
  })

  on('session.end', async ($, e, next) => {
    turnOpen = false
    running.clear()
    publish($)
    await chain
    return next(e)
  })
}
