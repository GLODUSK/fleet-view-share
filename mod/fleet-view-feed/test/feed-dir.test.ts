import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Where the feed goes on each platform: the test stands for the engine beneath the mod, answering its env.get and
// fs.exists from a fake machine and keeping what it writes. Fleet View (platform.js dataDir()) reads the same folder.

type Machine = { env: Record<string, string>; dirs?: string[] }

// the engine resolves a path against the host it runs on, so on a Windows host /Users/h reaches the hooks as
// Z:\Users\h: a Unix path is compared with that taken off
const unix = (p: string) => p.replace(/^[A-Za-z]:(?=\\)/, '').replace(/\\/g, '/')

async function writes(m: Machine, $: Engine, on: On) {
  const out: string[] = []
  on('env.get', async (_$, e) => ({ value: m.env[e.name] }))
  on('fs.exists', async (_$, e) => ({ value: (m.dirs || []).includes(unix(e.path)) }))
  on('fs.write', async (_$, e) => { out.push(e.path); return { value: undefined } })
  on('session.id', async () => ({ value: 'abc' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // the write runs behind the turn on the mod's own chain
  for (let i = 0; i < 20 && !out.length; i++) await new Promise(r => setTimeout(r, 5))
  return out
}

describe('feed folder', () => {
  test('Windows: LOCALAPPDATA', async ($, on) => {
    const w = await writes({ env: { LOCALAPPDATA: 'C:\\Users\\h\\AppData\\Local', USERPROFILE: 'C:\\Users\\h', HOME: '/c/Users/h' } }, $, on)
    expect(w).toEqual(['C:\\Users\\h\\AppData\\Local\\fleet-view\\live\\abc.json'])
  })

  test('Windows without LOCALAPPDATA: USERPROFILE\\AppData\\Local', async ($, on) => {
    const w = await writes({ env: { USERPROFILE: 'C:\\Users\\h\\' } }, $, on)
    expect(w).toEqual(['C:\\Users\\h\\AppData\\Local\\fleet-view\\live\\abc.json'])
  })

  test('macOS: ~/Library/Application Support', async ($, on) => {
    const w = await writes({ env: { HOME: '/Users/h' }, dirs: ['/Users/h/Library/Application Support'] }, $, on)
    expect(w.map(unix)).toEqual(['/Users/h/Library/Application Support/fleet-view/live/abc.json'])
  })

  test('Linux: XDG_STATE_HOME when absolute', async ($, on) => {
    const w = await writes({ env: { HOME: '/home/h', XDG_STATE_HOME: '/var/state/h' } }, $, on)
    expect(w.map(unix)).toEqual(['/var/state/h/fleet-view/live/abc.json'])
  })

  test('Linux: ~/.local/state when XDG_STATE_HOME is relative or unset', async ($, on) => {
    const w = await writes({ env: { HOME: '/home/h/', XDG_STATE_HOME: 'state' } }, $, on)
    expect(w.map(unix)).toEqual(['/home/h/.local/state/fleet-view/live/abc.json'])
  })

  test('nothing absolute: nothing written', async ($, on) => {
    const w = await writes({ env: { LOCALAPPDATA: '', USERPROFILE: 'relative', HOME: '' } }, $, on)
    expect(w).toEqual([])
  })
})
