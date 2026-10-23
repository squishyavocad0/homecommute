-- Fixes from the chaos test (23 Oct 2026). Schema/functions only — no row data is changed.
--  * explicit, idempotent, order-safe chore ticking (huis_set_chore replaces huis_toggle_chore)
--  * a grace week: last week's chores can still be ticked (counts as late) until the next Sunday 23:59
--  * machines: "Already done"/"Adjust time" keep the original owner; "start" on a running machine is refused
--  * the generator keeps 8 weeks scheduled, so 7 are always visible right after Monday 00:00

alter table public.huis_chore_assignments add column if not exists tick_seq bigint;

CREATE OR REPLACE FUNCTION public.huis_grace_end(p_end date)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
AS $function$ select ((p_end + 8)::timestamp at time zone 'Europe/Amsterdam') $function$;

CREATE OR REPLACE FUNCTION public.huis_set(p_device text, p_action text, p_by text, p_minutes integer DEFAULT NULL::integer)
 RETURNS SETOF huis_devices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.huis_devices; v_action text := p_action;
begin
  perform public.huis_tick();
  select * into d from public.huis_devices where id = p_device for update;
  if not found then raise exception 'unknown device'; end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 600) then raise exception 'invalid duration'; end if;
  if d.kind = 'machine' then
    if p_by is null or not exists (select 1 from public.huis_people where name = p_by) then raise exception 'unknown housemate'; end if;
    -- older app versions adjusted their own timer with 'start'
    if v_action = 'start' and d.state = 'red' and d.set_by = p_by then v_action := 'adjust'; end if;
    if v_action = 'start' then
      if d.state = 'red' then
        raise exception 'The % is already running (% load, done at %) — no need to start it again 🙂', lower(d.label),
          coalesce(d.set_by || '’s', 'someone’s'), to_char(d.ends_at at time zone 'Europe/Amsterdam', 'HH24:MI');
      end if;
      update public.huis_devices set state='red', set_by=p_by, started_at=now(), ends_at=now()+make_interval(mins=>coalesce(p_minutes,60)), updated_at=now()
        where id=p_device;
    elsif v_action = 'adjust' then
      -- only the remaining time changes; the owner (set_by) and start time stay
      if d.state <> 'red' then raise exception 'The % isn’t running anymore — nothing to adjust 🙂', lower(d.label); end if;
      update public.huis_devices set ends_at=now()+make_interval(mins=>coalesce(p_minutes,10)), updated_at=now() where id=p_device;
    elsif v_action = 'done' then
      -- the load still belongs to whoever started it
      if d.state <> 'red' then raise exception 'The % isn’t running anymore 🙂', lower(d.label); end if;
      update public.huis_devices set state='orange', ends_at=null, updated_at=now() where id=p_device;
    elsif v_action in ('empty','reset') then
      update public.huis_devices set state='green', set_by=p_by, started_at=null, ends_at=null, updated_at=now() where id=p_device;
    else raise exception 'invalid action'; end if;
  else
    -- Toilet & Shower are anonymous: the name is never stored (p_by is ignored)
    if v_action = 'occupy' then
      update public.huis_devices set state='red', set_by=null, started_at=now(), ends_at=null, updated_at=now() where id=p_device;
    elsif v_action = 'wait' then
      update public.huis_devices set state='orange', set_by=null, ends_at=now()+make_interval(mins=>coalesce(p_minutes,10)), updated_at=now() where id=p_device;
    elsif v_action in ('free','reset') then
      update public.huis_devices set state='green', set_by=null, started_at=null, ends_at=null, updated_at=now() where id=p_device;
    else raise exception 'invalid action'; end if;
  end if;
  return query select * from public.huis_devices where id=p_device;
end $function$;

CREATE OR REPLACE FUNCTION public.huis_set_chore(p_id bigint, p_by text, p_done jsonb, p_seq bigint DEFAULT NULL::bigint)
 RETURNS SETOF huis_chore_assignments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.huis_chore_assignments; v_done boolean; v_today date := (now() at time zone 'Europe/Amsterdam')::date;
begin
  if p_done is null or jsonb_typeof(p_done) <> 'boolean' then raise exception 'p_done must be true or false'; end if;
  v_done := (p_done #>> '{}')::boolean;
  if p_by is null or not exists (select 1 from public.huis_people where name = p_by) then raise exception 'unknown housemate'; end if;
  select * into a from public.huis_chore_assignments where id = p_id for update;
  if not found then raise exception 'unknown chore'; end if;
  -- an older tap (lower sequence) never overwrites a newer one
  if p_seq is not null and a.tick_seq is not null and p_seq < a.tick_seq then return next a; return; end if;
  -- idempotent: already in the wanted state
  if (a.done_at is not null) = v_done then
    if p_seq is not null then update public.huis_chore_assignments set tick_seq = p_seq where id = p_id returning * into a; end if;
    return next a; return;
  end if;
  if v_done and v_today < a.opens_on then raise exception 'too early — this one opens %', to_char(a.opens_on, 'Dy FMDD Mon'); end if;
  if now() >= public.huis_grace_end(a.end_date) then raise exception 'too late — this one could be ticked until %', to_char(a.end_date + 7, 'Dy FMDD Mon'); end if;
  update public.huis_chore_assignments
    set done_by = case when v_done then p_by end, done_at = case when v_done then now() end, tick_seq = coalesce(p_seq, tick_seq)
    where id = p_id returning * into a;
  return next a;
end $function$;

-- missed = still not ticked when the grace week ends; late = ticked after the deadline, or overdue but still in its grace week
CREATE OR REPLACE FUNCTION public.huis_shame_at(p_now timestamp with time zone)
 RETURNS TABLE(person text, missed bigint, late bigint, total bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ev as (
    select p as person,
      case when a.done_at is null and p_now >= public.huis_grace_end(a.end_date) then 'missed'
           when a.done_at is null then 'late'
           when a.done_at >= public.huis_deadline(a.end_date) then 'late' end as kind
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
  for i in 0..7 loop  -- 8 weeks: 7 stay visible right after the Monday rollover
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

revoke all on function public.huis_grace_end(date) from public, anon, authenticated;
grant execute on function public.huis_grace_end(date) to public, anon, authenticated;
revoke all on function public.huis_set_chore(bigint,text,jsonb,bigint) from public, anon, authenticated;
grant execute on function public.huis_set_chore(bigint,text,jsonb,bigint) to anon, authenticated;
