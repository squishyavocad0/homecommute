// Demo backend: a tiny in-browser stand-in for the Supabase client used by App.jsx.
// It mirrors the database rules (huis_set, huis_tick, huis_set_chore, huis_generate, huis_shame)
// and keeps all state in this visitor's localStorage. No network calls at all.
import { PEOPLE, HISTORY_FROM, SHAME_FROM, DEMO_ORIGIN_KEY } from '../config.js'

const KEY = 'ourhouse-demo-state-v1'
const TZ = 'Europe/Amsterdam'
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const diff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000)
const monday = (s) => add(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7))
const today = () => ymd(new Date())
const nowIso = () => new Date().toISOString()
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString()
// an Amsterdam wall-clock time on a given day, as ISO (good enough for the demo: uses the current offset)
const at = (day, hh, mm = 0) => { const off = new Date().toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).match(/GMT([+-]\d\d):(\d\d)/); return new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${off ? off[1] + ':' + off[2] : 'Z'}`).toISOString() }

const CHORES = [
  { id: 'toilet', label: 'Toilet', emoji: '🧻', cadence: 'weekly', sort: 1, open_offset_days: 3 },
  { id: 'gang', label: 'Hallway', emoji: '🧹', cadence: 'weekly', sort: 2, open_offset_days: 3 },
  { id: 'douche', label: 'Shower', emoji: '🛁', cadence: 'every 2 weeks', sort: 3, open_offset_days: 7 },
  { id: 'washok', label: 'Laundry room', emoji: '🧺', cadence: 'every 2 weeks', sort: 4, open_offset_days: 7 },
]
const offsetOf = (id) => CHORES.find((c) => c.id === id).open_offset_days

let S = null
const save = () => localStorage.setItem(KEY, JSON.stringify(S))
const listeners = []
const emit = (table, eventType, row) => listeners.forEach((l) => l.table === table && l.cb({ eventType, new: row, old: row }))

// ---- fair self-rotating schedule (same algorithm as huis_generate in SQL) ----
function generate(day) {
  const anchor = add(HISTORY_FROM, -7) // 2-week blocks start here + 14k, clean week = second week
  const A = S.assignments, inserted = []
  const ins = (chore_id, start, len, who) => {
    const row = { id: S.nextId++, chore_id, start_date: start, end_date: add(start, len - 1), people: [who], done_by: null, done_at: null, opens_on: add(start, offsetOf(chore_id)) }
    A.push(row); inserted.push(row)
  }
  const stats = (n) => {
    const mine = A.filter((a) => a.people.includes(n)), cnt = mine.filter((a) => a.end_date >= SHAME_FROM)
    const last = (c) => mine.filter((a) => a.chore_id === c).reduce((m, a) => (a.opens_on > m ? a.opens_on : m), '2000-01-01')
    const k = (c) => cnt.filter((a) => a.chore_id === c).length
    return { name: n, tot: cnt.length, sh: k('douche'), la: k('washok'), t: k('toilet'), h: k('gang'), lsh: last('douche'), lla: last('washok'), lt: last('toilet'), lh: last('gang') }
  }
  const cmp = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0 }
  const best = (pairs, key) => pairs.map((p) => [key(p), p]).sort((a, b) => cmp(a[0], b[0]))[0]?.[1]
  const pairs = (xs) => xs.flatMap((a) => xs.filter((b) => b.name !== a.name).map((b) => [a, b]))
  const v = (d) => diff('2000-01-01', d)
  const mon = monday(day)
  for (let i = 0; i < 8; i++) { // 8 weeks, so 7 stay visible right after the Monday rollover
    const w = add(mon, 7 * i)
    if (diff(anchor, w) % 14 === 0 && !A.some((a) => a.chore_id === 'douche' && a.start_date === w)) {
      const st = PEOPLE.map(stats)
      const p = best(pairs(st), ([s, l]) => [s.sh + l.la, s.tot + l.tot, v(s.lsh) + v(l.lla), s.name, l.name])
      ins('douche', w, 14, p[0].name); ins('washok', w, 14, p[1].name)
    }
    if (!A.some((a) => a.chore_id === 'toilet' && a.start_date === w)) {
      const blockers = A.filter((a) => (a.chore_id === 'douche' || a.chore_id === 'washok') && add(a.start_date, 7) === w).flatMap((a) => a.people)
      const prev = (c, n) => A.some((a) => a.chore_id === c && a.start_date === add(w, -7) && a.people.includes(n))
      const st = PEOPLE.filter((n) => !blockers.includes(n)).map(stats)
      const p = best(pairs(st).filter(([t, h]) => !prev('toilet', t.name) && !prev('gang', h.name)),
        ([t, h]) => [t.tot + h.tot, Math.max(t.tot, h.tot), t.t + h.h, v(t.lt) + v(h.lh), t.name, h.name])
      if (!p) throw new Error('no weekly assignment for ' + w)
      ins('toilet', w, 7, p[0].name); ins('gang', w, 7, p[1].name)
    }
  }
  return inserted
}

function seed() {
  S = { nextId: 1, assignments: [], devices: [] }
  const t = today()
  // build the schedule week by week from one week before the start, exactly like the cron job would have
  for (let w = add(HISTORY_FROM, -7); w <= monday(t); w = add(w, 7)) generate(w)
  // past chores: mostly done on time, plus a couple of late / missed ones for the Hall of Shame
  const past = S.assignments.filter((a) => a.end_date < t && a.end_date >= SHAME_FROM).sort((a, b) => (a.end_date < b.end_date ? -1 : 1))
  const bad = { missed: new Set(), late: new Set() }
  const pickFor = (kind, n) => { for (const a of past) { if (bad.missed.has(a) || bad.late.has(a)) continue; if ([...bad.missed, ...bad.late].some((b) => b.people[0] === a.people[0]) && n > 1) continue; bad[kind].add(a); if (--n === 0) break } }
  pickFor('missed', 1); pickFor('late', 2)
  // make one person a repeat offender so the board has a clear "winner"
  const repeat = past.find((a) => !bad.missed.has(a) && !bad.late.has(a) && a.people[0] === [...bad.late][0]?.people[0]); if (repeat) bad.missed.add(repeat)
  S.assignments.forEach((a, i) => {
    if (a.end_date < SHAME_FROM || (a.end_date < t && !bad.missed.has(a))) {
      const who = a.people[0]
      a.done_by = i % 9 === 4 ? PEOPLE.find((p) => p !== who) : who // now and then a housemate covers for someone
      a.done_at = bad.late.has(a) ? [at(add(a.end_date, 1 + (i % 2)), 11, 15), nowIso()].sort()[0] : at(add(a.opens_on, (i * 7) % Math.max(1, diff(a.opens_on, a.end_date) + 1)), 18 + (i % 4), (i * 13) % 60)
    }
  })
  // this week: tick one chore that is already open, by someone else than whoever visits first
  const open = S.assignments.find((a) => a.start_date <= t && a.end_date >= t && a.opens_on <= t && !a.done_at)
  if (open) { open.done_by = open.people[0]; open.done_at = at(t, 9, 30) < nowIso() ? at(t, 9, 30) : nowIso() }
  const d = (id, kind, label, emoji, sort, rest) => ({ id, kind, label, emoji, sort, state: 'green', set_by: null, started_at: null, ends_at: null, updated_at: nowIso(), ...rest })
  S.devices = [
    d('wasmachine', 'machine', 'Washing machine', '🫧', 1, { state: 'red', set_by: PEOPLE[1], started_at: minutes(-53), ends_at: minutes(37) }),
    d('droger', 'machine', 'Dryer', '🌀', 2, { state: 'orange', set_by: PEOPLE[3], started_at: minutes(-95) }),
    d('wc', 'room', 'Toilet', '🚽', 3, { state: 'red', started_at: minutes(-4) }),
    d('douche', 'room', 'Shower', '🚿', 4, { state: 'orange', started_at: minutes(-20), ends_at: minutes(2) }),
  ]
  save()
}

function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)) } catch { S = null }
  if (!S?.devices?.length) seed()
}

// same rules as huis_tick(): timers move machines red→orange, rooms orange→green
function tick() {
  const n = Date.now()
  for (const d of S.devices) {
    if (!d.ends_at || new Date(d.ends_at).getTime() > n) continue
    if (d.kind === 'machine' && d.state === 'red') Object.assign(d, { state: 'orange', ends_at: null, updated_at: nowIso() })
    else if (d.kind === 'room' && d.state === 'orange') Object.assign(d, { state: 'green', ends_at: null, set_by: null, updated_at: nowIso() })
    else continue
    emit('huis_devices', 'UPDATE', { ...d })
  }
  generate(today()).forEach((r) => emit('huis_chore_assignments', 'INSERT', { ...r }))
  save()
}

function shame() {
  const t = today(), ev = {}
  for (const a of S.assignments) {
    if (a.end_date < SHAME_FROM || t <= a.end_date) continue
    // one extra (grace) week to still tick it — counts as late; after that it is missed
    const kind = !a.done_at ? (t > add(a.end_date, 7) ? 'missed' : 'late') : ymd(new Date(a.done_at)) > a.end_date ? 'late' : null
    if (!kind) continue
    for (const p of a.people) { ev[p] ??= { person: p, missed: 0, late: 0, total: 0 }; ev[p][kind]++; ev[p].total++ }
  }
  return Object.values(ev).sort((a, b) => b.total - a.total || b.missed - a.missed || (a.person < b.person ? -1 : 1))
}

const fmtOpens = (s) => { const d = new Date(s + 'T00:00:00Z'); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}` }

const RPC = {
  huis_now: () => nowIso(),
  huis_set: ({ p_device, p_action, p_by, p_minutes }) => {
    const d = S.devices.find((x) => x.id === p_device)
    if (!d) throw new Error('unknown device')
    if (p_minutes != null && (p_minutes < 1 || p_minutes > 600)) throw new Error('invalid duration')
    const u = { updated_at: nowIso() }
    if (d.kind === 'machine') {
      if (!PEOPLE.includes(p_by)) throw new Error('unknown housemate')
      let act = p_action
      if (act === 'start' && d.state === 'red' && d.set_by === p_by) act = 'adjust'
      const hhmm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
      if (act === 'start') {
        if (d.state === 'red') throw new Error(`The ${d.label.toLowerCase()} is already running (${d.set_by ? d.set_by + '’s' : 'someone’s'} load, done at ${hhmm(d.ends_at)}) — no need to start it again 🙂`)
        Object.assign(u, { state: 'red', set_by: p_by, started_at: nowIso(), ends_at: minutes(p_minutes ?? 60) })
      } else if (act === 'adjust') { // only the time changes; the load keeps its owner
        if (d.state !== 'red') throw new Error(`The ${d.label.toLowerCase()} isn’t running anymore — nothing to adjust 🙂`)
        Object.assign(u, { ends_at: minutes(p_minutes ?? 10) })
      } else if (act === 'done') {
        if (d.state !== 'red') throw new Error(`The ${d.label.toLowerCase()} isn’t running anymore 🙂`)
        Object.assign(u, { state: 'orange', ends_at: null })
      }
      else if (act === 'empty' || act === 'reset') Object.assign(u, { state: 'green', set_by: p_by, started_at: null, ends_at: null })
      else throw new Error('invalid action')
    } else { // Toilet & Shower are anonymous: never store a name
      if (p_action === 'occupy') Object.assign(u, { state: 'red', set_by: null, started_at: nowIso(), ends_at: null })
      else if (p_action === 'wait') Object.assign(u, { state: 'orange', set_by: null, ends_at: minutes(p_minutes ?? 10) })
      else if (p_action === 'free' || p_action === 'reset') Object.assign(u, { state: 'green', set_by: null, started_at: null, ends_at: null })
      else throw new Error('invalid action')
    }
    Object.assign(d, u)
    return [{ ...d }]
  },
  huis_set_chore: ({ p_id, p_by, p_done, p_seq = null }) => {
    if (typeof p_done !== 'boolean') throw new Error('p_done must be true or false')
    if (!PEOPLE.includes(p_by)) throw new Error('unknown housemate')
    const a = S.assignments.find((x) => x.id === p_id)
    if (!a) throw new Error('unknown chore')
    if (p_seq != null && a.tick_seq != null && p_seq < a.tick_seq) return [{ ...a }] // an older tap never wins
    if (!!a.done_at === p_done) { if (p_seq != null) a.tick_seq = p_seq; return [{ ...a }] }
    if (p_done && today() < a.opens_on) throw new Error(`too early — this one opens ${fmtOpens(a.opens_on)}`)
    if (today() > add(a.end_date, 7)) throw new Error(`too late — this one could be ticked until ${fmtOpens(add(a.end_date, 7))}`)
    Object.assign(a, { done_by: p_done ? p_by : null, done_at: p_done ? nowIso() : null, tick_seq: p_seq ?? a.tick_seq ?? null })
    return [{ ...a }]
  },
}

const TABLES = {
  huis_devices: () => S.devices,
  huis_chores: () => CHORES,
  huis_chore_assignments: () => S.assignments,
  huis_shame: () => shame(),
}

const reply = (fn) => new Promise((res) => setTimeout(() => {
  try { tick(); const data = fn(); save(); res({ data: JSON.parse(JSON.stringify(data)), error: null }) } catch (e) { res({ data: null, error: { message: e.message } }) }
}, 60))

class Query {
  constructor(t) { this.t = t; this.col = null }
  select() { return this }
  order(col) { this.col = col; return this }
  then(ok, ko) {
    return reply(() => { const rows = [...(TABLES[this.t]?.() ?? [])]; if (this.col) rows.sort((a, b) => (a[this.col] < b[this.col] ? -1 : a[this.col] > b[this.col] ? 1 : a.id - b.id)); return rows }).then(ok, ko)
  }
}

let timer = null
export const supabase = {
  from: (t) => new Query(t),
  rpc: (name, args = {}) => reply(() => { if (!RPC[name]) throw new Error('unknown function ' + name); return RPC[name](args) }),
  channel() {
    const ch = {
      on(_type, f, cb) { listeners.push({ table: f.table, cb, ch }); return ch },
      subscribe(status) { timer ??= setInterval(tick, 1000); setTimeout(() => status?.('SUBSCRIBED'), 50); return ch },
    }
    return ch
  },
  removeChannel(ch) { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].ch === ch) listeners.splice(i, 1) },
}

export function resetDemo() {
  localStorage.removeItem(KEY); localStorage.removeItem(DEMO_ORIGIN_KEY); localStorage.removeItem('huis-me')
  location.reload()
}

load()
