-- Example starter data for supabase/schema.sql (placeholder names — use your own housemates,
-- and the same names in VITE_HOUSEMATES).
insert into public.huis_people (name, sort, color) values
  ('Alex', 1, '#f97316'), ('Sam', 2, '#ec4899'), ('Jamie', 3, '#3b82f6'), ('Robin', 4, '#10b981')
on conflict do nothing;

insert into public.huis_devices (id, kind, label, emoji, sort) values
  ('wasmachine', 'machine', 'Washing machine', '🫧', 1),
  ('droger',     'machine', 'Dryer',           '🌀', 2),
  ('wc',         'room',    'Toilet',          '🚽', 3),
  ('douche',     'room',    'Shower',          '🚿', 4)
on conflict do nothing;

-- open_offset_days: weekly chores can be ticked from Thursday (day 3), 2-week chores from their second week (day 7)
insert into public.huis_chores (id, label, emoji, cadence, sort, open_offset_days) values
  ('toilet', 'Toilet',       '🧻', 'weekly',        1, 3),
  ('gang',   'Hallway',      '🧹', 'weekly',        2, 3),
  ('douche', 'Shower',       '🛁', 'every 2 weeks', 3, 7),
  ('washok', 'Laundry room', '🧺', 'every 2 weeks', 4, 7)
on conflict do nothing;

-- Fill the first 7 weeks right away (pg_cron keeps it rolling afterwards)
select public.huis_generate();
