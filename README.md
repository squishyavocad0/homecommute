# Our House

**▶ Live demo: [our-house-demo.vercel.app](https://our-house-demo.vercel.app)** — fake housemates and fake data; everything you click stays in your own browser.

Our House is a small mobile-first web app (installable PWA) for a shared house with four housemates. It answers the two questions every shared house has, all day long: *is the washing machine / toilet / shower free?* and *whose turn is it to clean?*

## Features

### 🚦 Live traffic lights
- **Washing machine, dryer, toilet and shower** each get a traffic light: green = free, red = in use, orange = done / airing out.
- Start the washer or dryer with a program length; a countdown runs and the light **turns orange automatically** when the timer ends ("needs emptying"), green again when someone taps *Emptied it*.
- **Washer and dryer show whose laundry it is**, so you know whom to nudge.
- **Toilet and shower are anonymous** — no name is ever sent or stored for them (enforced in the database), just playful status texts like *"Occupied 🚽 Someone is on the throne 🤔"*. Leaving with "give it 10 min" turns the light orange and back to green on its own.
- Updates arrive in real time on every phone (Supabase Realtime), with a polling fallback.

### 🧽 Fair, self-rotating chore schedule
- Toilet and Hallway are weekly; Shower and Laundry room run in 2-week blocks (the first week is free, the clean happens in the second week).
- A **server-side generator** (Postgres + pg_cron) always keeps **7 weeks** scheduled ahead, with ISO week numbers ("Week 43 · 19–25 Oct").
- Fairness is counted in **actual cleans** (a 2-week block = 1 clean): totals stay within one of each other forever, nobody gets two cleans in the same week, nobody repeats the same weekly chore back-to-back, Shower/Laundry blocks rotate equally, ties go to whoever did that chore least recently.
- **Tick windows**: weekly chores can be ticked from Thursday to Sunday, 2-week chores only in their second week ("🔒 Opens Thu 29 Oct — too early to clean"). Enforced in the database, not just the UI.
- Finished weeks move to a **History** section: who was assigned, who ticked it and when, on time / late / missed.
- **Hall of Shame 🧻**: late and missed chores are counted server-side and shown on a leaderboard (hidden while everyone behaves).

## Tech stack

- **Frontend:** Vite + React 18, plain CSS, installable PWA (manifest + service worker)
- **Backend:** Supabase — Postgres tables `huis_*`, row-level security (read-only for clients), all writes through `security definer` RPC functions, **Realtime** for live updates, **pg_cron** running `huis_tick()` (timers) and `huis_generate()` (schedule) every minute
- **Hosting:** Vercel (static build)
- **Demo mode:** the same codebase built with `VITE_DEMO=1` swaps the Supabase client for an in-browser fake backend (`src/demo/backend.js`) that mirrors the database rules and stores everything in `localStorage`. The demo bundle contains no Supabase client and no keys.

## Setup

1. **Create a Supabase project** (free tier is fine) and enable the `pg_cron` extension (Dashboard → Database → Extensions).
2. **Apply the schema:** open the SQL editor and run [`supabase/schema.sql`](supabase/schema.sql) (tables, functions/RPCs, RLS policies, realtime publication, the `huis_tick` cron job).
   Adjust the two dates mentioned at the top of the file to your own start week first. Or from a terminal:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
   ```
3. **Add starter data:** edit and run [`supabase/seed.example.sql`](supabase/seed.example.sql) (housemates, devices, chores; it also generates the first 7 weeks).
4. **Configure the app:**
   ```bash
   cp .env.example .env.local
   # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (the public anon/publishable key — never the service_role key)
   # and VITE_HOUSEMATES (same names as in huis_people)
   npm install
   npm run dev
   ```
5. **Deploy:** import the repo in Vercel (framework: Vite), add the same three environment variables, deploy.

### Demo build

```bash
npm run build:demo   # (= VITE_DEMO=1 vite build) → dist/ with fake data, own app name ("Our House Demo") and service-worker cache
```
No environment variables or Supabase project needed. Use *Reset demo* in the banner to start over.

## Project layout

```
src/App.jsx            UI (traffic lights, chores, history, Hall of Shame)
src/config.js          build-time config (demo flag, housemates, start dates)
src/supabase.js        Supabase client (real app)
src/demo/backend.js    fake in-browser backend (demo build only)
public/                icons, manifest, service worker
supabase/schema.sql    full database schema (no data)
supabase/seed.example.sql  example starter data
```
