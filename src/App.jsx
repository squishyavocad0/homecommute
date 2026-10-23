import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, resetDemo } from './supabase.js'
import { DEMO, PEOPLE, COLORS, HISTORY_FROM, SHAME_FROM } from './config.js'

const TZ = 'Europe/Amsterdam'
const PRESETS = [30, 60, 90, 120, 180]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------- date helpers (everything in Europe/Amsterdam) ----------
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
const addDays = (s, n) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const mondayOf = (s) => { const d = parseYmd(s); const wd = (d.getUTCDay() + 6) % 7; return addDays(s, -wd) }
const fmtDay = (s) => { const d = parseYmd(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
const fmtRange = (a, b) => `${fmtDay(a)} – ${fmtDay(b)}`
const isoWeek = (s) => { const d = parseYmd(s); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7) }
const fmtSpan = (a, b) => { const x = parseYmd(a), y = parseYmd(b); return x.getUTCMonth() === y.getUTCMonth() ? `${x.getUTCDate()}–${fmtDay(b)}` : `${fmtDay(a)} – ${fmtDay(b)}` }
const weekLabel = (w) => `Week ${isoWeek(w)} · ${fmtSpan(w, addDays(w, 6))}`
const isBlock = (a) => daysBetween(a.start_date, a.end_date) > 6
const cleanWeekOf = (a) => mondayOf(a.opens_on || a.start_date) // the week the clean actually happens
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const fmtWDay = (s) => `${WDAYS[parseYmd(s).getUTCDay()]} ${fmtDay(s)}`
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000)
// Tick window: from opens_on (set by the DB) until the deadline (Sunday 23:59); after that one extra
// "grace" week in which it can still be ticked but counts as late. After the grace week it is frozen (missed).
export const graceEnd = (a) => addDays(a.end_date, 7)
export const inGrace = (a, today) => today > a.end_date && today <= graceEnd(a) && a.end_date >= SHAME_FROM
export function choreWindow(a, today, done = !!a.done_at) {
  const opens = a.opens_on || a.start_date
  const frozen = today > graceEnd(a)
  if (done) return { state: 'done', frozen }
  if (today < opens) { const n = daysBetween(today, opens); return { state: 'locked', opens, days: n } }
  if (today <= a.end_date) return { state: 'open', due: a.end_date, limited: opens > a.start_date }
  if (inGrace(a, today)) return { state: 'overdue', until: graceEnd(a) }
  return { state: a.end_date >= SHAME_FROM ? 'missed' : 'past', frozen: true }
}
const isLate = (a) => !!a.done_at && a.end_date >= SHAME_FROM && ymd(new Date(a.done_at)) > a.end_date

function History({ weeks, choreMap, me, now }) {
  if (!weeks.length) return null
  return (
    <details className="panel history">
      <summary><b>History</b> <span className="muted small">{weeks.length} week{weeks.length > 1 ? 's' : ''}</span></summary>
      {weeks.map((w) => (
        <div key={w.start} className="hist-week">
          <h4>{weekLabel(w.start)}</h4>
          {w.items.map((a) => {
            const today = ymd(new Date(now))
            const st = !a.done_at ? (inGrace(a, today) ? 'late' : 'missed') : isLate(a) ? 'late' : 'ok'
            const c = choreMap[a.chore_id] || {}
            return (
              <div key={a.id} className={`hist-row ${st}`}>
                <span className="hist-name">{c.emoji} {c.label}</span>
                <span className="hist-who">{a.people.map((p) => p + (p === me ? ' (you)' : '')).join(', ')}</span>
                <span className="hist-st">{st === 'missed' ? '🙈 missed' : !a.done_at ? `⏰ overdue — can still be ticked until ${fmtWDay(graceEnd(a))}` : `${st === 'late' ? '⏰ late' : '✅ on time'} · ${a.done_by} ${fmtWhen(a.done_at, new Date(now))}`}</span>
              </div>
            )
          })}
        </div>
      ))}
    </details>
  )
}

function HallOfShame({ rows, me }) {
  if (!rows?.length) return null
  const top = rows[0].total
  return (
    <section className="panel shame">
      <h2>Hall of Shame 🧻</h2>
      <p className="muted small">Deadline is Sunday 23:59 — no pressure 😇 Missed it? You get one extra week to still tick it (counts as late); after that it’s missed.</p>
      {rows.map((r, i) => (
        <div key={r.person} className={`shame-row ${r.person === me ? 'me' : ''}`}>
          <span className="shame-rank">{i === 0 || r.total === top ? '👑' : `#${i + 1}`}</span>
          <Avatar name={r.person} small />
          <span className="shame-name">{r.person}{r.person === me ? ' (you)' : ''}</span>
          <span className="shame-tags">
            {r.missed > 0 && <span className="tag miss">🙈 {r.missed} missed</span>}
            {r.late > 0 && <span className="tag late">⏰ {r.late} late</span>}
          </span>
        </div>
      ))}
    </section>
  )
}
const fmtTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
const fmtWhen = (iso, now) => {
  const t = new Date(iso); const sameDay = ymd(t) === ymd(now)
  return sameDay ? `today ${fmtTime(iso)}` : new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t)
}
const fmtLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}
const isNetErr = (e) => /failed to fetch|networkerror|load failed|network request failed|offline/i.test(e?.message || String(e || ''))
const friendly = (e) => isNetErr(e) ? '📴 You’re offline — that didn’t go through. Try again when you’re back online.' : (e?.message || 'Something went wrong — please try again')
// Responses and realtime events can arrive out of order: never replace a row with an older tick (lower tick_seq)
const newer = (cur, nxt) => !cur || cur.tick_seq == null || nxt.tick_seq == null || Number(nxt.tick_seq) >= Number(cur.tick_seq)
const mergeRow = (as, row) => (as.some((x) => x.id === row.id) ? as.map((x) => (x.id === row.id ? (newer(x, row) ? row : x) : x)) : [...as, row].sort((a, b) => (a.start_date < b.start_date ? -1 : 1)))
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const fmtAgo = (ms) => { const m = Math.floor(ms / 60000); return m < 1 ? 'a moment' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m` }

// Automatic transitions based on ends_at (same rules as huis_tick() in the database)
function effective(d, now) {
  if (d.ends_at && new Date(d.ends_at).getTime() <= now) {
    if (d.kind === 'machine' && d.state === 'red') return { ...d, state: 'orange', ends_at: null, auto: true }
    if (d.kind === 'room' && d.state === 'orange') return { ...d, state: 'green', ends_at: null, set_by: null, auto: true }
  }
  return d
}

// ---------- texts ----------
function texts(d, now) {
  const by = d.set_by
  const left = d.ends_at ? fmtLeft(new Date(d.ends_at).getTime() - now) : null
  const since = d.started_at ? fmtAgo(now - new Date(d.started_at).getTime()) : null
  if (d.kind === 'machine') {
    if (d.state === 'red') return { title: 'Running!', sub: `${left} to go`, note: `Started by ${by} · done at ${fmtTime(d.ends_at)}` }
    if (d.state === 'orange') return { title: 'Done!', sub: 'Needs emptying 🧺', note: by ? `${by}’s load – come grab your stuff!` : 'Someone needs to empty it' }
    return { title: 'Free', sub: d.id === 'droger' ? 'Ready to tumble 🌀' : 'Toss your laundry in 🫧', note: by ? `Emptied by ${by}` : '' }
  }
  // Toilet & Shower are anonymous: never show who
  if (d.id === 'wc') {
    if (d.state === 'red') return { title: 'Occupied!', sub: 'Occupied 🚽 Someone is on the throne 🤔', note: `deep in thought for ${since}` }
    if (d.state === 'orange') return { title: 'Give it a minute…', sub: `Airing out 💨 ${left} left`, note: 'Hold your breath, it’s almost over 🫡' }
    return { title: 'Free!', sub: 'All yours 🎉', note: '' }
  }
  if (d.state === 'red') return { title: 'Occupied!', sub: 'Occupied 🚿 Someone is giving a concert 🎤', note: `under the water for ${since}` }
  if (d.state === 'orange') return { title: 'Give it a minute…', sub: `Steam clearing ☁️ ${left} left`, note: 'Fresh out of the steam room 🧖' }
  return { title: 'Free!', sub: 'Hot water is waiting 🚿', note: '' }
}

function Light({ state }) {
  return (
    <div className="light" aria-label={`traffic light ${state}`}>
      <span className={`bulb red ${state === 'red' ? 'on' : ''}`} />
      <span className={`bulb orange ${state === 'orange' ? 'on' : ''}`} />
      <span className={`bulb green ${state === 'green' ? 'on' : ''}`} />
    </div>
  )
}

// Back button (Android/browser) and Escape close the open sheet instead of leaving the app
function useBackClose(onClose) {
  const cb = useRef(onClose); cb.current = onClose
  useEffect(() => {
    const tag = Math.random().toString(36).slice(2)
    history.pushState({ ...(history.state || {}), sheet: tag }, '')
    const pop = () => cb.current()
    const key = (e) => { if (e.key === 'Escape') cb.current() }
    window.addEventListener('popstate', pop); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('keydown', key); if (history.state?.sheet === tag) history.back() }
  }, [])
}
function BackClose({ onClose }) { useBackClose(onClose); return null }

function Sheet({ title, onClose, children }) {
  useBackClose(onClose)
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>{title}</h3>
        {children}
        <button className="btn ghost full" onClick={onClose}>Never mind</button>
      </div>
    </div>
  )
}

export function summary(devs) {
  const red = devs.filter((d) => d.state === 'red').length
  const orange = devs.filter((d) => d.state === 'orange')
  if (devs.length === 0 || (red === 0 && orange.length === 0)) return 'All green — peace and quiet 😌'
  if (red === 0) {
    const empty = orange.some((d) => d.kind === 'machine'), air = orange.some((d) => d.kind === 'room')
    const what = empty && air ? 'needs emptying or airing out' : empty ? 'needs emptying 🧺' : 'is airing out 💨'
    return orange.length === 1 ? `Nothing busy — 1 thing ${what}` : `Nothing busy — ${orange.length} things ${what.replace('is ', 'are ').replace('needs', 'need')}`
  }
  const busy = red === 1 ? '1 thing busy' : `${red} things busy`
  if (orange.length === 0) return red === 1 ? '1 thing busy — hang tight.' : `${busy}. Busy house today!`
  return `${busy}, ${orange.length} waiting.`
}

function DeviceCard({ d, now, me, act, busy, notify, stale }) {
  const t = texts(d, now)
  const [sheet, setSheet] = useState(null) // 'start' | 'leave' | 'fix'
  const [custom, setCustom] = useState('')
  const go = async (action, minutes) => { setSheet(null); setCustom(''); await act(d.id, action, minutes) }
  // If the device changes underneath an open menu (someone else acted, or a timer ran out), close the menu
  // so nobody taps a choice that no longer makes sense.
  const prevState = useRef(d.state)
  useEffect(() => {
    if (prevState.current === d.state) return
    prevState.current = d.state
    if (sheet) {
      setSheet(null); setCustom('')
      notify(d.kind === 'machine' && d.state === 'red' && d.set_by && d.set_by !== me ? `Heads-up: ${d.set_by} just started the ${d.label.toLowerCase()} — your menu was closed.` : `Heads-up: the ${d.label.toLowerCase()} just changed (${texts(d, now).title.replace(/!$/, '')}) — your menu was closed.`)
    }
  }, [d.state]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = d.started_at && d.ends_at ? new Date(d.ends_at) - new Date(d.started_at) : 0
  const pct = total ? Math.min(100, Math.max(0, ((now - new Date(d.started_at)) / total) * 100)) : 0
  const minutesPicker = (action) => (
    <>
      <div className="presets">
        {PRESETS.map((m) => <button key={m} className="btn chip" onClick={() => go(action, m)}>{m} min</button>)}
      </div>
      <form className="custom" onSubmit={(e) => { e.preventDefault(); const n = parseInt(custom, 10); if (n > 0 && n <= 600) go(action, n) }}>
        <input type="number" inputMode="numeric" min="1" max="600" placeholder="Custom (minutes)" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn primary" disabled={!(parseInt(custom, 10) > 0)}>Start</button>
      </form>
    </>
  )
  return (
    <section id={`dev-${d.id}`} className={`card st-${d.state} ${stale ? 'stale' : ''}`}>
      <div className="card-top">
        <Light state={d.state} />
        <div className="info">
          <div className="dev-name">{d.emoji} {d.label}</div>
          <div className="dev-title">{t.title}</div>
          <div className="dev-sub">{t.sub}</div>
          {t.note && <div className="dev-note">{t.note}</div>}
        </div>
      </div>
      {d.kind === 'machine' && d.state === 'red' && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
      <div className="actions">
        {d.kind === 'machine' && d.state === 'green' && <button className="btn primary full" disabled={busy || stale} onClick={() => setSheet('start')}>▶️ Start</button>}
        {d.kind === 'machine' && d.state === 'red' && <>
          <button className="btn" disabled={busy || stale} onClick={() => go('done')}>✅ Already done</button>
          <button className="btn" disabled={busy || stale} onClick={() => setSheet('fix')}>⏱️ Adjust time</button>
          <button className="btn ghost" disabled={busy || stale} onClick={() => go('reset')}>↩️ Oops, cancel</button>
        </>}
        {d.kind === 'machine' && d.state === 'orange' && <>
          <button className="btn primary full" disabled={busy || stale} onClick={() => go('empty')}>🧺 Emptied it</button>
          <button className="btn ghost" disabled={busy || stale} onClick={() => setSheet('start')}>🔁 Another round</button>
        </>}
        {d.kind === 'room' && d.state === 'green' && <button className="btn danger full" disabled={busy || stale} onClick={() => go('occupy')}>{d.id === 'wc' ? '🚽 I’m on it' : '🚿 I’m showering'}</button>}
        {d.kind === 'room' && d.state === 'red' && <button className="btn primary full" disabled={busy || stale} onClick={() => setSheet('leave')}>🚪 I’m done</button>}
        {d.kind === 'room' && d.state === 'orange' && <>
          <button className="btn" disabled={busy || stale} onClick={() => go('free')}>✅ Not that bad, free!</button>
          <button className="btn danger" disabled={busy || stale} onClick={() => go('occupy')}>{d.id === 'wc' ? '🚽 Going in anyway' : '🚿 Shower anyway'}</button>
        </>}
      </div>
      {sheet === 'start' && <Sheet title={`Start the ${d.label.toLowerCase()} — how long is the program?`} onClose={() => setSheet(null)}>{minutesPicker('start')}</Sheet>}
      {sheet === 'fix' && <Sheet title="How many minutes are left?" onClose={() => setSheet(null)}>
        <div className="presets">{[5, 10, 15, 20, 30, 45].map((m) => <button key={m} className="btn chip" onClick={() => go('adjust', m)}>{m} more</button>)}</div>
        <form className="custom" onSubmit={(e) => { e.preventDefault(); const n = parseInt(custom, 10); if (n > 0 && n <= 600) go('adjust', n) }}>
          <input type="number" inputMode="numeric" min="1" max="600" placeholder="… minutes left" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button className="btn primary" disabled={!(parseInt(custom, 10) > 0)}>OK</button>
        </form>
      </Sheet>}
      {sheet === 'leave' && <Sheet title={d.id === 'wc' ? 'So… how’s the situation in there? 😅' : 'How’s it looking in there?'} onClose={() => setSheet(null)}>
        <button className="btn primary full big" disabled={busy} onClick={() => go('free')}>✅ Free! Fresh as a daisy</button>
        <button className="btn warn full big" disabled={busy} onClick={() => go('wait', 10)}>{d.id === 'wc' ? '💨 Give it 10 min' : '☁️ Let it air out — 10 min'}</button>
        <button className="btn warn full big" disabled={busy} onClick={() => go('wait', 15)}>{d.id === 'wc' ? '☢️ Seriously, give it 15 min' : '🌫️ Sauna mode — 15 min'}</button>
      </Sheet>}
    </section>
  )
}

function Avatar({ name, small }) {
  return <span className={`avatar ${small ? 'small' : ''}`} style={{ background: COLORS[name] || '#888' }}>{name?.[0]}</span>
}

function ChoreRow({ a, chore, me, now, toggle, compact, week, pending }) {
  const mine = a.people.includes(me)
  const saving = pending !== undefined
  const shown = saving ? pending : !!a.done_at
  const win = choreWindow(a, ymd(new Date(now)), shown)
  const locked = win.state === 'locked' || !!win.frozen
  return (
    <label className={`chore ${mine ? 'mine' : ''} ${shown ? 'done' : ''} ${locked ? 'locked' : ''} ${compact ? 'compact' : ''} ${saving ? 'saving' : ''}`}>
      <input type="checkbox" checked={shown} disabled={locked} onChange={() => toggle(a.id)} />
      <span className="check" />
      <span className="chore-main">
        <span className="chore-name">{chore.emoji} {chore.label}{!compact && <small> · {fmtRange(a.start_date, a.end_date)}</small>}{week && isBlock(a) && (cleanWeekOf(a) === week ? <i className="tag clean">★ clean week</i> : <i className="tag free">free week</i>)}</span>
        <span className="chore-people">{a.people.map((p) => <span key={p} className="pp"><Avatar name={p} small />{p}{p === me ? ' (you)' : ''}</span>)}</span>
        {locked && <span className="chore-win locked">🔒 Opens {fmtWDay(win.opens)} — too early to clean 🧽 <b>{win.days === 1 ? 'tomorrow' : `in ${win.days} days`}</b></span>}
        {win.state === 'open' && (!compact || win.limited) && <span className="chore-win open">✅ Open now — due by {fmtWDay(win.due)}</span>}
        {win.state === 'overdue' && <span className="chore-win overdue">⏰ Overdue — still tick it (until {fmtWDay(win.until)}), it counts as late</span>}
        {saving && <span className="chore-done">Saving…</span>}
        {!saving && a.done_at && <span className={`chore-done ${isLate(a) ? 'late' : ''}`}>Ticked off by {a.done_by} · {fmtWhen(a.done_at, new Date(now))}{isLate(a) ? ' · ⏰ late' : ''}</span>}
      </span>
    </label>
  )
}

export default function App() {
  const [me, setMe] = useState(() => localStorage.getItem('huis-me') || '')
  const [tab, setTab] = useState('licht')
  const [devices, setDevices] = useState([])
  const [chores, setChores] = useState([])
  const [assign, setAssign] = useState([])
  const [shame, setShame] = useState([])
  const [offset, setOffset] = useState(0)
  const [tickNow, setTickNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [live, setLive] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  const [fresh, setFresh] = useState(false) // true once the latest load succeeded
  const [pend, setPend] = useState({}) // chore id -> ticked state the user wants while it is being saved
  const pending = useRef({})
  const chRef = useRef(null)
  const meRef = useRef(me); meRef.current = me
  const offRef = useRef(0); offRef.current = offset
  const assignRef = useRef([]); assignRef.current = assign
  const [picker, setPicker] = useState(!localStorage.getItem('huis-me'))
  const now = tickNow + offset

  const load = useCallback(async () => {
    const t0 = Date.now()
    let n, d, c, a, sh
    try { [n, d, c, a, sh] = await Promise.all([
      supabase.rpc('huis_now'),
      supabase.from('huis_devices').select('*').order('sort'),
      supabase.from('huis_chores').select('*').order('sort'),
      supabase.from('huis_chore_assignments').select('*').order('start_date'),
      supabase.from('huis_shame').select('*'),
    ]) } catch (e) { setFresh(false); setLive(false); setErr(friendly(e)); return }
    if (n.data) setOffset(new Date(n.data).getTime() - (t0 + Date.now()) / 2)
    if (d.error || a.error) {
      setFresh(false)
      setErr(isNetErr(d.error || a.error) || !navigator.onLine ? '📴 You’re offline — can’t load the latest status.' : 'Can’t reach the database right now 😬')
    } else { setFresh(true); setErr((e) => (e.startsWith('📴') || e.startsWith('Can’t reach') ? '' : e)); if (chRef.current?.state === 'joined') setLive(true) }
    if (d.data) setDevices(d.data)
    if (c.data) setChores(c.data)
    if (a.data) setAssign((as) => { const old = new Map(as.map((x) => [x.id, x])); return a.data.map((r) => (newer(old.get(r.id), r) ? r : old.get(r.id))) })
    if (sh.data) setShame(sh.data)
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel('huis')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'huis_devices' }, (p) => p.new?.id && setDevices((ds) => ds.map((x) => (x.id === p.new.id ? p.new : x))))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'huis_chore_assignments' }, (p) => { if (p.eventType === 'DELETE') setAssign((as) => as.filter((x) => x.id !== p.old?.id)); else if (p.new?.id) setAssign((as) => mergeRow(as, p.new)); supabase.from('huis_shame').select('*').then((r) => r.data && setShame(r.data)) })
      .subscribe((s) => setLive(s === 'SUBSCRIBED' && navigator.onLine !== false))
    chRef.current = ch
    const poll = setInterval(load, 20000) // fallback if realtime hiccups
    const t = setInterval(() => setTickNow(Date.now()), 1000)
    const vis = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', vis)
    const off = () => { setOnline(false); setLive(false); setFresh(false); setErr('📴 You’re offline — showing the last known status.') }
    const on = () => { setOnline(true); load() }
    window.addEventListener('offline', off); window.addEventListener('online', on)
    if (navigator.onLine === false) off()
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('offline', off); window.removeEventListener('online', on) }
  }, [load])

  const act = async (id, action, minutes) => {
    if (!me) return setPicker(true)
    setBusy(true)
    const { data, error } = await supabase.rpc('huis_set', { p_device: id, p_action: action, p_by: devices.find((x) => x.id === id)?.kind === 'room' ? null : me, p_minutes: minutes ?? null })
    setBusy(false)
    if (error) { setErr(friendly(error)); if (!isNetErr(error)) load(); return }
    if (data?.[0]) setDevices((ds) => ds.map((x) => (x.id === id ? data[0] : x)))
    navigator.vibrate?.(30)
  }
  // Ticking: the UI shows what you want right away; requests for one chore go out one at a time with the
  // explicit wanted state (not "toggle") and a sequence number, so the last tap always wins in the database.
  const clearPend = (id) => { delete pending.current[id]; setPend((s) => { const n = { ...s }; delete n[id]; return n }) }
  const send = async (id) => {
    const p = pending.current[id]; const want = p.want
    const { data, error } = await supabase.rpc('huis_set_chore', { p_id: id, p_by: meRef.current, p_done: want, p_seq: Math.round(Date.now() + offRef.current) })
    if (error) { clearPend(id); setErr(friendly(error)); if (!isNetErr(error)) load(); return }
    if (data?.[0]) setAssign((as) => mergeRow(as, data[0]))
    if (p.want !== want) return send(id) // tapped again while saving → send the latest wish
    clearPend(id)
    supabase.from('huis_shame').select('*').then((r) => r.data && setShame(r.data))
  }
  const toggle = (id) => {
    if (!me) return setPicker(true)
    // every tap flips what the user currently sees (pending wish, else the server state)
    const done = pending.current[id] ? !pending.current[id].want : !assignRef.current.find((x) => x.id === id)?.done_at
    if (!navigator.onLine) return setErr('📴 You’re offline — ticking needs a connection. Try again when you’re back online.')
    setPend((s) => ({ ...s, [id]: done }))
    if (done) navigator.vibrate?.([20, 40, 20])
    if (pending.current[id]) { pending.current[id].want = done; return }
    pending.current[id] = { want: done }
    send(id)
  }
  const notify = useCallback((m) => setErr(m), [])
  const pick = (n) => { localStorage.setItem('huis-me', n); setMe(n); setPicker(false) }

  const today = ymd(new Date(now))
  const weekStart = mondayOf(today)
  const weekEnd = addDays(weekStart, 6)
  const choreMap = useMemo(() => Object.fromEntries(chores.map((c) => [c.id, c])), [chores])
  const thisWeek = chores.map((c) => assign.find((a) => a.chore_id === c.id && a.start_date <= today && a.end_date >= today)).filter(Boolean)
  const myTasks = thisWeek.filter((a) => a.people.includes(me) && cleanWeekOf(a) === weekStart) // a 2-week block only counts in its clean week
  // Last week's chores stay tickable (as late) during their grace week
  const overdue = assign.filter((a) => inGrace(a, today) && !thisWeek.includes(a)).sort((x, y) => (choreMap[x.chore_id]?.sort ?? 0) - (choreMap[y.chore_id]?.sort ?? 0))
  const myOverdue = overdue.filter((a) => a.people.includes(me) && !a.done_at)
  // Rolling schedule: exactly 7 weeks from the current week (the DB generator keeps them filled)
  const weeks = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const w = addDays(weekStart, 7 * i), we = addDays(w, 6)
    return { start: w, end: we, items: chores.map((c) => assign.find((a) => a.chore_id === c.id && a.start_date <= we && a.end_date >= w)).filter(Boolean) }
  }), [assign, chores, weekStart])
  // History: finished weeks (from the app start), each chore listed in the week its clean happened
  const history = useMemo(() => {
    const out = []
    for (let w = addDays(weekStart, -7); w >= HISTORY_FROM; w = addDays(w, -7)) {
      const items = chores.map((c) => assign.find((a) => a.chore_id === c.id && cleanWeekOf(a) === w)).filter(Boolean)
      if (items.length) out.push({ start: w, items })
    }
    return out
  }, [assign, chores, weekStart])
  const eff = devices.map((d) => effective(d, now))
  const ok = fresh && online // never claim "all green" without fresh data
  const leadText = ok ? summary(eff) : !online ? (devices.length ? '📴 Offline — showing the last known status, it may be out of date.' : '📴 You’re offline — can’t load the lights right now.') : devices.length ? '🔄 Reconnecting…' : '🔄 Connecting…'

  return (
    <div className="app">
      {DEMO && <div className="demo-banner"><span>Demo — fake data, changes stay on your device</span><button onClick={() => confirm('Reset the demo to its starting state?') && resetDemo()}>↺ Reset demo</button></div>}
      <header className="top">
        <div>
          <div className="hello">Hi {me || 'housemate'} 👋</div>
          <div className="date">{(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now)))} <span className={`dot ${live && ok ? 'live' : ''}`} title={!online ? 'Offline' : live && ok ? 'Live' : 'Connecting…'} /></div>
        </div>
        <button className="me-btn" onClick={() => setPicker(true)}>{me ? <Avatar name={me} /> : '🙋'}<span>switch</span></button>
      </header>

      {err && !(tab === 'licht' && !ok && /^📴 You’re offline — (can’t load|showing)/.test(err)) && <div className="err" onClick={() => setErr('')}>{err}</div>}

      {tab === 'licht' && <main>
        <p className={`lead ${ok ? '' : 'stale'}`}>{leadText}</p>
        <div className="strip">
          {eff.map((d) => <button key={d.id} className={`mini st-${d.state}`} onClick={() => document.getElementById('dev-' + d.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><i />{d.label}</button>)}
        </div>
        {eff.map((d) => <DeviceCard key={d.id} d={d} now={now} me={me} act={act} busy={busy} notify={notify} stale={!ok} />)}
        {!devices.length && online && <p className="muted center">Loading…</p>}
      </main>}

      {tab === 'rooster' && <main>
        <section className="panel">
          <h2>This week <small>{weekLabel(weekStart)}</small></h2>
          {me && <div className={`mine-banner ${myTasks.length ? '' : 'none'}`}>
            {myTasks.length
              ? <>⭐ Your tasks: <b>{myTasks.map((a) => choreMap[a.chore_id]?.label).join(', ')}</b>{myTasks.every((a) => a.done_at) ? ' — all done, legend! 🏆' : ''}</>
              : <>🎉 Nothing for you this week. Enjoy!</>}
          </div>}
          {overdue.length > 0 && <div className="overdue-box">
            <h3>⏰ Still open from last week</h3>
            {overdue.map((a) => <ChoreRow key={a.id} a={a} chore={choreMap[a.chore_id]} me={me} now={now} toggle={toggle} pending={pend[a.id]} />)}
          </div>}
          {thisWeek.map((a) => <ChoreRow key={a.id} a={a} chore={choreMap[a.chore_id]} me={me} now={now} toggle={toggle} week={weekStart} pending={pend[a.id]} />)}
          {!thisWeek.length && <p className="muted">No tasks found for this week. Schedule expired?</p>}
        </section>
        <HallOfShame rows={shame} me={me} />
        <h2 className="ov-title">Next 7 weeks</h2>
        {weeks.map((w) => (
          <section key={w.start} className={`panel week ${w.start === weekStart ? 'current' : ''} ${w.end < today ? 'past' : ''}`}>
            <h4>{w.start === weekStart ? '👉 ' : ''}{weekLabel(w.start)}</h4>
            {w.items.map((a) => <ChoreRow key={a.id + w.start} a={a} chore={choreMap[a.chore_id]} me={me} now={now} toggle={toggle} compact week={w.start} pending={pend[a.id]} />)}
            {!w.items.length && <p className="muted small">Being scheduled…</p>}
          </section>
        ))}
        <p className="muted center small">Shower & Laundry room run in 2-week blocks: free first week, clean in the ★ second week — one tick per block.</p>
        <History weeks={history} choreMap={choreMap} me={me} now={now} />
      </main>}

      <nav className="tabs">
        <button className={tab === 'licht' ? 'on' : ''} onClick={() => setTab('licht')}><span>🚦</span>Traffic lights</button>
        <button className={tab === 'rooster' ? 'on' : ''} onClick={() => setTab('rooster')}><span>🧽</span>Chores{(myOverdue.length > 0 || myTasks.some((a) => choreWindow(a, today).state === 'open')) && <i className="badge" />}</button>
      </nav>

      {picker && <div className="picker">
        <div className="picker-box">
          <div className="big-emoji">🏠</div>
          <h1>Who are you?</h1>
          <p>Pick your name, so everyone knows who’s hogging the toilet 😉</p>
          <div className="people">
            {PEOPLE.map((p) => <button key={p} className={`person ${me === p ? 'sel' : ''}`} style={{ '--c': COLORS[p] }} onClick={() => pick(p)}><Avatar name={p} />{p}</button>)}
          </div>
          {me && <><BackClose onClose={() => setPicker(false)} /><button className="btn ghost full" onClick={() => setPicker(false)}>Back</button></>}
        </div>
      </div>}
    </div>
  )
}
