-- Bite & Sip: offers, pre-orders, table help requests, feedback, push
-- notifications, a kitchen screen, daily cash closing and ingredient usage.
--
--   * Offers are percentage discounts on chosen items during a time window.
--     Prices are still computed only here, in place_order.
--   * A student may pre-order for later today (scheduled_for).
--   * Students at a table can call for help (water, spoon, bill…).
--   * Students rate an order once it is served or collected.
--   * Push notifications: the database tells the "push" Edge Function what
--     happened (via pg_net, after commit); the function encrypts and sends.
--     Nothing here can block or fail an order.
--   * The kitchen screen opens with a secret link: it sees what to cook
--     (no prices, no phone numbers) and can only move orders to
--     "preparing" and "ready".

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Configuration that must never reach the browser.
-- ---------------------------------------------------------------------------
create table private.app_config (
  id boolean primary key default true check (id),
  push_url text,
  push_secret text,
  vapid_public_key text,
  kitchen_key text,
  kitchen_topic text,
  kitchen_key_created_at timestamptz
);
insert into private.app_config (id) values (true) on conflict (id) do nothing;
revoke all on private.app_config from public, anon, authenticated;

-- "Kitchen screen" joins Customer / System as an actor in the audit log.
create or replace function private.actor_name()
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when coalesce(current_setting('bite.actor', true), '') = 'customer' then 'Customer'
    when coalesce(current_setting('bite.actor', true), '') = 'kitchen' then 'Kitchen screen'
    when (select auth.uid()) is null then 'System'
    else coalesce((select s.display_name from public.staff s where s.user_id = (select auth.uid())), 'Unknown user')
  end
$$;

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 40),
  percent_off integer not null check (percent_off between 1 and 90),
  -- Empty = the whole menu.
  menu_item_ids uuid[] not null default '{}' check (cardinality(menu_item_ids) <= 200),
  -- ISO weekdays (1 = Monday). Empty = every day.
  days smallint[] not null default '{}' check (days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  -- Café local time (Asia/Kolkata). 24:00 = end of day.
  starts_at time not null default '00:00',
  ends_at time not null default '24:00',
  valid_from date,
  valid_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_window check (ends_at > starts_at),
  constraint offers_dates check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create trigger offers_touch before update on public.offers
  for each row execute function private.touch_updated_at();
create trigger offers_audit after insert or update or delete on public.offers
  for each row execute function private.audit_row('offer', 'title', 'id');

-- The best offer for an item at a moment (highest discount wins).
create function private.best_offer(p_menu_item_id uuid, p_at timestamptz)
returns table (percent_off integer, title text)
language sql stable security definer set search_path = ''
as $$
  select o.percent_off, o.title
  from public.offers o, (select (p_at at time zone 'Asia/Kolkata') as t) l
  where o.is_active
    and (cardinality(o.menu_item_ids) = 0 or p_menu_item_id = any (o.menu_item_ids))
    and (cardinality(o.days) = 0 or extract(isodow from l.t)::smallint = any (o.days))
    and l.t::time >= o.starts_at and l.t::time < o.ends_at
    and (o.valid_from is null or l.t::date >= o.valid_from)
    and (o.valid_to is null or l.t::date <= o.valid_to)
  order by o.percent_off desc, o.title
  limit 1
$$;
revoke all on function private.best_offer(uuid, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Orders: pre-orders and discounts
-- ---------------------------------------------------------------------------
alter table public.orders add column scheduled_for timestamptz;
create index orders_scheduled_idx on public.orders (scheduled_for) where scheduled_for is not null;

-- discount is per unit, taken off the item's base price (add-ons are never discounted).
alter table public.order_items
  add column discount integer not null default 0 check (discount >= 0),
  add column offer_title text check (offer_title is null or char_length(offer_title) <= 40);

create table public.order_feedback (
  order_id uuid primary key references public.orders (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_feedback_created_idx on public.order_feedback (created_at desc);

create or replace function private.order_json(p_order public.orders)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_order.id,
    'order_no', p_order.order_no,
    'customer_name', p_order.customer_name,
    'phone_last4', right(p_order.customer_phone, 4),
    'table_label', p_order.table_label,
    'status', p_order.status,
    'payment_method', p_order.payment_method,
    'payment_status', p_order.payment_status,
    'customer_reported_paid_at', p_order.customer_reported_paid_at,
    'total', p_order.total,
    'item_count', p_order.item_count,
    'cancel_reason', p_order.cancel_reason,
    'cancelled_by', p_order.cancelled_by,
    'track_key', p_order.track_key,
    'scheduled_for', p_order.scheduled_for,
    'created_at', p_order.created_at,
    'updated_at', p_order.updated_at,
    'preparing_at', p_order.preparing_at,
    'ready_at', p_order.ready_at,
    'completed_at', p_order.completed_at,
    'cancelled_at', p_order.cancelled_at,
    'paid_at', p_order.paid_at,
    'feedback', (select jsonb_build_object('rating', f.rating, 'comment', f.comment)
                 from public.order_feedback f where f.order_id = p_order.id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'menu_item_id', i.menu_item_id, 'name', i.name, 'base_price', i.base_price, 'addons', i.addons,
               'discount', i.discount, 'offer_title', i.offer_title,
               'unit_price', i.unit_price, 'quantity', i.quantity,
               'line_total', i.line_total, 'note', i.note) order by i.name, i.id)
      from public.order_items i where i.order_id = p_order.id), '[]'::jsonb)
  )
$$;

-- New parameters have defaults, so older app versions keep working.
drop function public.place_order(uuid, text, text, text, public.payment_method, text, jsonb);

create function public.place_order(
  p_client_request_id uuid,
  p_access_token text,
  p_customer_name text,
  p_customer_phone text,
  p_payment_method public.payment_method,
  p_table_label text,
  p_items jsonb,
  p_scheduled_for timestamptz default null,
  p_expected_total integer default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_settings public.cafe_settings;
  v_name text := private.clean_text(p_customer_name);
  v_phone text := private.normalize_phone(p_customer_phone);
  v_table text := upper(private.clean_text(p_table_label));
  v_scheduled timestamptz := date_trunc('minute', p_scheduled_for);
  v_hash bytea;
  v_existing public.orders;
  v_order public.orders;
  v_line jsonb;
  v_item public.menu_items;
  v_addon_ids uuid[];
  v_addons jsonb;
  v_addon_total integer;
  v_addon_cost integer;
  v_addon_count integer;
  v_item_cost integer;
  v_offer record;
  v_discount integer;
  v_qty integer;
  v_note text;
  v_total integer := 0;
  v_count integer := 0;
  v_lines jsonb := '[]'::jsonb;
  v_short record;
begin
  if p_client_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if p_access_token is null or p_access_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  v_hash := extensions.digest(p_access_token, 'sha256');

  -- Idempotency: a retried submission returns the original order.
  select * into v_existing from public.orders where client_request_id = p_client_request_id;
  if found then
    if v_existing.access_hash <> v_hash then
      raise exception using errcode = '22023', message = 'invalid_request';
    end if;
    return private.order_json(v_existing);
  end if;

  select * into v_settings from public.cafe_settings where id;
  if not coalesce(v_settings.is_open, false) then
    raise exception using errcode = 'P0001', message = 'cafe_closed';
  end if;

  if v_name is null or char_length(v_name) > 40 then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;
  if v_phone is null then
    raise exception using errcode = '22023', message = 'invalid_phone';
  end if;
  if p_payment_method is null then
    raise exception using errcode = '22023', message = 'invalid_payment_method';
  end if;
  if p_payment_method = 'upi' and v_settings.upi_id is null then
    raise exception using errcode = 'P0001', message = 'upi_unavailable';
  end if;

  -- Pre-orders: later today, at least 15 minutes from now (1 minute of slack
  -- for clocks and slow networks).
  if v_scheduled is not null and (
       v_scheduled < now() + interval '14 minutes'
    or v_scheduled > now() + interval '12 hours'
    or (v_scheduled at time zone 'Asia/Kolkata')::date <> (now() at time zone 'Asia/Kolkata')::date
  ) then
    raise exception using errcode = '22023', message = 'invalid_pickup_time';
  end if;

  -- An unknown or inactive table is dropped rather than blocking the order.
  if v_table is not null and not exists (
    select 1 from public.cafe_tables t where t.label = v_table and t.is_active
  ) then
    v_table := null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 30 then
    raise exception using errcode = '22023', message = 'invalid_items';
  end if;

  if (select count(*) from public.orders o
      where o.customer_phone = v_phone and o.status in ('placed', 'preparing', 'ready')) >= 3 then
    raise exception using errcode = 'P0001', message = 'too_many_open_orders';
  end if;

  for v_line in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'menu_item_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
       or (v_line ? 'addon_ids' and jsonb_typeof(v_line -> 'addon_ids') <> 'array')
       or (v_line ? 'note' and jsonb_typeof(v_line -> 'note') not in ('string', 'null')) then
      raise exception using errcode = '22023', message = 'invalid_items';
    end if;

    begin
      v_qty := (v_line ->> 'quantity')::integer;
      if (v_line ->> 'quantity')::numeric <> v_qty then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      select coalesce(array_agg(x::uuid), '{}') into v_addon_ids
      from jsonb_array_elements_text(coalesce(v_line -> 'addon_ids', '[]'::jsonb)) x;
      select * into v_item from public.menu_items m where m.id = (v_line ->> 'menu_item_id')::uuid for share;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using errcode = '22023', message = 'invalid_items';
    end;

    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception using errcode = '22023', message = 'invalid_quantity';
    end if;
    if v_item.id is null then
      raise exception using errcode = 'P0001', message = 'item_not_found';
    end if;
    if not v_item.is_available then
      raise exception using errcode = 'P0001', message = 'item_unavailable', detail = v_item.name;
    end if;
    if cardinality(v_addon_ids) <> (select count(distinct a) from unnest(v_addon_ids) a) then
      raise exception using errcode = '22023', message = 'invalid_addons';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price', a.price)
                              order by a.sort_order, a.name), '[]'::jsonb),
           coalesce(sum(a.price), 0), coalesce(sum(ac.cost), 0), count(*)
      into v_addons, v_addon_total, v_addon_cost, v_addon_count
    from public.addons a
    left join public.addon_costs ac on ac.addon_id = a.id
    where a.id = any (v_addon_ids) and a.menu_item_id = v_item.id and a.is_available;

    if v_addon_count <> cardinality(v_addon_ids) then
      raise exception using errcode = 'P0001', message = 'addon_unavailable', detail = v_item.name;
    end if;

    v_note := private.clean_text(v_line ->> 'note');
    if v_note is not null and char_length(v_note) > 120 then
      raise exception using errcode = '22023', message = 'invalid_note';
    end if;

    select c.cost into v_item_cost from public.menu_item_costs c where c.menu_item_id = v_item.id;

    -- Offers apply to the item's base price, rounded down to whole rupees.
    select * into v_offer from private.best_offer(v_item.id, now());
    v_discount := coalesce((v_item.price * v_offer.percent_off) / 100, 0);

    v_total := v_total + (v_item.price - v_discount + v_addon_total) * v_qty;
    v_count := v_count + v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'menu_item_id', v_item.id, 'name', v_item.name, 'base_price', v_item.price,
      'addons', v_addons, 'unit_price', v_item.price - v_discount + v_addon_total,
      'discount', v_discount, 'offer_title', case when v_discount > 0 then v_offer.title end,
      'unit_cost', case when v_item_cost is null then null else v_item_cost + v_addon_cost end,
      'quantity', v_qty, 'note', v_note));
    v_item := null;
    v_item_cost := null;
  end loop;

  if v_count > 50 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;

  -- The student saw a different total (an offer started or ended, a price
  -- changed): stop and let them review rather than charge a surprise amount.
  if p_expected_total is not null and p_expected_total <> v_total then
    raise exception using errcode = 'P0001', message = 'prices_changed', hint = v_total::text;
  end if;

  -- Stock: lock tracked rows in a fixed order (no deadlocks between concurrent
  -- orders), then check the whole cart against what is on hand.
  perform 1 from public.stock_levels s
  where s.menu_item_id in (select (l ->> 'menu_item_id')::uuid from jsonb_array_elements(v_lines) l)
  order by s.menu_item_id
  for update;

  select s.on_hand, r.name into v_short
  from public.stock_levels s
  join (
    select (l ->> 'menu_item_id')::uuid as menu_item_id, max(l ->> 'name') as name, sum((l ->> 'quantity')::integer) as quantity
    from jsonb_array_elements(v_lines) l group by 1
  ) r on r.menu_item_id = s.menu_item_id
  where s.on_hand < r.quantity
  order by r.name
  limit 1;
  if found then
    if v_short.on_hand = 0 then
      raise exception using errcode = 'P0001', message = 'item_unavailable', detail = v_short.name;
    end if;
    raise exception using errcode = 'P0001', message = 'insufficient_stock', detail = v_short.name, hint = v_short.on_hand::text;
  end if;

  insert into public.orders (
    access_hash, track_key, client_request_id, customer_name, customer_phone,
    table_label, payment_method, total, item_count, scheduled_for
  ) values (
    v_hash, encode(extensions.gen_random_bytes(16), 'hex'), p_client_request_id, v_name, v_phone,
    v_table, p_payment_method, v_total, v_count, v_scheduled
  )
  on conflict (client_request_id) do nothing
  returning * into v_order;

  if v_order.id is null then
    -- A concurrent duplicate won the race.
    select * into v_order from public.orders where client_request_id = p_client_request_id;
    if v_order.access_hash <> v_hash then
      raise exception using errcode = '22023', message = 'invalid_request';
    end if;
    return private.order_json(v_order);
  end if;

  insert into public.order_items (id, order_id, menu_item_id, name, base_price, addons, discount, offer_title,
                                  unit_price, quantity, line_total, note)
  select (l ->> 'id')::uuid, v_order.id, (l ->> 'menu_item_id')::uuid, l ->> 'name', (l ->> 'base_price')::integer, l -> 'addons',
         (l ->> 'discount')::integer, l ->> 'offer_title',
         (l ->> 'unit_price')::integer, (l ->> 'quantity')::integer,
         (l ->> 'unit_price')::integer * (l ->> 'quantity')::integer, l ->> 'note'
  from jsonb_array_elements(v_lines) l;

  insert into public.order_item_costs (order_item_id, unit_cost)
  select (l ->> 'id')::uuid, (l ->> 'unit_cost')::integer
  from jsonb_array_elements(v_lines) l
  where jsonb_typeof(l -> 'unit_cost') = 'number';

  with r as (
    select (l ->> 'menu_item_id')::uuid as menu_item_id, max(l ->> 'name') as name, sum((l ->> 'quantity')::integer) as quantity
    from jsonb_array_elements(v_lines) l group by 1
  ),
  upd as (
    update public.stock_levels s set on_hand = s.on_hand - r.quantity, updated_at = now()
    from r where s.menu_item_id = r.menu_item_id
    returning s.menu_item_id, s.on_hand, r.quantity, r.name
  )
  insert into public.stock_movements (menu_item_id, item_name, kind, delta, on_hand_after, order_id, actor_name)
  select upd.menu_item_id, upd.name, 'sale', -upd.quantity, upd.on_hand, v_order.id, 'Customer'
  from upd;

  return private.order_json(v_order);
end
$$;

-- ---------------------------------------------------------------------------
-- Wait time shown before ordering. Typical time from order (or pre-order
-- start) to ready over the last two weeks, plus a little for each order
-- already waiting in the kitchen.
-- ---------------------------------------------------------------------------
create function public.kitchen_eta()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with recent as (
    select extract(epoch from (o.ready_at - greatest(o.created_at, coalesce(o.scheduled_for - interval '15 minutes', o.created_at)))) / 60 as mins
    from public.orders o
    where o.ready_at is not null and o.created_at > now() - interval '14 days'
    order by o.ready_at desc
    limit 60
  ),
  typical as (
    select least(greatest(coalesce(round(percentile_cont(0.5) within group (order by mins))::integer, 8), 3), 30) as minutes,
           count(*) as samples
    from recent where mins > 0 and mins < 120
  ),
  queue as (
    select count(*)::integer as orders
    from public.orders o
    where o.status in ('placed', 'preparing')
      and (o.scheduled_for is null or o.scheduled_for - interval '15 minutes' <= now())
  )
  select jsonb_build_object(
    'queue', queue.orders,
    'typical_minutes', typical.minutes,
    'minutes', least(greatest(typical.minutes + greatest(queue.orders - 1, 0) * 2, 5), 60),
    'samples', typical.samples)
  from typical, queue
$$;

-- ---------------------------------------------------------------------------
-- Feedback after the order is served or collected
-- ---------------------------------------------------------------------------
create function public.leave_feedback(p_order_id uuid, p_access_token text, p_rating integer, p_comment text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_order public.orders := private.order_for_customer(p_order_id, p_access_token);
  v_comment text := private.clean_text(p_comment);
begin
  if v_order.status <> 'completed' then
    raise exception using errcode = 'P0001', message = 'not_allowed';
  end if;
  if v_order.completed_at < now() - interval '3 days' then
    raise exception using errcode = 'P0001', message = 'feedback_closed';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception using errcode = '22023', message = 'invalid_rating';
  end if;
  if v_comment is not null and char_length(v_comment) > 300 then
    raise exception using errcode = '22023', message = 'invalid_note';
  end if;
  insert into public.order_feedback (order_id, rating, comment)
  values (v_order.id, p_rating, v_comment)
  on conflict (order_id) do update set rating = excluded.rating, comment = excluded.comment, updated_at = now();
  return private.order_json(v_order);
end
$$;

-- ---------------------------------------------------------------------------
-- Help at the table: water, spoon/plate, clean the table, bill, other
-- ---------------------------------------------------------------------------
create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  table_label text not null references public.cafe_tables (label) on update cascade on delete cascade,
  kind text not null check (kind in ('water', 'cutlery', 'clean', 'bill', 'help')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);
create index service_requests_open_idx on public.service_requests (created_at) where resolved_at is null;
create index service_requests_table_idx on public.service_requests (table_label, created_at desc);

create function private.service_request_json(r public.service_requests)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'table_label', r.table_label, 'kind', r.kind,
                            'created_at', r.created_at, 'resolved_at', r.resolved_at)
$$;
revoke all on function private.service_request_json(public.service_requests) from public;

-- A second tap for the same thing returns the open request instead of a new one.
create function public.request_service(p_table_label text, p_kind text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_table text := upper(private.clean_text(p_table_label));
  v_row public.service_requests;
begin
  if p_kind is null or p_kind not in ('water', 'cutlery', 'clean', 'bill', 'help') then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if not exists (select 1 from public.cafe_tables t where t.label = v_table and t.is_active) then
    raise exception using errcode = 'P0001', message = 'table_not_found';
  end if;
  if not coalesce((select s.is_open from public.cafe_settings s where s.id), false) then
    raise exception using errcode = 'P0001', message = 'cafe_closed';
  end if;

  -- Serialise requests per table so double taps can't create duplicates.
  perform pg_advisory_xact_lock(hashtext('service_request:' || v_table));

  select * into v_row from public.service_requests r
  where r.table_label = v_table and r.kind = p_kind and r.resolved_at is null
    and r.created_at > now() - interval '30 minutes'
  order by r.created_at desc limit 1;
  if found then
    return private.service_request_json(v_row);
  end if;

  if (select count(*) from public.service_requests r
      where r.table_label = v_table and r.created_at > now() - interval '10 minutes') >= 6 then
    raise exception using errcode = 'P0001', message = 'too_many_requests';
  end if;

  insert into public.service_requests (table_label, kind) values (v_table, p_kind) returning * into v_row;
  return private.service_request_json(v_row);
end
$$;

create function public.service_request_status(p_ids uuid[])
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.service_request_json(r) order by r.created_at), '[]'::jsonb)
  from public.service_requests r
  where r.id = any (p_ids[1:10])
$$;

create function public.resolve_service_request(p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.service_requests;
begin
  if not private.is_staff() then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  update public.service_requests set resolved_at = now(), resolved_by = (select auth.uid())
  where id = p_id and resolved_at is null
  returning * into v_row;
  if not found then
    select * into v_row from public.service_requests where id = p_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'not_found';
    end if;
  end if;
  return private.service_request_json(v_row);
end
$$;

-- ---------------------------------------------------------------------------
-- Push notifications
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null check (char_length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  lang text not null default 'en' check (lang in ('en', 'hi', 'te')),
  -- Staff device (new orders, help requests) or a student's order (ready).
  user_id uuid references auth.users (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_target check ((user_id is null) <> (order_id is null))
);
create unique index push_subscriptions_staff_key on public.push_subscriptions (endpoint) where user_id is not null;
create unique index push_subscriptions_order_key on public.push_subscriptions (order_id, endpoint) where order_id is not null;
create index push_subscriptions_order_idx on public.push_subscriptions (order_id) where order_id is not null;

-- Only the browsers' push services, so the sender can't be pointed anywhere else.
create function private.push_endpoint_ok(p text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)/[^[:space:]]+$'
$$;

create function private.push_parse(p jsonb)
returns table (endpoint text, p256dh text, auth text)
language plpgsql immutable set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'keys') <> 'object'
     or not private.push_endpoint_ok(p ->> 'endpoint')
     or coalesce(p #>> '{keys,p256dh}', '') !~ '^[A-Za-z0-9_-]{80,100}$'
     or coalesce(p #>> '{keys,auth}', '') !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception using errcode = '22023', message = 'invalid_subscription';
  end if;
  return query select p ->> 'endpoint', p #>> '{keys,p256dh}', p #>> '{keys,auth}';
end
$$;
revoke all on function private.push_parse(jsonb) from public;

create function public.push_public_key()
returns text
language sql stable security definer set search_path = ''
as $$
  select case when c.push_url is not null then c.vapid_public_key end from private.app_config c where c.id
$$;

create function public.subscribe_order_push(p_order_id uuid, p_access_token text, p_subscription jsonb, p_lang text default 'en')
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_order public.orders := private.order_for_customer(p_order_id, p_access_token);
  v_sub record;
begin
  select * into v_sub from private.push_parse(p_subscription);
  if v_order.status not in ('placed', 'preparing', 'ready') then
    return;
  end if;
  if (select count(*) from public.push_subscriptions s where s.order_id = v_order.id) >= 3
     and not exists (select 1 from public.push_subscriptions s where s.order_id = v_order.id and s.endpoint = v_sub.endpoint) then
    raise exception using errcode = 'P0001', message = 'too_many_requests';
  end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth, lang, order_id)
  values (v_sub.endpoint, v_sub.p256dh, v_sub.auth, case when p_lang in ('en', 'hi', 'te') then p_lang else 'en' end, v_order.id)
  on conflict (order_id, endpoint) where order_id is not null
  do update set p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang;
end
$$;

create function public.subscribe_staff_push(p_subscription jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_sub record;
begin
  if not private.is_staff() then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  select * into v_sub from private.push_parse(p_subscription);
  insert into public.push_subscriptions (endpoint, p256dh, auth, user_id)
  values (v_sub.endpoint, v_sub.p256dh, v_sub.auth, (select auth.uid()))
  on conflict (endpoint) where user_id is not null
  do update set p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id;
end
$$;

-- Knowing the endpoint proves it is your browser.
create function public.unsubscribe_push(p_endpoint text)
returns void
language sql volatile security definer set search_path = ''
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint
$$;

create function public.staff_push_enabled(p_endpoint text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_staff() and exists (
    select 1 from public.push_subscriptions s where s.endpoint = p_endpoint and s.user_id = (select auth.uid()))
$$;

-- Hands an event to the push function after commit. Never raises.
create function private.push_event(p_event jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_cfg private.app_config;
begin
  select * into v_cfg from private.app_config where id;
  if v_cfg.push_url is null or v_cfg.push_secret is null then
    return;
  end if;
  begin
    perform net.http_post(
      url := v_cfg.push_url,
      body := p_event,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_cfg.push_secret),
      timeout_milliseconds := 8000);
  exception when others then
    raise warning 'push event failed: %', sqlerrm;
  end;
end
$$;
revoke all on function private.push_event(jsonb) from public;

create function private.order_items_summary(p_order_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select string_agg(i.quantity || '× ' || i.name, ', ' order by i.name)
  from public.order_items i where i.order_id = p_order_id
$$;
revoke all on function private.order_items_summary(uuid) from public;

-- Order events. The items are read by the trigger on order_items (they are
-- inserted after the order), so new orders are announced from there.
create function private.orders_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and (new.status = 'ready' or (new.status = 'cancelled' and new.cancelled_by = 'staff'))
     and exists (select 1 from public.push_subscriptions s where s.order_id = new.id) then
    perform private.push_event(jsonb_build_object(
      'event', 'order_' || new.status, 'order_id', new.id, 'order_no', new.order_no,
      'table_label', new.table_label, 'track_key', new.track_key, 'cancel_reason', new.cancel_reason));
  end if;
  if new.customer_reported_paid_at is not null and old.customer_reported_paid_at is null
     and exists (select 1 from public.push_subscriptions s where s.user_id is not null) then
    perform private.push_event(jsonb_build_object(
      'event', 'upi_reported', 'order_no', new.order_no, 'total', new.total, 'table_label', new.table_label));
  end if;
  return null;
end
$$;
revoke all on function private.orders_push() from public;

create trigger orders_push after update on public.orders
  for each row execute function private.orders_push();

create function private.order_items_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not exists (select 1 from public.push_subscriptions s where s.user_id is not null) then
    return null;
  end if;
  for v_order in select o.* from public.orders o where o.id in (select distinct order_id from new_lines) loop
    perform private.push_event(jsonb_build_object(
      'event', 'order_placed', 'order_id', v_order.id, 'order_no', v_order.order_no, 'total', v_order.total,
      'payment_method', v_order.payment_method, 'table_label', v_order.table_label,
      'scheduled_for', v_order.scheduled_for, 'items', private.order_items_summary(v_order.id)));
  end loop;
  return null;
end
$$;
revoke all on function private.order_items_push() from public;

create trigger order_items_push after insert on public.order_items
  referencing new table as new_lines
  for each statement execute function private.order_items_push();

create function private.service_requests_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.push_subscriptions s where s.user_id is not null) then
    perform private.push_event(jsonb_build_object(
      'event', 'service_request', 'id', new.id, 'table_label', new.table_label, 'kind', new.kind));
  end if;
  return null;
end
$$;
revoke all on function private.service_requests_push() from public;

create trigger service_requests_push after insert on public.service_requests
  for each row execute function private.service_requests_push();

-- ---------------------------------------------------------------------------
-- Kitchen screen (secret link, no sign-in)
-- ---------------------------------------------------------------------------
create function private.kitchen_check(p_key text)
returns private.app_config
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_cfg private.app_config;
begin
  select * into v_cfg from private.app_config where id;
  if p_key is null or v_cfg.kitchen_key is null or p_key <> v_cfg.kitchen_key then
    raise exception using errcode = '42501', message = 'invalid_kitchen_link';
  end if;
  return v_cfg;
end
$$;
revoke all on function private.kitchen_check(text) from public;

create function public.kitchen_link()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  return (select jsonb_build_object('key', c.kitchen_key, 'created_at', c.kitchen_key_created_at)
          from private.app_config c where c.id);
end
$$;

-- Creates a new link (the old one stops working) or turns it off.
create function public.kitchen_link_reset(p_enabled boolean)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  update private.app_config set
    kitchen_key = case when p_enabled then encode(extensions.gen_random_bytes(18), 'hex') end,
    kitchen_topic = case when p_enabled then encode(extensions.gen_random_bytes(16), 'hex') end,
    kitchen_key_created_at = case when p_enabled then now() end
  where id;
  perform private.audit('settings', case when p_enabled then 'kitchen.link_created' else 'kitchen.link_disabled' end,
    null, 'Kitchen screen', '{}'::jsonb);
  return public.kitchen_link();
end
$$;

create function public.kitchen_board(p_key text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_cfg private.app_config := private.kitchen_check(p_key);
begin
  return jsonb_build_object(
    'topic', v_cfg.kitchen_topic,
    'cafe_name', (select s.cafe_name from public.cafe_settings s where s.id),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_no', o.order_no,
        'customer_name', split_part(o.customer_name, ' ', 1),
        'table_label', o.table_label, 'status', o.status, 'scheduled_for', o.scheduled_for,
        'created_at', o.created_at, 'preparing_at', o.preparing_at, 'ready_at', o.ready_at,
        'items', (select jsonb_agg(jsonb_build_object(
                    'name', i.name, 'quantity', i.quantity, 'note', i.note,
                    'addons', (select coalesce(jsonb_agg(a ->> 'name'), '[]'::jsonb) from jsonb_array_elements(i.addons) a))
                  order by i.name, i.id)
                  from public.order_items i where i.order_id = o.id))
        order by coalesce(o.scheduled_for - interval '15 minutes', o.created_at), o.order_no)
      from public.orders o
      where o.status in ('placed', 'preparing') or (o.status = 'ready' and o.ready_at > now() - interval '2 hours')
    ), '[]'::jsonb),
    'now', now());
end
$$;

create function public.kitchen_advance(p_key text, p_order_id uuid, p_to public.order_status)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_from public.order_status;
  v_rows integer;
begin
  perform private.kitchen_check(p_key);
  if p_to not in ('preparing', 'ready') then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  v_from := case p_to when 'preparing' then 'placed'::public.order_status else 'preparing'::public.order_status end;
  perform set_config('bite.actor', 'kitchen', true);
  update public.orders set status = p_to where id = p_order_id and status = v_from;
  get diagnostics v_rows = row_count;
  perform set_config('bite.actor', '', true);
  if v_rows = 0 then
    raise exception using errcode = 'P0001', message = 'conflict';
  end if;
end
$$;

-- Pings the kitchen screen (no data in the payload; it refetches with its key).
create function private.kitchen_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_topic text := (select c.kitchen_topic from private.app_config c where c.id);
begin
  if v_topic is not null and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    begin
      perform realtime.send(jsonb_build_object('at', now()), 'changed', 'kitchen:' || v_topic, false);
    exception when others then
      raise warning 'kitchen notify failed: %', sqlerrm;
    end;
  end if;
  return null;
end
$$;
revoke all on function private.kitchen_notify() from public;

create trigger orders_kitchen_notify after insert or update on public.orders
  for each row execute function private.kitchen_notify();

-- ---------------------------------------------------------------------------
-- Daily cash closing (owner)
--   cash received  = cash orders marked paid that day (paid_at, café time)
--   expected cash  = opening float + cash received − cash paid out
--   difference     = counted − expected (negative = short)
-- ---------------------------------------------------------------------------
create table public.day_closings (
  day date primary key,
  opening_float integer not null check (opening_float between 0 and 10000000),
  cash_received integer not null,
  cash_paid_out integer not null check (cash_paid_out between 0 and 10000000),
  expected_cash integer not null,
  counted_cash integer not null check (counted_cash between 0 and 10000000),
  difference integer not null,
  upi_received integer not null,
  note text check (note is null or char_length(note) <= 200),
  closed_by uuid references auth.users (id) on delete set null,
  closed_by_name text,
  closed_at timestamptz not null default now()
);

create function private.day_figures(p_day date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with b as (
    select p_day::timestamp at time zone 'Asia/Kolkata' as s, (p_day + 1)::timestamp at time zone 'Asia/Kolkata' as e
  )
  select jsonb_build_object(
    'cash_received', (select coalesce(sum(o.total), 0) from public.orders o, b
                      where o.payment_method = 'cash' and o.paid_at >= b.s and o.paid_at < b.e),
    'cash_orders', (select count(*) from public.orders o, b
                    where o.payment_method = 'cash' and o.paid_at >= b.s and o.paid_at < b.e),
    'upi_received', (select coalesce(sum(o.total), 0) from public.orders o, b
                     where o.payment_method = 'upi' and o.paid_at >= b.s and o.paid_at < b.e),
    'upi_orders', (select count(*) from public.orders o, b
                   where o.payment_method = 'upi' and o.paid_at >= b.s and o.paid_at < b.e),
    'cash_refunds_due', (select coalesce(sum(o.total), 0) from public.orders o, b
                         where o.payment_method = 'cash' and o.status = 'cancelled' and o.payment_status = 'paid'
                           and o.cancelled_at >= b.s and o.cancelled_at < b.e),
    'unpaid_orders', (select count(*) from public.orders o, b
                      where o.status <> 'cancelled' and o.payment_status = 'unpaid' and o.created_at >= b.s and o.created_at < b.e),
    'unpaid_total', (select coalesce(sum(o.total), 0) from public.orders o, b
                     where o.status <> 'cancelled' and o.payment_status = 'unpaid' and o.created_at >= b.s and o.created_at < b.e),
    'open_orders', (select count(*) from public.orders o, b
                    where o.status in ('placed', 'preparing', 'ready') and o.created_at >= b.s and o.created_at < b.e),
    'expenses', (select coalesce(sum(x.amount), 0) from public.expenses x where x.spent_on = p_day)
  )
$$;
revoke all on function private.day_figures(date) from public;

create function public.day_close_summary(p_day date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_day is null or p_day > (now() at time zone 'Asia/Kolkata')::date then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;
  return private.day_figures(p_day) || jsonb_build_object(
    'day', p_day,
    'closing', (select to_jsonb(c) from public.day_closings c where c.day = p_day),
    'last_float', (select c.opening_float from public.day_closings c where c.day < p_day order by c.day desc limit 1));
end
$$;

create function public.close_day(p_day date, p_opening_float integer, p_paid_out integer, p_counted integer, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_fig jsonb;
  v_old public.day_closings;
  v_row public.day_closings;
  v_note text := private.clean_text(p_note);
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_day is null or p_day > (now() at time zone 'Asia/Kolkata')::date
     or p_day < (now() at time zone 'Asia/Kolkata')::date - 62 then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;
  if p_opening_float is null or p_opening_float < 0 or p_opening_float > 10000000
     or p_paid_out is null or p_paid_out < 0 or p_paid_out > 10000000
     or p_counted is null or p_counted < 0 or p_counted > 10000000 then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception using errcode = '22023', message = 'invalid_note';
  end if;

  v_fig := private.day_figures(p_day);
  select * into v_old from public.day_closings where day = p_day for update;

  insert into public.day_closings as c (day, opening_float, cash_received, cash_paid_out, expected_cash, counted_cash,
                                        difference, upi_received, note, closed_by, closed_by_name, closed_at)
  values (p_day, p_opening_float, (v_fig ->> 'cash_received')::integer, p_paid_out,
          p_opening_float + (v_fig ->> 'cash_received')::integer - p_paid_out, p_counted,
          p_counted - (p_opening_float + (v_fig ->> 'cash_received')::integer - p_paid_out),
          (v_fig ->> 'upi_received')::integer, v_note, (select auth.uid()), private.actor_name(), now())
  on conflict (day) do update set
    opening_float = excluded.opening_float, cash_received = excluded.cash_received, cash_paid_out = excluded.cash_paid_out,
    expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash, difference = excluded.difference,
    upi_received = excluded.upi_received, note = excluded.note, closed_by = excluded.closed_by,
    closed_by_name = excluded.closed_by_name, closed_at = excluded.closed_at
  returning * into v_row;

  perform private.audit('day', case when v_old.day is null then 'day.closed' else 'day.reclosed' end, p_day::text,
    to_char(p_day, 'DD Mon YYYY'),
    private.jsonb_changes(
      case when v_old.day is null then '{}'::jsonb
           else jsonb_build_object('counted_cash', v_old.counted_cash, 'difference', v_old.difference) end,
      jsonb_build_object('counted_cash', v_row.counted_cash, 'difference', v_row.difference)));

  return to_jsonb(v_row);
end
$$;

-- ---------------------------------------------------------------------------
-- Ingredient usage (owner): what recipes say was used, what was logged, and
-- what counts revealed. Powers the shopping list and the usage check.
-- ---------------------------------------------------------------------------
create function public.ingredient_usage(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_start timestamptz := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(u) - 'name' order by u.name)
    from (
      select i.id as ingredient_id, i.name,
             coalesce(-sum(m.delta) filter (where m.kind in ('sale', 'cancel_return')), 0) as sold,
             coalesce(-sum(m.delta) filter (where m.kind = 'usage'), 0) as used,
             coalesce(-sum(m.delta) filter (where m.kind = 'waste'), 0) as wasted,
             coalesce(sum(m.delta) filter (where m.kind = 'purchase'), 0) as purchased,
             coalesce(sum(m.amount) filter (where m.kind = 'purchase'), 0) as spent,
             coalesce(sum(m.delta) filter (where m.kind = 'count'), 0) as count_difference,
             count(*) filter (where m.kind = 'count') as counts,
             coalesce(sum(m.delta) filter (where m.kind = 'correction'), 0) as corrected,
             (select min(x.created_at) from public.ingredient_movements x where x.ingredient_id = i.id) as first_movement_at
      from public.ingredients i
      left join public.ingredient_movements m
        on m.ingredient_id = i.id and m.created_at >= v_start and m.created_at < v_end
      where i.is_active
      group by i.id, i.name
    ) u
  ), '[]'::jsonb);
end
$$;

-- How each offer did (owner).
create function public.offer_stats(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;
  return coalesce((
    select jsonb_agg(s order by s.discount desc)
    from (
      select i.offer_title as title, count(distinct o.id)::integer as orders, sum(i.quantity)::integer as units,
             sum(i.discount * i.quantity)::integer as discount, sum(i.line_total)::integer as sales
      from public.order_items i join public.orders o on o.id = i.order_id
      where i.offer_title is not null and o.status <> 'cancelled'
        and o.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
        and o.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
      group by i.offer_title
    ) s
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.offers enable row level security;
alter table public.order_feedback enable row level security;
alter table public.service_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.day_closings enable row level security;

create policy "offers: public read" on public.offers
  for select to anon, authenticated using (true);
create policy "offers: owner inserts" on public.offers
  for insert to authenticated with check ((select private.is_owner()));
create policy "offers: owner updates" on public.offers
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "offers: owner deletes" on public.offers
  for delete to authenticated using ((select private.is_owner()));

create policy "feedback: owner reads" on public.order_feedback
  for select to authenticated using ((select private.is_owner()));

create policy "help requests: staff read" on public.service_requests
  for select to authenticated using ((select private.is_staff()));

create policy "day closings: owner reads" on public.day_closings
  for select to authenticated using ((select private.is_owner()));

-- push_subscriptions: no policies — only the functions above and the push
-- function (service role) touch it.

revoke all on public.offers, public.order_feedback, public.service_requests, public.push_subscriptions, public.day_closings
  from anon, authenticated;
grant select on public.offers to anon, authenticated;
grant insert (title, percent_off, menu_item_ids, days, starts_at, ends_at, valid_from, valid_to, is_active),
      update (title, percent_off, menu_item_ids, days, starts_at, ends_at, valid_from, valid_to, is_active),
      delete on public.offers to authenticated;
grant select on public.order_feedback, public.service_requests, public.day_closings to authenticated;

revoke all on function public.kitchen_eta() from public, anon, authenticated;
revoke all on function public.leave_feedback(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.request_service(text, text) from public, anon, authenticated;
revoke all on function public.service_request_status(uuid[]) from public, anon, authenticated;
revoke all on function public.resolve_service_request(uuid) from public, anon, authenticated;
revoke all on function public.push_public_key() from public, anon, authenticated;
revoke all on function public.subscribe_order_push(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.subscribe_staff_push(jsonb) from public, anon, authenticated;
revoke all on function public.unsubscribe_push(text) from public, anon, authenticated;
revoke all on function public.staff_push_enabled(text) from public, anon, authenticated;
revoke all on function public.kitchen_link() from public, anon, authenticated;
revoke all on function public.kitchen_link_reset(boolean) from public, anon, authenticated;
revoke all on function public.kitchen_board(text) from public, anon, authenticated;
revoke all on function public.kitchen_advance(text, uuid, public.order_status) from public, anon, authenticated;
revoke all on function public.day_close_summary(date) from public, anon, authenticated;
revoke all on function public.close_day(date, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.ingredient_usage(date, date) from public, anon, authenticated;
revoke all on function public.offer_stats(date, date) from public, anon, authenticated;
revoke all on function public.place_order(uuid, text, text, text, public.payment_method, text, jsonb, timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.place_order(uuid, text, text, text, public.payment_method, text, jsonb, timestamptz, integer)
  to anon, authenticated;
grant execute on function public.kitchen_eta() to anon, authenticated;
grant execute on function public.leave_feedback(uuid, text, integer, text) to anon, authenticated;
grant execute on function public.request_service(text, text) to anon, authenticated;
grant execute on function public.service_request_status(uuid[]) to anon, authenticated;
grant execute on function public.resolve_service_request(uuid) to authenticated;
grant execute on function public.push_public_key() to anon, authenticated;
grant execute on function public.subscribe_order_push(uuid, text, jsonb, text) to anon, authenticated;
grant execute on function public.subscribe_staff_push(jsonb) to authenticated;
grant execute on function public.unsubscribe_push(text) to anon, authenticated;
grant execute on function public.staff_push_enabled(text) to authenticated;
grant execute on function public.kitchen_link() to authenticated;
grant execute on function public.kitchen_link_reset(boolean) to authenticated;
grant execute on function public.kitchen_board(text) to anon, authenticated;
grant execute on function public.kitchen_advance(text, uuid, public.order_status) to anon, authenticated;
grant execute on function public.day_close_summary(date) to authenticated;
grant execute on function public.close_day(date, integer, integer, integer, text) to authenticated;
grant execute on function public.ingredient_usage(date, date) to authenticated;
grant execute on function public.offer_stats(date, date) to authenticated;

-- The push function reads subscriptions with the service role.
grant select, delete on public.push_subscriptions to service_role;

-- Staff see help requests live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.service_requests;
  end if;
end
$$;
