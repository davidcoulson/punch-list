// The list itself, as plain data: no `$` here, so every rule is testable alone.

import type { PunchBook, PunchItem, PunchSource, PunchStatus } from '../types'

export const emptyBook = (): PunchBook => ({ version: 1, next: 1, items: [] })

/** Tags drawn first and highlighted: they block something until the person acts. */
export const URGENT_TAGS = ['approve', 'security'] as const
const TAG_ORDER = ['approve', 'security', 'pr', 'setup', 'downtime']

const MAX_TEXT = 300
const MAX_DETAIL = 2000
const MAX_LINK = 2048

const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Reading the file

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

const OPTIONAL = ['detail', 'link', 'tag', 'due', 'snoozedUntil', 'doneAt', 'doneNote', 'updated'] as const

/**
 * Reads the shared file's text, strictly: anything this code would not have
 * written (an empty file, another version, an item it cannot read whole) throws,
 * so a damaged list is reported and never rewritten with records dropped.
 */
export function parseBook(text: string): PunchBook {
  if (!text.trim()) throw new Error('the file is empty')
  const raw: unknown = JSON.parse(text)
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error('not a punch list (no "items" array)')
  if (raw.version !== 1) throw new Error(`version ${JSON.stringify(raw.version)} is not one this mod reads`)
  const items: PunchItem[] = []
  const ids = new Set<number>()
  raw.items.forEach((r: unknown, n: number) => {
    const bad = (why: string): never => {
      throw new Error(`item ${n + 1}: ${why}`)
    }
    if (!isObj(r)) return bad('not an object')
    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1) return bad('no positive whole-number id')
    if (ids.has(r.id)) return bad(`id ${r.id} appears twice`)
    ids.add(r.id)
    if (!str(r.text)) return bad('no text')
    if (r.status !== 'open' && r.status !== 'done' && r.status !== 'snoozed') return bad(`unknown status ${JSON.stringify(r.status)}`)
    if (!str(r.created)) return bad('no created time')
    for (const k of OPTIONAL) if (r[k] !== undefined && typeof r[k] !== 'string') bad(`${k} is not text`)
    if (r.source !== undefined && !isObj(r.source)) return bad('source is not an object')
    const at = String(r.created)
    items.push({
      id: r.id,
      text: String(r.text),
      ...(str(r.detail) ? { detail: String(r.detail) } : {}),
      ...(str(r.link) ? { link: String(r.link) } : {}),
      ...(str(r.tag) ? { tag: String(r.tag) } : {}),
      ...(str(r.due) ? { due: String(r.due) } : {}),
      status: r.status,
      ...(str(r.snoozedUntil) ? { snoozedUntil: String(r.snoozedUntil) } : {}),
      created: at,
      updated: str(r.updated) ?? at,
      ...(str(r.doneAt) ? { doneAt: String(r.doneAt) } : {}),
      ...(str(r.doneNote) ? { doneNote: String(r.doneNote) } : {}),
      ...(isObj(r.source) ? { source: cleanSource(r.source) } : {}),
    })
  })
  const highest = items.reduce((m, i) => Math.max(m, i.id), 0)
  // `next` only ever grows, so a number cleared away is never handed out again.
  const next = typeof raw.next === 'number' && Number.isInteger(raw.next) && raw.next > highest ? raw.next : highest + 1
  return { version: 1, next, items }
}

export const serializeBook = (book: PunchBook): string => JSON.stringify(book, null, 2) + '\n'

// Where an item came from, minus any field that looks like it holds a secret
// (a session title can hold anything): those are left out, not refused.
const cleanSource = (s: Record<string, unknown>): PunchSource => {
  const keep = (v: unknown): v is string => !!str(v) && secretReason(String(v)) === null
  return {
    ...(keep(s.session) ? { session: s.session } : {}),
    ...(keep(s.name) ? { name: s.name } : {}),
    ...(keep(s.cwd) ? { cwd: s.cwd } : {}),
  }
}

// ---------------------------------------------------------------------------
// Secrets never go on the list

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bhf_[A-Za-z0-9]{30,}/, 'a Hugging Face token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, 'a JWT'],
  [/\b(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|pwd|bearer)\b\s*[:=]\s*["']?[^\s"']{6,}/i, 'a credential assignment'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/, 'a bearer token'],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/, 'a password inside a URL'],
]

// Hex that is a commit or a digest by its context, not a key: `commit 0394…`,
// `…/commit/0394…`, `sha256:…`, `digest: …`.
const HASH_CONTEXT = /(?:\/(?:commit|commits|tree|blob|compare|releases\/tag)\/|\.\.\.?|@?sha(?:1|256|512)?[:\s-]*|\bcommit\s+|\bdigest[:\s]*|\brev(?:ision)?[:\s]+)$/i

const isHex = (s: string): boolean => /^[A-Fa-f0-9]+$/.test(s)
const isHashAt = (text: string, index: number, run: string): boolean => isHex(run) && HASH_CONTEXT.test(text.slice(Math.max(0, index - 40), index))

/**
 * Why `text` looks like it holds a secret value, or null. Items name the
 * secret ("rotate the Sonarr API key"), never its value.
 */
export function secretReason(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what
  // Long hex: Radarr, Sonarr and many other apps' API keys.
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g))
    if (!isHashAt(text, m.index ?? 0, m[0])) return 'a long hex key'
  // Long runs mixing cases and digits (hyphens and underscores allowed), alone or as a URL path segment.
  for (const m of text.matchAll(/[A-Za-z0-9/=_+-]{32,}/g))
    for (const seg of m[0].split('/'))
      if (seg.length >= 32 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && seg.replace(/[^0-9]/g, '').length >= 3 && !isHex(seg)) return 'a long random-looking token'
  return null
}

// ---------------------------------------------------------------------------
// Changing the list

export type AddInput = { text: string; detail?: string; link?: string; tag?: string; due?: string }

export const normalizeTag = (s: string): string =>
  s
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)

const sameText = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim()

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

export type Change = { book: PunchBook; message: string; ids: number[] }

/** Refuses input that holds a secret value; null when it is clean. */
export function checkInput(fields: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string') continue
    const why = secretReason(v)
    if (why) return `refused: ${k} looks like it holds ${why}. Put what to do on the list ("rotate the X key"), never the secret itself.`
  }
  return null
}

/**
 * Adds an item, or names the open one already holding the same words (several
 * sessions often report the same thing).
 */
export function addItem(book: PunchBook, input: AddInput, at: number, source?: PunchSource): Change {
  const text = clip(input.text.trim().replace(/\s+/g, ' '), MAX_TEXT)
  if (!text) return { book, message: 'refused: the item has no text', ids: [] }
  const refused = checkInput({ text, detail: input.detail, link: input.link, tag: input.tag, due: input.due })
  if (refused) return { book, message: refused, ids: [] }
  const key = sameText(text)
  const twin = book.items.find(i => i.status !== 'done' && sameText(i.text) === key)
  const iso = new Date(at).toISOString()
  if (twin) {
    // Fill in what the first report lacked; never overwrite it.
    const merged: PunchItem = {
      ...twin,
      ...(!twin.detail && input.detail ? { detail: clip(input.detail.trim(), MAX_DETAIL) } : {}),
      ...(!twin.link && input.link ? { link: clip(input.link.trim(), MAX_LINK) } : {}),
      ...(!twin.tag && input.tag && normalizeTag(input.tag) ? { tag: normalizeTag(input.tag) } : {}),
      ...(!twin.due && input.due ? { due: input.due } : {}),
    }
    const changed = JSON.stringify(merged) !== JSON.stringify(twin)
    return {
      book: changed ? { ...book, items: book.items.map(i => (i.id === twin.id ? { ...merged, updated: iso } : i)) } : book,
      message: `already on the list as #${twin.id}${changed ? ' (filled in the missing details)' : ''}`,
      ids: [twin.id],
    }
  }
  const tag = input.tag ? normalizeTag(input.tag) : ''
  const src = cleanSource(source ?? {})
  const item: PunchItem = {
    id: book.next,
    text,
    ...(input.detail?.trim() ? { detail: clip(input.detail.trim(), MAX_DETAIL) } : {}),
    ...(input.link?.trim() ? { link: clip(input.link.trim(), MAX_LINK) } : {}),
    ...(tag ? { tag } : {}),
    ...(input.due ? { due: input.due } : {}),
    status: 'open',
    created: iso,
    updated: iso,
    ...(Object.keys(src).length ? { source: src } : {}),
  }
  return { book: { ...book, next: book.next + 1, items: [...book.items, item] }, message: `added #${item.id}`, ids: [item.id] }
}

export type Patch = {
  text?: string
  detail?: string
  link?: string
  tag?: string
  due?: string
  status?: PunchStatus
  snoozedUntil?: string
  doneNote?: string
}

/** Changes one item. An empty string clears an optional field. */
export function updateItem(book: PunchBook, id: number, patch: Patch, at: number): Change {
  const item = book.items.find(i => i.id === id)
  if (!item) return { book, message: `no item #${id}`, ids: [] }
  const refused = checkInput({ text: patch.text, detail: patch.detail, link: patch.link, tag: patch.tag, due: patch.due, doneNote: patch.doneNote })
  if (refused) return { book, message: refused, ids: [] }
  const iso = new Date(at).toISOString()
  const next: PunchItem = { ...item, updated: iso }
  const setOpt = (k: 'detail' | 'link' | 'due' | 'doneNote', v: string | undefined, max = MAX_DETAIL) => {
    if (v === undefined) return
    if (v.trim()) next[k] = clip(v.trim(), max)
    else delete next[k]
  }
  if (patch.text !== undefined && patch.text.trim()) next.text = clip(patch.text.trim().replace(/\s+/g, ' '), MAX_TEXT)
  setOpt('detail', patch.detail)
  setOpt('link', patch.link, MAX_LINK)
  setOpt('due', patch.due)
  setOpt('doneNote', patch.doneNote)
  if (patch.tag !== undefined) {
    const t = normalizeTag(patch.tag)
    if (t) next.tag = t
    else delete next.tag
  }
  if (patch.status === 'snoozed' && !patch.snoozedUntil && !next.snoozedUntil)
    return { book, message: 'refused: snoozing needs snoozed_until (when it comes back)', ids: [] }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.snoozedUntil !== undefined) {
    next.snoozedUntil = patch.snoozedUntil
    if (patch.status === undefined) next.status = 'snoozed'
  }
  if (next.status === 'done' && item.status !== 'done') next.doneAt = iso
  if (next.status !== 'done') delete next.doneAt
  if (next.status !== 'done') delete next.doneNote
  if (next.status !== 'snoozed') delete next.snoozedUntil
  return { book: { ...book, items: book.items.map(i => (i.id === id ? next : i)) }, message: `updated #${id}`, ids: [id] }
}

/** Ticks items off; ids already done are reported, not an error. */
export function markDone(book: PunchBook, ids: number[], at: number, note?: string): Change {
  const missing = ids.filter(id => !book.items.some(i => i.id === id))
  const refused = checkInput({ note })
  if (refused) return { book, message: refused, ids: [] }
  let b = book
  const done: number[] = []
  const already: number[] = []
  for (const id of ids) {
    const item = b.items.find(i => i.id === id)
    if (!item) continue
    if (item.status === 'done') {
      already.push(id)
      continue
    }
    b = updateItem(b, id, { status: 'done', ...(note ? { doneNote: note } : {}) }, at).book
    done.push(id)
  }
  const parts = [
    done.length && `done: ${done.map(n => `#${n}`).join(', ')}`,
    already.length && `already done: ${already.map(n => `#${n}`).join(', ')}`,
    missing.length && `no such item: ${missing.map(n => `#${n}`).join(', ')}`,
  ].filter(Boolean)
  return { book: b, message: parts.join('; ') || 'nothing to do', ids: done }
}

export const reopen = (book: PunchBook, id: number, at: number): Change => {
  const r = updateItem(book, id, { status: 'open' }, at)
  return r.ids.length ? { ...r, message: `reopened #${id}` } : r
}

export function snooze(book: PunchBook, id: number, until: number, at: number): Change {
  const item = book.items.find(i => i.id === id)
  if (!item) return { book, message: `no item #${id}`, ids: [] }
  const r = updateItem(book, id, { status: 'snoozed', snoozedUntil: new Date(until).toISOString() }, at)
  return { ...r, message: `snoozed #${id} until ${whenLabel(until, at)}` }
}

export function clearDone(book: PunchBook): Change {
  const gone = book.items.filter(i => i.status === 'done').map(i => i.id)
  return { book: { ...book, items: book.items.filter(i => i.status !== 'done') }, message: gone.length ? `cleared ${gone.length} done` : 'nothing done to clear', ids: gone }
}

// ---------------------------------------------------------------------------
// Reading the list

/** A snoozed item whose time has come counts as open. */
export const statusAt = (i: PunchItem, at: number): PunchStatus =>
  i.status === 'snoozed' && i.snoozedUntil && Date.parse(i.snoozedUntil) <= at ? 'open' : i.status

export const isOverdue = (i: PunchItem, at: number): boolean => !!i.due && dueTime(i.due) <= at

export const isUrgent = (i: PunchItem, at: number): boolean =>
  (!!i.tag && (URGENT_TAGS as readonly string[]).includes(i.tag)) || isOverdue(i, at)

// A due date without a time is due at the end of that day.
const dueTime = (due: string): number => (/^\d{4}-\d{2}-\d{2}$/.test(due) ? localDay(due) + DAY - 1 : Date.parse(due))

const localDay = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime()
}

/** Open items, most pressing first: urgent, then by due date, then oldest. */
export function openItems(items: readonly PunchItem[], at: number): PunchItem[] {
  return items
    .filter(i => statusAt(i, at) === 'open')
    .sort(
      (a, b) =>
        Number(isUrgent(b, at)) - Number(isUrgent(a, at)) ||
        (a.due ? dueTime(a.due) : Infinity) - (b.due ? dueTime(b.due) : Infinity) ||
        Date.parse(a.created) - Date.parse(b.created) ||
        a.id - b.id,
    )
}

export const tagRank = (tag: string | undefined): number => {
  if (!tag) return TAG_ORDER.length + 1
  const i = TAG_ORDER.indexOf(tag)
  return i < 0 ? TAG_ORDER.length : i
}

/** Items grouped by tag: urgent tags first, then the known ones, then the rest by name, untagged last. */
export function groupByTag(items: readonly PunchItem[]): [string, PunchItem[]][] {
  const groups = new Map<string, PunchItem[]>()
  for (const i of items) {
    const k = i.tag ?? ''
    groups.set(k, [...(groups.get(k) ?? []), i])
  }
  return [...groups.entries()].sort(([a], [b]) => tagRank(a || undefined) - tagRank(b || undefined) || a.localeCompare(b))
}

export type Summary = { open: number; urgent: number; snoozed: number; done: number; top: PunchItem[] }

export function summarize(items: readonly PunchItem[], at: number, topN = 3): Summary {
  const open = openItems(items, at)
  return {
    open: open.length,
    urgent: open.filter(i => isUrgent(i, at)).length,
    snoozed: items.filter(i => statusAt(i, at) === 'snoozed').length,
    done: items.filter(i => i.status === 'done').length,
    top: open.slice(0, topN),
  }
}

// ---------------------------------------------------------------------------
// Times

/**
 * When "later" is: `30m`, `2h`, `3d`, `1w`, `tonight`, `tomorrow`, a weekday
 * (`mon`, `friday`), `YYYY-MM-DD` (9:00 that day) or an ISO date-time. Null
 * when it cannot tell.
 */
export function parseWhen(s: string, at: number): number | null {
  const t = s.trim().toLowerCase()
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/.exec(t)
  if (rel) {
    const n = Number(rel[1])
    const u = rel[2]?.[0]
    const ms = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? DAY : 7 * DAY
    return at + n * ms
  }
  const nine = (d: Date): number => {
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  if (t === 'tonight') {
    const d = new Date(at)
    d.setHours(20, 0, 0, 0)
    return d.getTime() > at ? d.getTime() : at + 3_600_000
  }
  if (t === 'tomorrow') {
    const d = new Date(at)
    d.setDate(d.getDate() + 1)
    return nine(d)
  }
  if (t === 'week' || t === 'next-week' || t === 'nextweek') return parseWhen('mon', at)
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const wd = days.indexOf(t.slice(0, 3))
  if (wd >= 0 && /^[a-z]+$/.test(t) && t.length >= 3) {
    const d = new Date(at)
    const ahead = (wd - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + ahead)
    return nine(d)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return localDay(t) + 9 * 3_600_000
  if (/^\d{4}-\d{2}-\d{2}t/.test(t)) {
    const p = Date.parse(s.trim())
    return Number.isNaN(p) ? null : p
  }
  return null
}

/** Normalizes a due value: a plain date stays a date, anything parseWhen reads becomes a date-time. */
export function parseDue(s: string, at: number): string | null {
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const w = parseWhen(t, at)
  return w === null ? null : new Date(w).toISOString()
}

export function ageLabel(iso: string, at: number): string {
  const ms = Math.max(0, at - Date.parse(iso))
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "in 2h", "tomorrow 09:00", "Fri 09:00", "Oct 20". */
export function whenLabel(t: number, at: number): string {
  const ms = t - at
  if (ms < 0) return 'now'
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(at)
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY)
  if (dayDiff === 0) return `today ${hm}`
  if (dayDiff === 1) return `tomorrow ${hm}`
  if (dayDiff < 7) return `${WEEKDAY[d.getDay()]} ${hm}`
  return `${MONTH[d.getMonth()]} ${d.getDate()}`
}

export function dueLabel(i: PunchItem, at: number): string | null {
  if (!i.due) return null
  const t = dueTime(i.due)
  if (t <= at) return 'overdue'
  return /^\d{4}-\d{2}-\d{2}$/.test(i.due) ? `due ${whenLabel(localDay(i.due) + 12 * 3_600_000, at).replace(/ 12:00$/, '')}` : `due ${whenLabel(t, at)}`
}

// ---------------------------------------------------------------------------
// Text forms: /todo list, the list tool, the band's words

export function line(i: PunchItem, at: number): string {
  const st = statusAt(i, at)
  const mark = st === 'done' ? '✓' : st === 'snoozed' ? 'z' : isUrgent(i, at) ? '!' : '•'
  // The tag is the group heading this line sits under.
  const meta = [
    dueLabel(i, at),
    st === 'snoozed' && i.snoozedUntil ? `snoozed until ${whenLabel(Date.parse(i.snoozedUntil), at)}` : null,
    i.source?.name ? `from ${i.source.name}` : null,
    ageLabel(i.created, at),
  ].filter(Boolean)
  return `${mark} #${i.id} ${i.text}${meta.length ? `  (${meta.join(' · ')})` : ''}`
}

export type ListFilter = { status?: 'open' | 'snoozed' | 'done' | 'all'; tag?: string }

/** The list as text, grouped by tag; with details and links for the model. */
export function listText(items: readonly PunchItem[], at: number, f: ListFilter = {}, withDetail = false): string {
  const want = f.status ?? 'open'
  const tag = f.tag ? normalizeTag(f.tag) : undefined
  const picked = (want === 'open' ? openItems(items, at) : items.filter(i => want === 'all' || statusAt(i, at) === want)).filter(i => !tag || i.tag === tag)
  if (!picked.length) return want === 'open' ? 'Nothing waiting on you.' : `No ${want === 'all' ? '' : `${want} `}items${tag ? ` tagged ${tag}` : ''}.`
  const s = summarize(items, at)
  const head = `${s.open} open${s.urgent ? `, ${s.urgent} need you first` : ''}${s.snoozed ? `, ${s.snoozed} snoozed` : ''}${s.done ? `, ${s.done} done` : ''}`
  const body = groupByTag(picked)
    .map(([t, list]) =>
      [
        `${t || 'other'}:`,
        ...list.map(i =>
          [
            `  ${line(i, at)}`,
            withDetail && i.detail ? `      ${i.detail.replace(/\n/g, '\n      ')}` : null,
            i.link ? `      ${i.link}` : null,
            withDetail && i.source?.session ? `      session ${i.source.session}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    )
    .join('\n')
  return `${head}\n${body}`
}

/** `/todo add` text: `#tag` words and `due:<when>` come out of the text. */
export function parseAddArgs(s: string, at: number): AddInput | { error: string } {
  let tag: string | undefined
  let due: string | undefined
  const words: string[] = []
  for (const w of s.trim().split(/\s+/).filter(Boolean)) {
    const t = /^#([A-Za-z][\w-]*)$/.exec(w)
    if (t && !tag) {
      tag = t[1]
      continue
    }
    const d = /^due:(.+)$/i.exec(w)
    if (d) {
      const v = parseDue(d[1] ?? '', at)
      if (v === null) return { error: `can't read the due date "${d[1]}"` }
      due = v
      continue
    }
    words.push(w)
  }
  const text = words.join(' ')
  if (!text) return { error: 'nothing to add' }
  return { text, ...(tag ? { tag } : {}), ...(due ? { due } : {}) }
}

/** `#12`, `12`, `12,13` and `12 13` alike. */
export const parseIds = (words: readonly string[]): number[] =>
  words
    .flatMap(w => w.split(','))
    .map(w => /^#?(\d+)$/.exec(w.trim())?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
