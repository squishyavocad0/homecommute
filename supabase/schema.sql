-- Our House — Supabase schema (schema only, no data)
-- Exported from the live project by introspection. Apply in the Supabase SQL editor
-- (or `psql "$DATABASE_URL" -f supabase/schema.sql`). Requires the pg_cron extension
-- (Dashboard → Database → Extensions) for the minute job at the bottom.
--
-- Dates hard-coded in the functions:
--   2026-10-12  anchor of the 2-week Shower/Laundry blocks (blocks start on anchor + 14k days)
--   2026-10-25  first period end that counts for fairness and the Hall of Shame
-- Change them to your own start week before applying.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------- tables

create table if not exists public.huis_people (
  name text not null,
  sort integer default 0 not null,
  color text,
  constraint huis_people_pkey PRIMARY KEY (name)
);

create table if not exists public.huis_chores (
  id text not null,
  label text not null,
  emoji text,
  cadence text not null,
  sort integer default 0 not null,
  open_offset_days integer,
  constraint huis_chores_pkey PRIMARY KEY (id),
  constraint huis_chores_open_offset_days_check CHECK (((open_offset_days IS NULL) OR (open_offset_days >= 0)))
);

create table if not exists public.huis_devices (
  id text not null,
  kind text not null,
  label text not null,
  emoji text,
  sort integer default 0 not null,
  state text default 'green'::text not null,
  set_by text,
  started_at timestamp with time zone,
  ends_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  constraint huis_devices_pkey PRIMARY KEY (id),
  constraint huis_devices_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.huis_people(name),
  constraint huis_devices_kind_check CHECK ((kind = ANY (ARRAY['machine'::text, 'room'::text]))),
  constraint huis_devices_state_check CHECK ((state = ANY (ARRAY['green'::text, 'orange'::text, 'red'::text]))),
  constraint huis_rooms_anonymous CHECK (((kind = 'machine'::text) OR (set_by IS NULL)))
);

create table if not exists public.huis_chore_assignments (
  id bigint generated always as identity not null,
  chore_id text not null,
  start_date date not null,
  end_date date not null,
  people text[] not null,
  done_by text,
  done_at timestamp with time zone,
  opens_on date not null,
  constraint huis_chore_assignments_chore_id_start_date_key UNIQUE (chore_id, start_date),
  constraint huis_chore_assignments_pkey PRIMARY KEY (id),
  constraint huis_chore_assignments_chore_id_fkey FOREIGN KEY (chore_id) REFERENCES public.huis_chores(id),
  constraint huis_chore_assignments_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.huis_people(name),
  constraint huis_chore_assignments_check CHECK ((end_date >= start_date))
);

-- ---------------------------------------------------------------- functions

CREATE OR REPLACE FUNCTION public.huis_now()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ select now() $function$;

CREATE OR REPLACE FUNCTION public.huis_deadline(p_end date)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
AS $function$ select ((p_end + 1)::timestamp at time zone 'Europe/Amsterdam') $function$;

CREATE OR REPLACE FUNCTION public.huis_opens_on(p_chore text, p_start date, p_end date)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_start + least(greatest(coalesce(
    (select open_offset_days from public.huis_chores where id = p_chore),
    case when (p_end - p_start + 1) <= 7 then (p_end - p_start + 1) - 4 when (p_end - p_start + 1) <= 14 then (p_end - p_start + 1) - 7 else (p_end - p_start + 1) - 14 end), 0), p_end - p_start)
$function$;

CREATE OR REPLACE FUNCTION public.huis_assign_opens_on()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin new.opens_on := public.huis_opens_on(new.chore_id, new.start_date, new.end_date); return new; end $function$;

CREATE OR REPLACE FUNCTION public.huis_chore_offset_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin update public.huis_chore_assignments set opens_on = public.huis_opens_on(chore_id, start_date, end_date) where chore_id = new.id; return new; end $function$;

CREATE OR REPLACE FUNCTION public.huis_tick()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.huis_devices set state = case when kind='machine' then 'orange' else 'green' end,
    ends_at = null, updated_at = now(),
    set_by = case when kind='machine' then set_by else null end
  where ends_at is not null and ends_at <= now()
    and ((kind='machine' and state='red') or (kind='room' and state='orange'));
$function$;

CREATE OR REPLACE FUNCTION public.huis_set(p_device text, p_action text, p_by text, p_minutes integer DEFAULT NULL::integer)
 RETURNS SETOF huis_devices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.huis_devices;
begin
  perform public.huis_tick();
  select * into d from public.huis_devices where id = p_device for update;
  if not found then raise exception 'unknown device'; end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 600) then raise exception 'invalid duration'; end if;
  if d.kind = 'machine' then
    if p_by is null or not exists (select 1 from public.huis_people where name = p_by) then raise exception 'unknown housemate'; end if;
    if p_action = 'start' then
      update public.huis_devices set state='red', set_by=p_by, started_at=now(), ends_at=now()+make_interval(mins=>coalesce(p_minutes,60)), updated_at=now() where id=p_device;
    elsif p_action = 'done' then
      update public.huis_devices set state='orange', set_by=p_by, ends_at=null, updated_at=now() where id=p_device;
    elsif p_action in ('empty','reset') then
      update public.huis_devices set state='green', set_by=p_by, started_at=null, ends_at=null, updated_at=now() where id=p_device;
    else raise exception 'invalid action'; end if;
  else
    -- Toilet & Shower are anonymous: the name is never stored (p_by is ignored)
    if p_action = 'occupy' then
      update public.huis_devices set state='red', set_by=null, started_at=now(), ends_at=null, updated_at=now() where id=p_device;
    elsif p_action = 'wait' then
      update public.huis_devices set state='orange', set_by=null, ends_at=now()+make_interval(mins=>coalesce(p_minutes,10)), updated_at=now() where id=p_device;
    elsif p_action in ('free','reset') then
      update public.huis_devices set state='green', set_by=null, started_at=null, ends_at=null, updated_at=now() where id=p_device;
    else raise exception 'invalid action'; end if;
  end if;
  return query select * from public.huis_devices where id=p_device;
end $function$;

CREATE OR REPLACE FUNCTION public.huis_toggle_chore(p_id bigint, p_by text, p_done boolean)
 RETURNS SETOF huis_chore_assignments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_open date; v_today date := (now() at time zone 'Europe/Amsterdam')::date;
begin
  if p_by is null or not exists (select 1 from public.huis_people where name = p_by) then raise exception 'unknown housemate'; end if;
  select opens_on into v_open from public.huis_chore_assignments where id = p_id;
  if not found then raise exception 'unknown chore'; end if;
  if p_done and v_today < v_open then
    raise exception 'too early — this one opens %', to_char(v_open, 'Dy FMDD Mon');
  end if;
  update public.huis_chore_assignments set done_by = case when p_done then p_by else null end, done_at = case when p_done then now() else null end where id = p_id;
  return query select * from public.huis_chore_assignments where id = p_id;
end $function$;

CREATE OR REPLACE FUNCTION public.huis_shame_at(p_now timestamp with time zone)
 RETURNS TABLE(person text, missed bigint, late bigint, total bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ev as (
    select p as person,
      case when a.done_at is null then 'missed' when a.done_at >= public.huis_deadline(a.end_date) then 'late' end as kind
    from public.huis_chore_assignments a cross join lateral unnest(a.people) p
    where a.end_date >= date '2026-10-25' and p_now >= public.huis_deadline(a.end_date)
  )
  select person, count(*) filter (where kind = 'missed'), count(*) filter (where kind = 'late'), count(*)
  from ev where kind is not null group by person
  order by count(*) desc, count(*) filter (where kind = 'missed') desc, person
$function$;

CREATE OR REPLACE FUNCTION public.huis_generate(p_today date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Europe/Amsterdam')::date);
  v_mon date := v_today - ((extract(isodow from v_today)::int) - 1);
  c_anchor constant date := date '2026-10-12';   -- 2-week blocks start on anchor + 14k
  c_from constant date := date '2026-10-25';     -- fairness counts periods ending on/after this
  w date; v_n int := 0; v_a text; v_b text;
begin
  perform pg_advisory_xact_lock(hashtext('huis_generate'));
  for i in 0..6 loop
    w := v_mon + 7 * i;
    -- 1) 2-week block (Shower + Laundry room) starting this week: least Shower/Laundry count, then fewest total cleans, then least recently
    if (w - c_anchor) % 14 = 0 and not exists (select 1 from huis_chore_assignments where chore_id = 'douche' and start_date = w) then
      with st as (
        select p.name,
          count(a.id) filter (where a.end_date >= c_from) tot,
          count(a.id) filter (where a.end_date >= c_from and a.chore_id = 'douche') sh,
          count(a.id) filter (where a.end_date >= c_from and a.chore_id = 'washok') la,
          coalesce(max(a.opens_on) filter (where a.chore_id = 'douche'), date '2000-01-01') - date '2000-01-01' lsh,
          coalesce(max(a.opens_on) filter (where a.chore_id = 'washok'), date '2000-01-01') - date '2000-01-01' lla
        from huis_people p left join huis_chore_assignments a on p.name = any(a.people) group by p.name)
      select s.name, l.name into v_a, v_b from st s cross join st l where s.name <> l.name
      order by s.sh + l.la, s.tot + l.tot, s.lsh + l.lla, s.name, l.name limit 1;
      if not found then raise exception 'huis_generate: no block assignment for %', w; end if;
      insert into huis_chore_assignments (chore_id, start_date, end_date, people) values
        ('douche', w, w + 13, array[v_a]), ('washok', w, w + 13, array[v_b]);
      v_n := v_n + 2;
    end if;
    -- 2) Toilet + Hallway: not the block cleaners of this week, not same task as last week; fewest total cleans, then per-task count, then least recently
    if not exists (select 1 from huis_chore_assignments where chore_id = 'toilet' and start_date = w) then
      with st as (
        select p.name,
          count(a.id) filter (where a.end_date >= c_from) tot,
          count(a.id) filter (where a.end_date >= c_from and a.chore_id = 'toilet') t,
          count(a.id) filter (where a.end_date >= c_from and a.chore_id = 'gang') h,
          coalesce(max(a.opens_on) filter (where a.chore_id = 'toilet'), date '2000-01-01') - date '2000-01-01' lt,
          coalesce(max(a.opens_on) filter (where a.chore_id = 'gang'), date '2000-01-01') - date '2000-01-01' lh
        from huis_people p left join huis_chore_assignments a on p.name = any(a.people) group by p.name),
      cand as (select * from st where not exists (select 1 from huis_chore_assignments b where b.chore_id in ('douche','washok') and b.start_date + 7 = w and st.name = any(b.people)))
      select t.name, h.name into v_a, v_b from cand t cross join cand h
      where t.name <> h.name
        and not exists (select 1 from huis_chore_assignments x where x.chore_id = 'toilet' and x.start_date = w - 7 and t.name = any(x.people))
        and not exists (select 1 from huis_chore_assignments x where x.chore_id = 'gang' and x.start_date = w - 7 and h.name = any(x.people))
      order by t.tot + h.tot, greatest(t.tot, h.tot), t.t + h.h, t.lt + h.lh, t.name, h.name limit 1;
      if not found then raise exception 'huis_generate: no weekly assignment for %', w; end if;
      insert into huis_chore_assignments (chore_id, start_date, end_date, people) values
        ('toilet', w, w + 6, array[v_a]), ('gang', w, w + 6, array[v_b]);
      v_n := v_n + 2;
    end if;
  end loop;
  return v_n;
end $function$;

-- ---------------------------------------------------------------- triggers

drop trigger if exists huis_assign_opens_on on public.huis_chore_assignments;
CREATE TRIGGER huis_assign_opens_on BEFORE INSERT OR UPDATE OF chore_id, start_date, end_date ON public.huis_chore_assignments FOR EACH ROW EXECUTE FUNCTION public.huis_assign_opens_on();

drop trigger if exists huis_chore_offset_changed on public.huis_chores;
CREATE TRIGGER huis_chore_offset_changed AFTER UPDATE OF open_offset_days ON public.huis_chores FOR EACH ROW EXECUTE FUNCTION public.huis_chore_offset_changed();


-- ---------------------------------------------------------------- views

create or replace view public.huis_shame with (security_invoker=true) as
SELECT person,
    missed,
    late,
    total
   FROM public.huis_shame_at(now()) huis_shame_at(person, missed, late, total);


-- ---------------------------------------------------------------- row level security
-- Everyone (anon) may READ; all writes go through the security-definer RPCs below.

alter table public.huis_people enable row level security;
alter table public.huis_chores enable row level security;
alter table public.huis_devices enable row level security;
alter table public.huis_chore_assignments enable row level security;

drop policy if exists huis_assign_read on public.huis_chore_assignments;
create policy huis_assign_read on public.huis_chore_assignments as permissive for select to anon, authenticated using (true);
drop policy if exists huis_chores_read on public.huis_chores;
create policy huis_chores_read on public.huis_chores as permissive for select to anon, authenticated using (true);
drop policy if exists huis_devices_read on public.huis_devices;
create policy huis_devices_read on public.huis_devices as permissive for select to anon, authenticated using (true);
drop policy if exists huis_people_read on public.huis_people;
create policy huis_people_read on public.huis_people as permissive for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- privileges
-- (Supabase grants table privileges to anon/authenticated by default; RLS above limits them to SELECT.)
grant select on public.huis_shame to anon, authenticated;
revoke all on function public.huis_assign_opens_on() from public, anon, authenticated;
revoke all on function public.huis_chore_offset_changed() from public, anon, authenticated;
revoke all on function public.huis_deadline(date) from public, anon, authenticated;
grant execute on function public.huis_deadline(date) to public, anon, authenticated;
revoke all on function public.huis_generate(date) from public, anon, authenticated;
revoke all on function public.huis_now() from public, anon, authenticated;
grant execute on function public.huis_now() to public, anon, authenticated;
revoke all on function public.huis_opens_on(text,date,date) from public, anon, authenticated;
grant execute on function public.huis_opens_on(text,date,date) to public, anon, authenticated;
revoke all on function public.huis_set(text,text,text,integer) from public, anon, authenticated;
grant execute on function public.huis_set(text,text,text,integer) to anon, authenticated;
revoke all on function public.huis_shame_at(timestamp with time zone) from public, anon, authenticated;
grant execute on function public.huis_shame_at(timestamp with time zone) to public, anon, authenticated;
revoke all on function public.huis_tick() from public, anon, authenticated;
revoke all on function public.huis_toggle_chore(bigint,text,boolean) from public, anon, authenticated;
grant execute on function public.huis_toggle_chore(bigint,text,boolean) to anon, authenticated;

-- ---------------------------------------------------------------- realtime

do $$ begin alter publication supabase_realtime add table public.huis_devices; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.huis_chore_assignments; exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- pg_cron: timers + schedule generator, every minute

select cron.schedule('huis_tick', '* * * * *', $$select public.huis_tick(); select public.huis_generate();$$);
