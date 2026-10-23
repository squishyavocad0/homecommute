// Build-time switch: `VITE_DEMO=1 vite build` produces the self-contained demo (fake data, no Supabase).
export const DEMO = import.meta.env.VITE_DEMO === '1'

// Housemates come from VITE_HOUSEMATES (comma-separated, same names as the huis_people table),
// so real names never live in the repo. The demo always uses fake ones.
const PALETTE = ['#f97316', '#ec4899', '#3b82f6', '#10b981', '#a855f7', '#eab308']
const DEMO_PEOPLE = ['Alex', 'Sam', 'Jamie', 'Robin']
export const PEOPLE = DEMO ? DEMO_PEOPLE : (import.meta.env.VITE_HOUSEMATES || '').split(',').map((s) => s.trim()).filter(Boolean)
export const COLORS = Object.fromEntries(PEOPLE.map((p, i) => [p, PALETTE[i % PALETTE.length]]))

// First week the app "existed": history + Hall of Shame count from here.
// Real app: fixed date. Demo: three weeks before the visitor's first visit (stored on their device).
export const DEMO_ORIGIN_KEY = 'ourhouse-demo-origin'
function demoOrigin() {
  let o = localStorage.getItem(DEMO_ORIGIN_KEY)
  if (!o) {
    const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date()) + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 21)
    o = d.toISOString().slice(0, 10)
    localStorage.setItem(DEMO_ORIGIN_KEY, o)
  }
  return o
}
const plus = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
export const HISTORY_FROM = DEMO ? demoOrigin() : '2026-10-19'
export const SHAME_FROM = DEMO ? plus(HISTORY_FROM, 6) : '2026-10-25' // periods ending before this predate the app
