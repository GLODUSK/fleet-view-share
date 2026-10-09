import type { EngineInterface, Register } from 'claude-code'

// Fleet View's live feed. Fleet View reads each session's state from its log and from Claude Code's
// sessions/<pid>.json, and has to guess whether a turn is still open: a turn that went quiet for 5 minutes
// may be a long command or a stuck one (STALLED?). This mod knows. On every turn start and end and every
// tool call it writes %LOCALAPPDATA%\fleet-view\live\<sessionId>.json, which Fleet View reads with the pid
// files. The file is the whole state each time, so a missed write is healed by the next one.

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

let dir: string | null = null
let chain: Promise<void> = Promise.resolve()

// writes in order, one at a time; a failed write (a full disk, a locked file) never touches the session
function publish($: EngineInterface) {
  const n = ++seq
  chain = chain.then(async () => {
    if (n !== seq) return // a newer state is queued behind this one: write that instead
    try {
      if (!dir) {
        const local = (await $.env.get('LOCALAPPDATA')) || `${(await $.env.get('USERPROFILE')) || ''}\\AppData\\Local`
        dir = `${local}\\fleet-view\\live`
      }
      const sessionId = await $.session.id()
      const tools = [...running.values()]
      await $.fs.write(`${dir}\\${sessionId}.json`, JSON.stringify({
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
