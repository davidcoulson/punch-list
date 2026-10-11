export type PunchStatus = 'open' | 'done' | 'snoozed'

/** Where an item came from: the session that added it. */
export type PunchSource = {
  /** The desktop app's `local_…` id when known, else the CLI session id. */
  session?: string
  /** The session's title or short name. */
  name?: string
  /** The folder the session worked in. */
  cwd?: string
}

export type PunchItem = {
  /** A small number, stable for the item's life: what /todo done <n> takes. */
  id: number
  text: string
  detail?: string
  /** A URL, or a session link such as `#local_…`. */
  link?: string
  /** One word: approve, security, pr, downtime, setup… */
  tag?: string
  /** ISO date or date-time. */
  due?: string
  status: PunchStatus
  /** ISO date-time a snoozed item comes back. */
  snoozedUntil?: string
  /** ISO date-time. */
  created: string
  updated: string
  doneAt?: string
  doneNote?: string
  source?: PunchSource
}

/** The shared file's contents. */
export type PunchBook = {
  version: 1
  /** The next item number to hand out. */
  next: number
  items: PunchItem[]
}

export type PunchPanel = {
  isDoneShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'punch-list': {
      /** Every item in the shared file, as last read or written. */
      items: PunchItem[]
      /** The file's mtime when last read or written, to spot other sessions' changes. */
      mtime: number
      /** Why the file could not be read or written, or null. */
      error: string | null
      /** Whether the band above the prompt shows (option, overridden by /todo band, kept in $.store). */
      bandOn: boolean
      panel: PunchPanel
      /** The time drawings measure ages, due dates and snoozes against; ticks once a minute. */
      now: number
      /** This session, as items it adds record their source. */
      self: PunchSource
    }
  }
}
