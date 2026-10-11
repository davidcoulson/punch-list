// The desktop band: one SVG row, since the desktop wraps sibling elements onto
// new lines (savvy-progress's finding). Only the button beside it is an element.

import type { PunchItem } from '../types'
import type { Summary } from './list'
import { isUrgent } from './list'

export const BAND_H = 22
export const URGENT_COLOR = '#D85A30'
export const ACCENT = '#378ADD'

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, in em (savvy-progress's estimate).
const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%mw]/.test(ch) ? 0.72 : 0.56)
export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out ? out + '…' : ''
}

const CSS = `<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.box{stroke:#6b6b68}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.box{stroke:#a8a8a4}}</style>`

/** The words the band says, for the SVG's alt and the terminal alike. */
export function bandWords(s: Summary): string {
  const head = `${s.open} to do${s.urgent ? `, ${s.urgent} need you first` : ''}`
  return s.top.length ? `${head}: ${s.top.map(i => i.text).join('; ')}` : head
}

/** One row: a checkbox, the count, the urgent count, then the top items until the width runs out. */
export function bandSvg(W: number, s: Summary, at: number): string {
  const size = 12
  const y = 15
  let x = 0
  const parts: string[] = []
  parts.push(`<rect class="box" x="1.5" y="4.5" width="12" height="12" rx="3" fill="none" stroke-width="1.4"/>`)
  x = 20
  const count = `${s.open} to do`
  parts.push(`<text class="t" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="600">${xml(count)}</text>`)
  x += textWidth(count, size) + 10
  if (s.urgent) {
    const u = `${s.urgent} need you`
    parts.push(`<circle cx="${x + 4}" cy="10.5" r="4" fill="${URGENT_COLOR}"/>`)
    parts.push(`<text x="${x + 12}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="600" fill="${URGENT_COLOR}">${xml(u)}</text>`)
    x += 12 + textWidth(u, size) + 10
  }
  for (const item of s.top) {
    const room = W - x - 14
    if (room < 60) break
    const sep = `<text class="s" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}">·</text>`
    const words = fitText(item.text, size, Math.min(room, 320))
    if (!words) break
    const urgent = isUrgent(item, at)
    parts.push(sep)
    parts.push(
      `<text ${urgent ? `fill="${URGENT_COLOR}"` : 'class="t"'} x="${x + 10}" y="${y}" font-family="${FONT}" font-size="${size}">${xml(words)}</text>`,
    )
    x += 10 + textWidth(words, size) + 10
  }
  const width = Math.max(120, Math.min(W, Math.ceil(x)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAND_H}" viewBox="0 0 ${width} ${BAND_H}">${CSS}${parts.join('')}</svg>`
}

export const svgWidth = (source: string, fallback: number): number => Number(/width="(\d+(?:\.\d+)?)"/.exec(source)?.[1] ?? fallback)

/** The terminal band's top items, cut to fit `cols`. */
export function terminalTop(top: readonly PunchItem[], cols: number): string[] {
  const out: string[] = []
  let left = cols
  for (const i of top) {
    const want = Math.min(i.text.length, 40)
    if (left < 12) break
    const n = Math.min(want, left - 4)
    out.push(i.text.length > n ? i.text.slice(0, n - 1) + '…' : i.text)
    left -= n + 3
  }
  return out
}
