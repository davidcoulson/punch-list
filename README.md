# punch-list

A Claude Code mod that keeps **one to-do list of the things waiting on you**, collected from every Claude Code session you run, and keeps it in view above the prompt.

When you run many sessions side by side, "you need to do X" ends up buried in a dozen chat replies. Examples: tick a box only a human may tick, approve a deploy, rotate a leaked key, or do a job for the next downtime. punch-list gives Claude tools to put each of those on a shared list as it says it, and to tick it off when you confirm or it verifies the job is done. You see the count in every session.

```
☐ 6 to do  ● 1 need you · Approve the staging deploy for t… · Replace the hallway sensor batt…   [to-do]
```

## What it does

- **One shared file**: `~/.claude/punch-list.json` (or `$CLAUDE_CONFIG_DIR/punch-list.json`). Every session reads and writes it, and a change made in one session shows up in the others within seconds.
- **Tools for Claude**, listed in every session's tool list from the start:

  | Tool | When Claude uses it |
  | --- | --- |
  | `mcp__punch-list__add` | Whenever it tells you to do something it can't do for you: approve, tick a box, rotate a credential, a hardware job, a setting only you can change, a decision it's waiting on. Adding the same words twice returns the existing item. |
  | `mcp__punch-list__done` | When you say you did it, or when it verifies the job itself (the box is ticked, the key rotated). |
  | `mcp__punch-list__update` | To reword, retag, set a due date, reopen or snooze an item. |
  | `mcp__punch-list__list` | To tell you what's waiting, or to find an item's number. |

- **A band above the prompt**: the open count, how many need you first (tags `approve` and `security`, or past their due date, in orange), and the top items. It is hidden when nothing is open.
- **A `/todo` panel**: every item grouped by tag, with **Done**, **Snooze 1d**, **1w** and **Reopen** buttons, an *Add* field, and finished items folded away.
- **A status-line count**: `to-do 6 (1!)`.

### Items

| Field | |
| --- | --- |
| `id` | A small number that never changes or gets reused: what `/todo done 3` takes. |
| `text` | The job as an instruction: "Rotate the Sonarr API key". |
| `detail`, `link` | Optional. The link is a URL, or a session link such as `#local_…`. |
| `tag` | One word: `approve`, `security`, `pr`, `downtime`, `setup`, or anything else. |
| `due` | Optional. A date (`2026-10-20`) or an ISO date-time. |
| `status` | `open`, `done`, or `snoozed` (with `snoozedUntil`; it comes back on its own). |
| `source` | The session that added it: the desktop app's `local_…` id and title when the app's session server answers, otherwise the CLI session id, plus the folder. |
| `created`, `updated`, `doneAt`, `doneNote` | Timestamps, and how it was done. |

**Secret values never go on the list.** Every field is checked before it's written, and a value that looks like a key is refused with a message telling Claude to name the secret instead. The check covers long hex keys (Radarr and Sonarr use them), GitHub, GitLab, Slack, AWS, Google, OpenAI-style and Anthropic-style keys, JWTs, `password=…` assignments, bearer tokens, passwords inside URLs, and long mixed-case random strings. Commit SHAs and digests that appear in their usual context (`commit 0394…`, `…/commit/0394…`, `sha256:…`) are allowed.

## Commands

```
/todo                       show or hide the panel
/todo list [all|done|snoozed] [#tag]
/todo add <text> [#tag] [due:<when>]
/todo done <n> [<n>…]
/todo snooze <n> <when>     30m, 2h, 3d, 1w, tonight, tomorrow, fri, 2026-10-20
/todo reopen <n>
/todo clear-done
/todo band on|off           the band above the prompt (kept across sessions)
/todo path                  where the shared file is
```

In `/todo add`, the first `#word` is the tag, and only when it starts with a letter, so `#199` stays part of the text. `due:<when>` sets the due date.

## Enable it

The mod loads from this folder through `CLAUDE_CODE_PLUGIN_DIRS`, the same way session-crew does. In `~/.claude/settings.json`, add this folder to the variable, separated by `:`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/session-crew:/path/to/punch-list"
}
```

Then open a new session; sessions that are already open don't pick it up. To try it once from a terminal instead:

```bash
claude --plugin-dir /path/to/punch-list
```

Options (`pluginConfigs["punch-list"]` in settings, or the config menu):

| Option | Default | |
| --- | --- | --- |
| `file` | *(empty)* | The shared file. Empty means `punch-list.json` in the Claude config folder. `~/` is allowed. |
| `band` | `true` | The band above the prompt. `/todo band on\|off` overrides it. |
| `statusLine` | `true` | `to-do N` in the status line. |
| `pollSeconds` | `5` | How often to look for other sessions' changes. `0` checks only on each prompt. |

## How sessions share the file safely

- **Reads** take the file as it stands. Each session checks the file's `mtime` and size every few seconds and on each prompt, and rereads it when they change. It records a revision only when the stats taken before and after a read agree, so a write that lands during a read is picked up on the next check.
- **Writes** use compare-and-swap:
  1. The session reads the list and applies the change (a pure function).
  2. It writes the result to a temp file beside the list, plus a copy of what it read.
  3. A child process swaps the result in with a short script: if the file still matches the copy, `mv` the temp file over it; otherwise exit 3.

  That script runs under a kernel lock: `/usr/bin/lockf -k` on macOS, `flock` on Linux. The OS releases the lock when the child exits, so a crashed session never leaves the list locked, and no session can take the lock from a live writer. If another session wrote in between, the change is applied again to that session's list. Nothing is lost, and readers only ever see a whole file. The empty `punch-list.json.lock` beside the list is the lock file. Leave it there. On a machine with neither `lockf` nor `flock`, the mod refuses to write rather than risk losing an update. Temp files are removed on every failure path, and any left by a session that died mid-write are swept after ten minutes.
- **A damaged file** (empty, invalid JSON, another version, or an item that can't be read whole) is reported in the band and the panel and is **never written over**. Fix or move it, and the next write starts a new list.

## Fit with session-crew and savvy-progress

All three mods draw in the band above the prompt. punch-list's band is one row. It calls `next(e)` and draws itself **on top of** whatever the hooks beneath it drew, the same way session-crew's crab strip does, so the two stack instead of replacing each other. savvy-progress draws its bar alone while a flow runs. If it's higher in the chain, the other bands come back when the flow ends.

I chose stacking over putting the count inside session-crew's strip. Neither mod depends on the other, and either can be turned off (`/todo band off`, `/crew strip off`) without touching the other. punch-list's state (`punch-list.items`) is readable by any plugin, so session-crew could add a to-do chip later if one combined row works better.

Desktop rendering follows savvy-progress and session-crew. On the desktop the row is a single `Svg`, because the desktop wraps sibling elements onto new lines, with one `Button` beside it that opens the panel. The terminal gets the same row in text. The desktop app's bundle does request `AbovePrompt` renders. Whether the Code tab draws the band is still being verified by session-crew's work (`/crew debug` shows whether a surface asked for it). Until then, the status line and the `/todo` panel show the same information.

## Mirroring to Home Assistant (optional, later)

Not built yet. Home Assistant has no to-do lists today (`ha_get_todo` lists none), so a mirror would go like this:

1. In HA: **Settings → Devices & services → Add integration → Local To-do**, named "Punch list". That creates `todo.punch_list`.
2. Ask Claude to mirror the list. With the HA MCP it calls `mcp__punch-list__list` (status `all`), then for each item calls `ha_set_todo_item` on `todo.punch_list`:
   - `item` / summary: `#<id> <text>`. The number prefix ties the HA item to the list entry.
   - `description`: the detail and link.
   - `due_date`: the due date.
   - `status`: `needs_action` for open and snoozed items, `completed` for done ones.

   It removes HA items whose number is no longer on the list with `ha_remove_todo_item`. `ha_get_todo("todo.punch_list")` shows what's there.
3. From then on the list is on the HA dashboard and phone app, and it can trigger automations (for example, a notification when a `security` item has been open for a day).

A later version could do this itself. A mod can call an MCP server with `$.mcp.call` (session-crew does this with the app's session server), so `/todo ha` or a background sync on each write could keep `todo.punch_list` current. Ticking an item in HA would then need a poll back into the file. The same never-a-secret rule applies, since HA would store the text.

## Develop

```bash
sh scripts/check.sh
```

The script type-checks against the engine's types (it finds the most recent `plugin-authoring` types file and the `tsc` cached by `npx`), then runs `claude plugin validate` and `claude plugin test`. The tests cover:

- the list rules: dedupe, numbering, done, snooze, reopen and clear;
- strict parsing;
- the secret filter;
- times and the `/todo add` words;
- compare-and-swap writes, including a race with another session and a damaged file left untouched;
- polling for other sessions' changes;
- the band stacked over another mod's band, on the terminal and the desktop;
- the panel's buttons and Add field.

`hooks/list.ts` holds the list itself as plain data with no `$`. `hooks/draw.ts` holds the desktop band's SVG. `hooks/register.tsx` holds the file, tools, commands and drawing.

## License

MIT, see [LICENSE](LICENSE).
