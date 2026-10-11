import { describe, expect, mock, test } from 'claude-code/testing'

import type { PunchBook } from '../types'
import { bandSvg } from '../hooks/draw'
import {
  addItem,
  clearDone,
  emptyBook,
  groupByTag,
  listText,
  markDone,
  openItems,
  parseAddArgs,
  parseBook,
  parseIds,
  parseWhen,
  reopen,
  secretReason,
  serializeBook,
  snooze,
  statusAt,
  summarize,
  updateItem,
} from '../hooks/list'

const T0 = Date.parse('2026-10-11T18:00:00Z')
const H = 3_600_000
const D = 24 * H

const book = (...texts: [string, string?][]): PunchBook =>
  texts.reduce((b, [text, tag], n) => addItem(b, { text, ...(tag ? { tag } : {}) }, T0 + n * 1000).book, emptyBook())

describe('the list', () => {
  test('adds with stable numbers and folds a repeat into the first', () => {
    let b = book(['Tick the governance boxes on #199', 'pr'], ['Rotate the Sonarr API key', 'security'])
    expect(b.items.map(i => [i.id, i.tag])).toEqual([
      [1, 'pr'],
      [2, 'security'],
    ])
    const again = addItem(b, { text: 'rotate the sonarr API key!', link: 'https://example.com/sonarr' }, T0 + H)
    expect(again.message).toContain('already on the list as #2')
    expect(again.book.items.length).toBe(2)
    expect(again.book.items[1]?.link).toBe('https://example.com/sonarr')
    b = markDone(again.book, [1], T0 + 2 * H).book
    // A done item no longer swallows a new report of the same thing.
    const fresh = addItem(b, { text: 'Tick the governance boxes on #199' }, T0 + 3 * H)
    expect(fresh.message).toBe('added #3')
  })

  test('done, reopen, snooze and clear-done', () => {
    let b = book(['A'], ['B'], ['C'])
    const d = markDone(b, [1, 1, 9], T0 + H)
    expect(d.message).toBe('done: #1; already done: #1; no such item: #9')
    b = d.book
    expect(markDone(b, [1], T0).message).toBe('already done: #1')
    b = snooze(b, 2, T0 + 2 * H, T0 + H).book
    expect(statusAt(b.items[1]!, T0 + H)).toBe('snoozed')
    expect(statusAt(b.items[1]!, T0 + 3 * H)).toBe('open')
    expect(openItems(b.items, T0 + H).map(i => i.id)).toEqual([3])
    b = reopen(b, 1, T0 + H).book
    expect(b.items[0]?.status).toBe('open')
    expect(b.items[0]?.doneAt).toBeUndefined()
    b = markDone(b, [3], T0 + H).book
    const c = clearDone(b)
    expect(c.book.items.map(i => i.id)).toEqual([1, 2])
    // Numbers are never handed out twice.
    expect(addItem(c.book, { text: 'D' }, T0 + 4 * H).message).toBe('added #4')
  })

  test('urgent items lead, then due dates, then the oldest', () => {
    let b = book(['Set up an NPM proxy host', 'setup'], ['Approve the fork deploy', 'approve'], ['Recable the NetApp shelves', 'downtime'])
    b = updateItem(b, 3, { due: '2026-10-12T12:00:00Z' }, T0).book
    expect(openItems(b.items, T0).map(i => i.id)).toEqual([2, 3, 1])
    // Overdue counts as urgent, and among urgent items the one with a date leads.
    expect(openItems(b.items, Date.parse('2026-10-13T00:00:00Z')).map(i => i.id)).toEqual([3, 2, 1])
    const s = summarize(b.items, T0)
    expect([s.open, s.urgent, s.top.length]).toEqual([3, 1, 3])
    expect(groupByTag(b.items).map(([t]) => t)).toEqual(['approve', 'setup', 'downtime'])
  })

  test('secret values are refused in any field', () => {
    for (const v of [
      'key is 0123456789abcdef0123456789abcdef',
      'api_key=hunter2hunter2',
      'use ghp_abcdefghijklmnopqrstuvwxyz0123',
      'sk-ant-abcdefghijklmnopqrstuvwx',
      'https://admin:pa55word@10.2.6.2:81/',
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
      'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f',
    ])
      expect(secretReason(v)).not.toBe(null)
    for (const v of [
      'Rotate the Radarr and Sonarr API keys exposed in the Prismarr setup transcript',
      'https://github.com/davidcoulson/ha-unraid-management-agent/commit/03941dd0c4a1b2e3f4a5b6c7d8e9f0a1b2c3d4e5',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Session #local_c9d45d4a-fbf7-44d3-ad44-0ce4b5db1605',
      'Set CLAUDE_CODE_PLUGIN_DIRS in env',
    ])
      expect(secretReason(v)).toBe(null)
    const r = addItem(emptyBook(), { text: 'Rotate it', detail: 'old key 0123456789abcdef0123456789abcdef' }, T0)
    expect(r.message).toContain('refused: detail')
    expect(r.book.items.length).toBe(0)
  })

  test('a damaged file is an error, a missing one is empty, and numbers survive a reload', () => {
    expect(() => parseBook('{"oops":')).toThrow()
    expect(() => parseBook('[1,2]')).toThrow()
    expect(parseBook('').items).toEqual([])
    const b = clearDone(markDone(book(['A'], ['B']), [2], T0).book).book
    const back = parseBook(serializeBook(b))
    expect(back.next).toBe(3)
    expect(back.items.map(i => i.text)).toEqual(['A'])
  })

  test('times, ids and /todo add words', () => {
    expect(parseWhen('2h', T0)).toBe(T0 + 2 * H)
    expect(parseWhen('3d', T0)).toBe(T0 + 3 * D)
    expect(parseWhen('1w', T0)).toBe(T0 + 7 * D)
    const fri = new Date(parseWhen('fri', T0) ?? 0)
    expect(fri.getDay()).toBe(5)
    expect(fri.getTime()).toBeGreaterThan(T0)
    expect(new Date(parseWhen('tomorrow', T0) ?? 0).getHours()).toBe(9)
    expect(parseWhen('someday', T0)).toBe(null)
    expect(parseIds(['#3', '4,5', 'x'])).toEqual([3, 4, 5])
    const a = parseAddArgs(' #security Rotate the Sonarr key due:2026-10-20 ', T0)
    expect(a).toEqual({ text: 'Rotate the Sonarr key', tag: 'security', due: '2026-10-20' })
    // A PR number is words, not a tag.
    expect(parseAddArgs('Tick boxes on #199', T0)).toEqual({ text: 'Tick boxes on #199' })
  })

  test('the text list groups by tag and carries links', () => {
    let b = book(['Rotate the Sonarr key', 'security'], ['Tick boxes', 'pr'])
    b = updateItem(b, 2, { link: 'https://github.com/x/y/pull/1' }, T0).book
    const t = listText(b.items, T0 + H, {}, true)
    expect(t).toContain('2 open, 1 need you first')
    expect(t.indexOf('security:')).toBeLessThan(t.indexOf('pr:'))
    expect(t).toContain('https://github.com/x/y/pull/1')
    expect(listText([], T0)).toBe('Nothing waiting on you.')
  })

  test('the band drawing names the count and the urgent items', () => {
    const b = book(['Approve the deploy', 'approve'], ['Set up the proxy host', 'setup'])
    const svg = bandSvg(900, summarize(b.items, T0), T0)
    expect(svg).toContain('2 to do')
    expect(svg).toContain('1 need you')
    expect(svg).toContain('Approve the deploy')
  })
})

// ---------------------------------------------------------------------------
// The mod in a session, over an in-memory file system and fake mkdir/mv/rmdir.

type Disk = { files: Map<string, { text: string; mtimeMs: number }>; dirs: Map<string, number>; tick: number }

const host = (on: Parameters<typeof mock.clock>[0], disk: Disk) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  mock.env(on, { HOME: '/home/t' })
  const touch = () => (disk.tick += 1000)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.id', () => ({ value: 'cli-session-1' }))
  on('session.cwd', () => ({ value: '/home/t/dev' }))
  on('mcp.call', () => ({ deny: 'no app here' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__punch-list__${e.name}` } }))
  on('fs.exists', (_$, e) => ({ value: disk.files.has(e.path) || disk.dirs.has(e.path) }))
  on('fs.read', (_$, e) => {
    const f = disk.files.get(e.path)
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    disk.files.set(e.path, { text: e.text, mtimeMs: touch() })
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    const f = disk.files.get(e.path)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    const d = disk.dirs.get(e.path)
    if (d !== undefined) return { value: { kind: 'dir', size: 0, mtimeMs: d, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === '/bin/mkdir') {
      const p = args.filter(a => a !== '-p')
      const path = p[0] ?? ''
      if (args.includes('-p')) {
        disk.dirs.set(path, T0)
        return { value: ok }
      }
      if (disk.dirs.has(path)) return { value: { ...ok, exitCode: 1, stderr: `mkdir: ${path}: File exists` } }
      if (!disk.dirs.has(path.slice(0, path.lastIndexOf('/')))) return { value: { ...ok, exitCode: 1, stderr: `mkdir: ${path}: No such file or directory` } }
      disk.dirs.set(path, disk.tick)
      return { value: ok }
    }
    if (cmd === '/bin/rmdir') {
      disk.dirs.delete(args[0] ?? '')
      return { value: ok }
    }
    if (cmd === '/bin/mv') {
      const [, from = '', to = ''] = args
      const f = disk.files.get(from)
      if (!f) return { value: { ...ok, exitCode: 1, stderr: 'mv: no such file' } }
      disk.files.delete(from)
      disk.files.set(to, { ...f, mtimeMs: touch() })
      return { value: ok }
    }
    return { value: { ...ok, exitCode: 127, stderr: 'unknown' } }
  })
  return clock
}

const FILE = '/home/t/.claude/punch-list.json'
const newDisk = (): Disk => ({ files: new Map(), dirs: new Map([['/home/t/.claude', 0]]), tick: T0 })
const bandProps = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { bodyRows: 9, offset: 0, total: 0 } }
const onDisk = (d: Disk): PunchBook => JSON.parse(d.files.get(FILE)?.text ?? '{}') as PunchBook

describe('the mod', () => {
  test('the tools write the shared file under a lock and never leave the lock behind', { options: { pollSeconds: 0 } }, async ($, on) => {
    const disk = newDisk()
    host(on, disk)
    await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
    const added = await $.tool.call({ tool: 'mcp__punch-list__add', text: 'Rotate the Sonarr API key', tag: 'security', link: '#local_9893fb58' } as never)
    expect(String(added.result)).toBe('added #1')
    const item = onDisk(disk).items[0]
    expect(item?.tag).toBe('security')
    expect(item?.source).toEqual({ session: 'cli-session-1', cwd: '/home/t/dev' })
    expect(disk.dirs.has(`${FILE}.lock`)).toBe(false)
    expect([...disk.files.keys()]).toEqual([FILE])

    const secret = await $.tool.call({ tool: 'mcp__punch-list__add', text: 'Rotate it', detail: 'apikey=abcdef123456' } as never)
    expect(String(secret.result)).toContain('refused')
    expect(onDisk(disk).items.length).toBe(1)

    const done = await $.tool.call({ tool: 'mcp__punch-list__done', ids: [1], note: 'user confirmed' } as never)
    expect(String(done.result)).toBe('done: #1')
    expect(onDisk(disk).items[0]?.status).toBe('done')
    const listed = await $.tool.call({ tool: 'mcp__punch-list__list', status: 'all' } as never)
    expect(String(listed.result)).toContain('✓ #1 Rotate the Sonarr API key')
  })

  test('a lock held by a live session is waited for; a stale one is broken', { options: { pollSeconds: 0 } }, async ($, on) => {
    const disk = newDisk()
    const clock = host(on, disk)
    await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
    // A lock left 20 s ago by a session that died.
    disk.dirs.set(`${FILE}.lock`, T0 - 20_000)
    const r = await $.tool.call({ tool: 'mcp__punch-list__add', text: 'Set up an NPM proxy host' } as never)
    expect(String(r.result)).toBe('added #1')
    // A fresh lock: the add waits, and goes through once the other session lets go.
    disk.dirs.set(`${FILE}.lock`, T0)
    const pending = $.tool.call({ tool: 'mcp__punch-list__add', text: 'HPT firmware' } as never)
    await clock.advance(200)
    expect(onDisk(disk).items.length).toBe(1)
    disk.dirs.delete(`${FILE}.lock`)
    await clock.advance(200)
    expect(String((await pending).result)).toBe('added #2')
  })

  test('a damaged file is reported and never written over', { options: { pollSeconds: 0 } }, async ($, on) => {
    const disk = newDisk()
    disk.files.set(FILE, { text: '{"items": [', mtimeMs: T0 })
    host(on, disk)
    await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
    const r = await $.tool.call({ tool: 'mcp__punch-list__add', text: 'Anything' } as never)
    expect(String(r.result)).toContain('damaged')
    expect(disk.files.get(FILE)?.text).toBe('{"items": [')
    expect(disk.dirs.has(`${FILE}.lock`)).toBe(false)
  })

  test('another session\'s change shows up on the next poll', { options: { pollSeconds: 5 } }, async ($, on) => {
    const disk = newDisk()
    const clock = host(on, disk)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
    const other = addItem(emptyBook(), { text: 'Approve the fork deploy', tag: 'approve' }, T0).book
    disk.files.set(FILE, { text: serializeBook(other), mtimeMs: T0 + 50_000 })
    await clock.advance(5_000)
    const ui = await $.ui.mount({ plugin: 'punch-list', surface: 'terminal', component: 'AbovePrompt', props: bandProps } as never)
    expect(await ui.find({ type: 'Text', text: /1 to do/ })).toBeDefined()
    await ui.unmount()
  })

  test('the band stacks above other bands on each surface and hides when empty or off', { options: { pollSeconds: 0 } }, async ($, on) => {
    const disk = newDisk()
    host(on, disk)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['crab strip'] }) as never)
    await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
    let ui = await $.ui.mount({ plugin: 'punch-list', surface: 'desktop', component: 'AbovePrompt', props: bandProps } as never)
    expect(await ui.find({ type: 'Button', key: 'punch-list-open' })).toBeUndefined()
    await ui.unmount()
    await $.command.run({ command: 'todo', args: 'add #approve Approve the fork deploy' } as never)
    await $.command.run({ command: 'todo', args: 'add Recable the NetApp shelves #downtime' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      ui = await $.ui.mount({ plugin: 'punch-list', surface, component: 'AbovePrompt', props: bandProps } as never)
      expect(await ui.find({ type: 'Text', text: 'crab strip' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'punch-list-open' })).toBeDefined()
      if (surface === 'desktop') expect(String((await ui.find({ type: 'Svg' }))?.props.alt)).toContain('2 to do, 1 need you first: Approve the fork deploy')
      else expect(await ui.find({ type: 'Text', text: /2 to do/ })).toBeDefined()
      await ui.unmount()
    }
    expect((await $.command.run({ command: 'todo', args: 'band off' } as never)).text).toContain('off')
    ui = await $.ui.mount({ plugin: 'punch-list', surface: 'desktop', component: 'AbovePrompt', props: bandProps } as never)
    expect(await ui.find({ type: 'Button', key: 'punch-list-open' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'crab strip' })).toBeDefined()
    await ui.unmount()
  })

  test('/todo commands and the panel\'s buttons', { options: { pollSeconds: 0 } }, async ($, on) => {
    const disk = newDisk()
    host(on, disk)
    await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
    expect((await $.command.run({ command: 'todo', args: 'add #security Rotate the Radarr key due:2026-10-20' } as never)).text).toBe('added #1')
    expect((await $.command.run({ command: 'todo', args: 'add BMC cold-boot test #downtime' } as never)).text).toBe('added #2')
    expect((await $.command.run({ command: 'todo', args: 'snooze 2 3d' } as never)).text).toContain('snoozed #2 until')
    expect((await $.command.run({ command: 'todo', args: 'snooze 2 whenever' } as never)).text).toContain('Usage')
    expect((await $.command.run({ command: 'todo', args: 'list' } as never)).text).toContain('1 open, 1 need you first, 1 snoozed')
    expect((await $.command.run({ command: 'todo', args: 'path' } as never)).text).toBe(FILE)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'punch-list',
        surface,
        component: 'Pane',
        requestId: 'punch-list',
        props: { title: 'Punch list', isFocused: false, bodyColumns: 60, placement: 'dock' },
      } as never)
      expect(await ui.find({ type: 'Text', text: /SECURITY · 1/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'reopen-2' })).toBeDefined()
      if (surface === 'desktop') {
        await ui.press({ key: 'done-1' })
        expect(onDisk(disk).items[0]?.status).toBe('done')
        await ui.press({ key: 'reopen-2' })
        expect(onDisk(disk).items[1]?.status).toBe('open')
        await (ui as unknown as { input: (t: { key: string; text: string }) => Promise<unknown> }).input({ key: 'add', text: 'Maybe DIMM water blocks #downtime' })
        expect(onDisk(disk).items[2]).toEqual(expect.objectContaining({ id: 3, tag: 'downtime', text: 'Maybe DIMM water blocks' }))
      }
      await ui.unmount()
    }
    expect((await $.command.run({ command: 'todo', args: 'done 2 3' } as never)).text).toBe('done: #2, #3')
    expect((await $.command.run({ command: 'todo', args: 'clear-done' } as never)).text).toBe('cleared 3 done')
    expect(onDisk(disk).items).toEqual([])
    expect(onDisk(disk).next).toBe(4)
  })
})
