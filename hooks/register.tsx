import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PunchBook, PunchItem, PunchSource } from '../types'
import { ACCENT, BAND_H, URGENT_COLOR, bandSvg, bandWords, svgWidth, terminalTop } from './draw'
import {
  addItem,
  ageLabel,
  clearDone,
  dueLabel,
  emptyBook,
  groupByTag,
  isUrgent,
  listText,
  markDone,
  parseAddArgs,
  parseBook,
  parseDue,
  parseIds,
  parseWhen,
  reopen,
  serializeBook,
  snooze,
  statusAt,
  summarize,
  updateItem,
  whenLabel,
} from './list'
import type { Change, ListFilter, Patch } from './list'

const items = atom({ plugin: 'punch-list', key: 'items' } as const, [])
const revision = atom({ plugin: 'punch-list', key: 'revision' } as const, '')
const error = atom({ plugin: 'punch-list', key: 'error' } as const, null)
const bandOn = atom({ plugin: 'punch-list', key: 'bandOn' } as const, true)
const panel = atom({ plugin: 'punch-list', key: 'panel' } as const, { isDoneShown: false })
const now = atom({ plugin: 'punch-list', key: 'now' } as const, 0)
const self = atom({ plugin: 'punch-list', key: 'self' } as const, {})

const PANE = 'punch-list'
const TITLE = 'Punch list'
const ADD = 'mcp__punch-list__add'
const UPDATE = 'mcp__punch-list__update'
const DONE = 'mcp__punch-list__done'
const LIST = 'mcp__punch-list__list'
// The desktop app's session-management server, as session-crew reaches it.
const MGMT_SERVER = 'ccd_session_mgmt'
const STORE_BAND = 'punch-list.band'
// How many times a write re-reads and re-applies after another session wrote first.
const WRITE_TRIES = 6
// How long the commit waits for the kernel lock, in seconds; the child is killed well after.
const LOCK_WAIT_S = '10'
const COMMIT_TIMEOUT_MS = 20_000
// Temp files older than this were left by a session that died mid-write.
const LEFTOVER_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// The shared file. Reads take it as it stands; a write is compare-and-swap:
// read, apply the change, write the result beside the file, then a child
// process renames it over the file only if the file still holds what was read.
// That check-and-rename runs under a kernel lock (lockf on macOS, flock on
// Linux), which the OS releases when the child exits, so no lock is ever left
// behind or taken from a live writer. Another session's write in between makes
// the swap fail, and the change is applied again to what it wrote.

// Set by register from the `file` option; resolved once per load.
let fileOption = ''
let resolvedPath: string | null = null
// The lock command's argv up to the lock file, found once per load; [] when neither exists.
let lockCommand: string[] | null = null

async function pathOf($: EngineInterface): Promise<string> {
  if (resolvedPath) return resolvedPath
  const home = (await $.env.get('HOME')) ?? ''
  let path: string
  if (fileOption.trim()) {
    const f = fileOption.trim()
    path = f.startsWith('~/') ? `${home}${f.slice(1)}` : f
  } else {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    path = `${dir.replace(/\/+$/, '')}/punch-list.json`
  }
  if (!path.startsWith('/')) throw new Error(`the list file must be an absolute path, not ${path}`)
  resolvedPath = path
  return path
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

async function lockOf($: EngineInterface): Promise<string[]> {
  if (lockCommand) return lockCommand
  if (await $.fs.exists('/usr/bin/lockf')) lockCommand = ['/usr/bin/lockf', '-k', '-t', LOCK_WAIT_S]
  else if (await $.fs.exists('/usr/bin/flock')) lockCommand = ['/usr/bin/flock', '-w', LOCK_WAIT_S]
  else if (await $.fs.exists('/bin/flock')) lockCommand = ['/bin/flock', '-w', LOCK_WAIT_S]
  else lockCommand = []
  return lockCommand
}

/** Removes temp files a session that died mid-write left beside the list. */
async function sweepLeftovers($: EngineInterface): Promise<void> {
  try {
    const path = await pathOf($)
    const prefix = `.${baseOf(path)}.`
    const at = await $.clock.now()
    const stale = (await $.fs.list(dirOf(path)))
      .filter(f => f.kind === 'file' && f.name.startsWith(prefix) && /\.(tmp|base)$/.test(f.name) && at - f.mtimeMs > LEFTOVER_MS)
      .map(f => `${dirOf(path)}/${f.name}`)
    if (stale.length) await $.process.run(['/bin/rm', '-f', ...stale])
  } catch {
    // Nothing to sweep, or the folder isn't there yet.
  }
}

// $1 missing|present, $2 the copy of what was read, $3 the file, $4 the new text.
// Exit 3: the file changed since it was read.
const COMMIT = [
  'mode=$1 base=$2 file=$3 tmp=$4',
  'if [ "$mode" = missing ]; then [ -e "$file" ] && { rm -f "$tmp" "$base"; exit 3; }',
  'else cmp -s "$base" "$file" || { rm -f "$tmp" "$base"; exit 3; }; fi',
  'mv -f "$tmp" "$file" || { rm -f "$tmp" "$base"; exit 1; }',
  'rm -f "$base"',
].join('\n')

type Snapshot = { book: PunchBook; text: string | null }

async function readSnapshot($: EngineInterface, path: string): Promise<Snapshot> {
  if (!(await $.fs.exists(path))) return { book: emptyBook(), text: null }
  const text = await $.fs.read(path)
  try {
    return { book: parseBook(text), text }
  } catch (err) {
    throw new Error(`${path} is damaged (${err instanceof Error ? err.message : String(err)}); fix or move it. Nothing was written.`)
  }
}

/** Applies `fn` to the file's list and swaps the result in, again on a conflict. */
async function mutate($: EngineInterface, fn: (book: PunchBook, at: number) => Change): Promise<Change> {
  const path = await pathOf($)
  try {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
      const snap = await readSnapshot($, path)
      const at = await $.clock.now()
      const ch = fn(snap.book, at)
      if (ch.book === snap.book) {
        await publish($, snap.book.items, '')
        return ch
      }
      // Without a kernel lock, two sessions could both pass the check and one's rename undo the other's.
      const lock = await lockOf($)
      if (!lock.length) throw new Error("no lockf or flock on this machine, so the list can't be written safely; nothing was written.")
      const tok = `${at}-${Math.floor(Math.random() * 1e9)}`
      const tmp = `${dirOf(path)}/.${baseOf(path)}.${tok}.tmp`
      const base = `${dirOf(path)}/.${baseOf(path)}.${tok}.base`
      let code: number
      try {
        // $.fs.write makes the folder too, on a first run.
        await $.fs.write(tmp, serializeBook(ch.book))
        if (snap.text !== null) await $.fs.write(base, snap.text)
        const r = await $.process.run([...lock, `${path}.lock`, '/bin/sh', '-c', COMMIT, 'sh', snap.text === null ? 'missing' : 'present', base, path, tmp], {
          timeoutMs: COMMIT_TIMEOUT_MS,
        })
        code = r.exitCode
        if (code !== 0 && code !== 3) throw new Error(`can't write ${path}: ${(r.stderr.trim() || `exit ${code}`).slice(0, 200)}`)
      } catch (err) {
        // The commit never ran, timed out waiting for the lock, or failed: its child is gone, so its files can go.
        await $.process.run(['/bin/rm', '-f', tmp, base]).catch(() => undefined)
        throw err
      }
      if (code === 0) {
        // The file's revision is learned by the next read, never from a stat that another write may have moved.
        await publish($, ch.book.items, '')
        return ch
      }
      // Exit 3: another session wrote first; read its list and apply the change again.
    }
    throw new Error('other sessions kept changing the list; nothing was written. Try again.')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await update($, error, () => msg)
    throw err
  }
}

/** Takes a list into this session's state; `seen` is the file revision it came from, '' when unknown. */
async function publish($: EngineInterface, list: PunchItem[], seen: string): Promise<void> {
  await update($, items, () => list)
  await update($, revision, () => seen)
  await update($, error, () => null)
  await update($, now, () => Date.now())
  showStatus($, list)
}

const revOf = (st: { mtimeMs: number; size: number }): string => `${st.mtimeMs}:${st.size}`

// One read at a time: a tick and a prompt arriving together share it.
let refreshing: Promise<void> | null = null

/** Rereads the file when another session changed it. */
function refresh($: EngineInterface, force = false): Promise<void> {
  if (!refreshing) {
    refreshing = refreshNow($, force).finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

async function refreshNow($: EngineInterface, force: boolean): Promise<void> {
  try {
    const path = await pathOf($)
    const before = await $.fs.stat(path).catch(() => undefined)
    if (!before) {
      if (force || (await read($, items)).length || (await read($, error))) await publish($, [], 'missing')
      return
    }
    if (!force && revOf(before) === (await read($, revision))) return
    const snap = await readSnapshot($, path)
    const after = await $.fs.stat(path).catch(() => undefined)
    // Changed while it was read: keep what was read, but read again next time.
    const seen = after && revOf(after) === revOf(before) ? revOf(before) : ''
    await publish($, snap.book.items, seen)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  }
}

let showsStatus = true

function showStatus($: EngineInterface, list: PunchItem[]): void {
  if (!showsStatus) return
  const s = summarize(list, Date.now())
  $.ui.status(s.open ? `to-do ${s.open}${s.urgent ? ` (${s.urgent}!)` : ''}` : undefined)
}

// This session as items it adds name their source: the app's own id and title
// when its session server answers, else the CLI's session id.
async function learnSelf($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.mcp.call(MGMT_SERVER, 'get_session', { session_id: 'self' })
    if (r.isError) return false
    const text = r.content.map(b => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
    const j = JSON.parse(text) as { sessionId?: unknown; title?: unknown }
    if (typeof j.sessionId !== 'string') return false
    const title = typeof j.title === 'string' ? j.title : undefined
    await update($, self, s => ({ ...s, session: j.sessionId as string, ...(title ? { name: title } : {}) }))
    return true
  } catch {
    return false
  }
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await refresh($, true)
  await $.ui.open({ id: PANE, title: TITLE })
  return true
}

// Runs a change for a tool, a command or a button, answering in words.
async function act($: EngineInterface, fn: (book: PunchBook, at: number) => Change): Promise<string> {
  try {
    return (await mutate($, fn)).message
  } catch (err) {
    return `punch-list: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------------------------------------------------------------------------
// Tool inputs

const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function idsOf(v: unknown): number[] {
  if (typeof v === 'number') return [v]
  if (typeof v === 'string') return parseIds(v.split(/[\s,]+/))
  if (Array.isArray(v)) return v.flatMap(idsOf)
  return []
}

// A tool hook that threw still answers, so the model hears it failed.
const failed = (): { result: string } => ({ result: 'punch-list: the change failed; nothing was written. Try again.' })

const HELP = [
  '/todo                     show or hide the panel',
  '/todo list [all|done|snoozed] [#tag]',
  '/todo add <text> [#tag] [due:<when>]',
  '/todo done <n> [<n>…]',
  '/todo snooze <n> <when>   30m, 2h, 3d, 1w, tonight, tomorrow, fri, 2026-10-20',
  '/todo reopen <n>',
  '/todo clear-done',
  '/todo band on|off         the band above the prompt',
  '/todo path                where the shared file is',
].join('\n')

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  fileOption = typeof options.file === 'string' ? options.file : ''
  resolvedPath = null
  showsStatus = options.statusLine !== false
  const bandDefault = options.band !== false
  const pollMs = Math.max(0, Number(options.pollSeconds ?? 5)) * 1000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const band = await $.store.get(STORE_BAND)
    await update($, bandOn, () => (typeof band === 'boolean' ? band : bandDefault))
    const sid = await $.session.id().catch(() => '')
    const cwd = await $.session.cwd().catch(() => '')
    await update($, self, prev => ({ ...(sid ? { session: sid } : {}), ...(cwd ? { cwd } : {}), ...prev }))

    await $.command.register({
      name: 'todo',
      description: 'The punch list: things waiting on you, from every session. /todo shows it; also add, done, snooze, reopen, clear-done, list, band on|off.',
      argumentHint: '[add <text> #tag | done <n> | snooze <n> <when> | reopen <n> | clear-done | list | band on|off]',
    })

    await $.tool.register({
      name: 'add',
      isDeferred: false,
      description:
        "Put something on the user's punch list: their own to-do list of things waiting on THEM (not on you), shared by all " +
        'their Claude Code sessions and shown above their prompt. Call it every time you tell the user they need to do ' +
        "something you can't do for them: approve or confirm before work goes on, tick a box only a human may tick, rotate " +
        'or revoke a credential, a hardware or physical task, a setting only they can change, a decision you are waiting ' +
        'on, a manual step after your work. Call it in the same turn you say it, one item per action, worded as an ' +
        "instruction (\"Rotate the Sonarr API key\"). Adding the same words again is safe: it answers with the existing item. " +
        "Never put a secret's value in any field: name the secret, not its value (such input is refused). " +
        'Tags: approve (they must approve or confirm), security (exposed credential, risky config), pr (PR housekeeping), ' +
        'downtime (needs a maintenance window), setup (something to configure), or one other word.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What the user must do, as a short instruction (under ~100 characters).' },
          detail: { type: 'string', description: 'Optional: why, how, or the steps. No secret values.' },
          link: { type: 'string', description: 'Optional: a URL (PR, issue, admin page) or a session link like #local_….' },
          tag: { type: 'string', description: 'One word: approve, security, pr, downtime, setup, or another.' },
          due: { type: 'string', description: 'Optional: YYYY-MM-DD, an ISO date-time, or tomorrow / fri / 3d.' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'done',
      isDeferred: false,
      description:
        "Tick items off the user's punch list. Call it as soon as the user says they did one (\"done\", \"ticked it\", " +
        '"rotated it"), or when you verify it yourself (the PR box is ticked, the key was rotated, the setting is in ' +
        'place). When the conversation touches something that may be on the list, check with mcp__punch-list__list.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: 'Item numbers, as list shows them (#12 is 12).' },
          note: { type: 'string', description: 'Optional: how it was done or verified. No secret values.' },
        },
        required: ['ids'],
      },
    })
    await $.tool.register({
      name: 'update',
      isDeferred: false,
      description:
        "Change one item on the user's punch list: its wording, detail, link, tag or due date, or its status (open to " +
        'reopen it, done, or snoozed with snoozed_until). An empty string clears detail, link, tag or due. Use ' +
        'mcp__punch-list__list first when you do not know the item number.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' },
          detail: { type: 'string' },
          link: { type: 'string' },
          tag: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD, an ISO date-time, or tomorrow / fri / 3d; empty clears it.' },
          status: { type: 'string', enum: ['open', 'done', 'snoozed'] },
          snoozed_until: { type: 'string', description: 'When a snoozed item comes back: ISO date-time, tomorrow, fri, 3d…' },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'list',
      isDeferred: false,
      description:
        "Read the user's punch list: what is waiting on them across all their Claude Code sessions, grouped by tag, with " +
        'item numbers. Use it to tell the user what is waiting, to find a number before done or update, or to see ' +
        'whether something is already listed. Defaults to open items.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'snoozed', 'done', 'all'] },
          tag: { type: 'string' },
        },
      },
    })

    // Other sessions write the same file: look for their changes now and then.
    if (pollMs > 0) $.clock.every(pollMs, () => void refresh($))
    // Ages, due dates and snoozes move with the clock.
    $.clock.every(60_000, () => void update($, now, () => Date.now()))
    await refresh($, true)
    $.clock.after(5_000, () => void sweepLeftovers($))
    // The app's session server may still be connecting early in a session.
    $.clock.after(2_000, () => {
      void (async () => {
        if (!(await learnSelf($))) $.clock.after(15_000, () => void learnSelf($))
      })()
    })
    return started
  })

  // Each prompt is a moment the list may have moved; read it off the hook's own time.
  on('prompt.submit', async ($, e, next) => {
    $.clock.after(0, () => void refresh($))
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- the tools -------------------------------------------------------------

  on('tool.call', { tool: ADD }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const text = s(input.text)
    if (!text?.trim()) return { result: 'refused: text is required' }
    let due: string | undefined
    if (s(input.due)?.trim()) {
      const d = parseDue(String(input.due), await $.clock.now())
      if (d === null) return { result: `refused: can't read the due date "${String(input.due)}"` }
      due = d
    }
    const source: PunchSource = await read($, self)
    return {
      result: await act($, (b, at) => addItem(b, { text, detail: s(input.detail), link: s(input.link), tag: s(input.tag), due }, at, source)),
    }
  }).catch(failed)

  on('tool.call', { tool: DONE }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const ids = idsOf(input.ids ?? input.id)
    if (!ids.length) return { result: 'refused: give the item numbers in ids' }
    return { result: await act($, (b, at) => markDone(b, ids, at, s(input.note))) }
  }).catch(failed)

  on('tool.call', { tool: UPDATE }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const [id] = idsOf(input.id)
    if (id === undefined) return { result: 'refused: id is required' }
    const at = await $.clock.now()
    const patch: Patch = {}
    for (const k of ['text', 'detail', 'link', 'tag'] as const) if (s(input[k]) !== undefined) patch[k] = s(input[k])
    if (s(input.due) !== undefined) {
      const raw = String(input.due)
      if (raw.trim()) {
        const d = parseDue(raw, at)
        if (d === null) return { result: `refused: can't read the due date "${raw}"` }
        patch.due = d
      } else patch.due = ''
    }
    const st = s(input.status)
    if (st === 'open' || st === 'done' || st === 'snoozed') patch.status = st
    if (s(input.snoozed_until)?.trim()) {
      const w = parseWhen(String(input.snoozed_until), at)
      if (w === null) return { result: `refused: can't read snoozed_until "${String(input.snoozed_until)}"` }
      patch.snoozedUntil = new Date(w).toISOString()
    }
    return { result: await act($, (b, t) => updateItem(b, id, patch, t)) }
  }).catch(failed)

  on('tool.call', { tool: LIST }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    await refresh($, true)
    const err = await read($, error)
    if (err) return { result: `punch-list: ${err}` }
    const st = s(input.status)
    const f: ListFilter = {
      ...(st === 'open' || st === 'snoozed' || st === 'done' || st === 'all' ? { status: st } : {}),
      ...(s(input.tag) ? { tag: s(input.tag) } : {}),
    }
    return { result: listText(await read($, items), await $.clock.now(), f, true) }
  }).catch(failed)

  // --- /todo ---------------------------------------------------------------------

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    const [sub = '', ...rest] = args.split(/\s+/).filter(Boolean)
    const at = await $.clock.now()
    switch (sub.toLowerCase()) {
      case '': {
        const isOpen = await togglePane($)
        return { text: isOpen ? 'Punch list opened.' : 'Punch list closed.' }
      }
      case 'help':
        return { text: HELP }
      case 'add': {
        const parsed = parseAddArgs(args.slice(sub.length), at)
        if ('error' in parsed) return { text: `${parsed.error}. Usage: /todo add <text> [#tag] [due:<when>]` }
        const source: PunchSource = await read($, self)
        return { text: await act($, (b, t) => addItem(b, parsed, t, source)) }
      }
      case 'done':
      case 'tick': {
        const ids = parseIds(rest)
        if (!ids.length) return { text: 'Usage: /todo done <n> [<n>…]' }
        return { text: await act($, (b, t) => markDone(b, ids, t)) }
      }
      case 'snooze': {
        const [idWord, ...when] = rest
        const [id] = parseIds(idWord ? [idWord] : [])
        const until = parseWhen(when.join(' ') || '1d', at)
        if (id === undefined || until === null) return { text: 'Usage: /todo snooze <n> <when>: 30m, 2h, 3d, 1w, tonight, tomorrow, fri, 2026-10-20' }
        return { text: await act($, (b, t) => snooze(b, id, until, t)) }
      }
      case 'reopen':
      case 'undo': {
        const [id] = parseIds(rest)
        if (id === undefined) return { text: 'Usage: /todo reopen <n>' }
        return { text: await act($, (b, t) => reopen(b, id, t)) }
      }
      case 'clear-done':
      case 'clear':
        return { text: await act($, b => clearDone(b)) }
      case 'list':
      case 'ls': {
        await refresh($, true)
        const err = await read($, error)
        if (err) return { text: `punch-list: ${err}` }
        const st = rest.find(w => /^(all|done|snoozed|open)$/.test(w)) as ListFilter['status']
        const tag = rest.find(w => w.startsWith('#'))
        return { text: listText(await read($, items), at, { ...(st ? { status: st } : {}), ...(tag ? { tag } : {}) }) }
      }
      case 'band': {
        const want = rest[0] === 'on' ? true : rest[0] === 'off' ? false : !(await read($, bandOn))
        await update($, bandOn, () => want)
        await $.store.set(STORE_BAND, want)
        return { text: `Band above the prompt: ${want ? 'on' : 'off'}.` }
      }
      case 'path':
        return { text: await pathOf($) }
      default:
        return { text: `Unknown: /todo ${sub}\n${HELP}` }
    }
  })

  // --- drawing -----------------------------------------------------------------

  // The band above the prompt. Other mods draw there too (session-crew's crabs,
  // savvy-progress's bar): this row goes on top of whatever the hooks beneath drew.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandOn))) return next(e)
    const at = Math.max(await read($, now), Date.now())
    const sum = summarize(await read($, items), at)
    const err = await read($, error)
    if (!sum.open && !err) return next(e)
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const open = <Button key="punch-list-open" label={err ? 'to-do: error' : 'to-do'} plain onPress={() => void togglePane($)} />
    let mine
    if (err && !sum.open) {
      mine = (
        <Box key="punch-list-band" flexDirection="row" gap={1}>
          <Text color={URGENT_COLOR} wrap="truncate-end">
            punch list: {err}
          </Text>
          {open}
        </Box>
      )
    } else if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(160, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 90))
      const source = bandSvg(W, sum, at)
      mine = (
        <Box key="punch-list-band" flexDirection="row" alignItems="center" gap={1}>
          <Svg source={source} alt={bandWords(sum)} width={svgWidth(source, W)} height={BAND_H} />
          {open}
        </Box>
      )
    } else {
      const cols = e.props.bodyColumns || 80
      const tops = terminalTop(sum.top, cols - 30)
      mine = (
        <Box key="punch-list-band" flexDirection="row" gap={1}>
          <Text bold>☐ {sum.open} to do</Text>
          {sum.urgent > 0 && <Text color={URGENT_COLOR} bold>{sum.urgent}!</Text>}
          <Text wrap="truncate-end">
            {tops.map((t, n) => (
              <Text key={`t${n}`} color={sum.top[n] && isUrgent(sum.top[n], at) ? URGENT_COLOR : undefined} dimColor={!(sum.top[n] && isUrgent(sum.top[n], at))}>
                {n ? ' · ' : ''}
                {t}
              </Text>
            ))}
          </Text>
          {open}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const at = Math.max(await read($, now), Date.now())
    const all = await read($, items)
    const p = await read($, panel)
    const err = await read($, error)
    const sum = summarize(all, at)
    const shown = all.filter(i => {
      const st = statusAt(i, at)
      return st === 'open' || st === 'snoozed' || (p.isDoneShown && st === 'done')
    })

    const row = (i: PunchItem) => {
      const st = statusAt(i, at)
      const urgent = st === 'open' && isUrgent(i, at)
      const meta = [
        dueLabel(i, at),
        st === 'snoozed' && i.snoozedUntil ? `snoozed until ${whenLabel(Date.parse(i.snoozedUntil), at)}` : null,
        st === 'done' && i.doneAt ? `done ${ageLabel(i.doneAt, at)}` : null,
        i.source?.name ? `from ${i.source.name}` : null,
        `added ${ageLabel(i.created, at)}`,
      ].filter(Boolean)
      const press = (fn: (b: PunchBook, t: number) => Change) => () => void act($, fn)
      return (
        <Box key={`item-${i.id}`} flexDirection="column" marginBottom={1}>
          <Text wrap="wrap" dimColor={st !== 'open'}>
            <Text bold color={urgent ? URGENT_COLOR : st === 'done' ? '#3B9C5F' : undefined}>
              {st === 'done' ? '✓' : st === 'snoozed' ? 'z' : urgent ? '!' : '☐'} #{i.id}
            </Text>{' '}
            {i.text}
          </Text>
          {i.detail && (
            <Text dimColor wrap="wrap">
              {i.detail}
            </Text>
          )}
          {i.link && /^https:\/\//.test(i.link) ? <Link key={`link-${i.id}`} href={i.link} /> : i.link ? <Text dimColor>{i.link}</Text> : null}
          <Text dimColor wrap="truncate-end">
            {meta.join(' · ')}
          </Text>
          <Box flexDirection="row" gap={2}>
            {st !== 'done' && <Button key={`done-${i.id}`} label="Done" plain onPress={press((b, t) => markDone(b, [i.id], t))} />}
            {st === 'open' && <Button key={`snooze-${i.id}`} label="Snooze 1d" plain onPress={press((b, t) => snooze(b, i.id, t + 86_400_000, t))} />}
            {st === 'open' && <Button key={`week-${i.id}`} label="1w" plain onPress={press((b, t) => snooze(b, i.id, t + 7 * 86_400_000, t))} />}
            {st !== 'open' && <Button key={`reopen-${i.id}`} label="Reopen" plain onPress={press((b, t) => reopen(b, i.id, t))} />}
          </Box>
        </Box>
      )
    }

    const groups = groupByTag(
      [...shown].sort((a, b) => {
        const rank = (i: PunchItem) => ({ open: 0, snoozed: 1, done: 2 })[statusAt(i, at)]
        return rank(a) - rank(b) || Number(isUrgent(b, at)) - Number(isUrgent(a, at)) || a.id - b.id
      }),
    )
    const adder =
      'Input' in ui
        ? (() => {
            const { Input } = ui
            return (
              <Input
                key="add"
                placeholder="Add: text #tag due:fri"
                submitLabel="Add"
                onSubmit={value => {
                  const parsed = parseAddArgs(value, Date.now())
                  if ('error' in parsed) return
                  void (async () => {
                    const source: PunchSource = await read($, self)
                    $.ui.toast(await act($, (b, t) => addItem(b, parsed, t, source)))
                  })()
                }}
              />
            )
          })()
        : null

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" gap={2} marginBottom={1}>
          <Text bold>{sum.open ? `${sum.open} to do` : 'Nothing waiting on you'}</Text>
          {sum.urgent > 0 && (
            <Text bold color={URGENT_COLOR}>
              {sum.urgent} need you first
            </Text>
          )}
          {sum.snoozed > 0 && <Text dimColor>{sum.snoozed} snoozed</Text>}
        </Box>
        {err && (
          <Text key="err" color={URGENT_COLOR} wrap="wrap">
            {err}
          </Text>
        )}
        {groups.map(([tag, list]) => (
          <Box key={`group-${tag || 'other'}`} flexDirection="column">
            <Text bold color={tag === 'approve' || tag === 'security' ? URGENT_COLOR : ACCENT}>
              {(tag || 'other').toUpperCase()} · {list.length}
            </Text>
            {list.map(row)}
          </Box>
        ))}
        {adder}
        <Box key="controls" flexDirection="row" gap={2}>
          {sum.done > 0 && (
            <Button key="show-done" label={`${p.isDoneShown ? '▾' : '▸'} done · ${sum.done}`} plain onPress={() => update($, panel, v => ({ ...v, isDoneShown: !v.isDoneShown }))} />
          )}
          {sum.done > 0 && <Button key="clear-done" label="Clear done" plain onPress={() => void act($, b => clearDone(b))} />}
          <Button key="refresh" label="Refresh" plain onPress={() => void refresh($, true)} />
        </Box>
      </Box>
    )
  })
}
