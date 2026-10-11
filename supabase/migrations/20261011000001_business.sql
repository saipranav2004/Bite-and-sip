-- Bite & Sip: item costs, inventory, expenses, profit & loss and an audit log.
--
-- Security model (in addition to the core schema):
--   * Costs, expenses, stock history, profit & loss and the audit log are
--     owner-only. They live in their own tables so the public menu grants can
--     never expose them.
--   * Stock counts are public (the menu shows "sold out" / "only 3 left"), but
--     only change through functions that record every movement.
--   * The audit log is written only by triggers and SECURITY DEFINER functions
--     and is append-only: nobody can edit or delete an entry.

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null,
  action text not null,
  entity text not null,
  entity_id text,
  label text,
  changes jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object')
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_entity_idx on public.audit_log (entity, at desc);
create index audit_log_actor_idx on public.audit_log (actor, at desc);

create function private.audit_log_append_only()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'audit_log_is_append_only';
end
$$;

create trigger audit_log_no_change before update or delete on public.audit_log
  for each row execute function private.audit_log_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.audit_log_append_only();

-- Who is acting: a signed-in staff member, a student (through the customer
-- functions), or the system (SQL editor, scripts, service role).
create function private.actor_name()
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when coalesce(current_setting('bite.actor', true), '') = 'customer' then 'Customer'
    when (select auth.uid()) is null then 'System'
    else coalesce((select s.display_name from public.staff s where s.user_id = (select auth.uid())), 'Unknown user')
  end
$$;

create function private.audit(p_entity text, p_action text, p_entity_id text, p_label text, p_changes jsonb)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.audit_log (actor, actor_name, action, entity, entity_id, label, changes)
  values (
    case when coalesce(current_setting('bite.actor', true), '') = 'customer' then null else (select auth.uid()) end,
    private.actor_name(), p_action, p_entity, p_entity_id, p_label, coalesce(p_changes, '{}'::jsonb)
  )
$$;

-- {"field": [before, after]} for every field whose value differs.
create function private.jsonb_changes(p_old jsonb, p_new jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_array(p_old -> k, p_new -> k)), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) as k) keys
  where (p_old -> k) is distinct from (p_new -> k)
$$;

revoke all on function private.actor_name() from public;
revoke all on function private.audit(text, text, text, text, jsonb) from public;
revoke all on function private.jsonb_changes(jsonb, jsonb) from public;

-- Generic row audit. Arguments: entity name, label (a column name, or a fixed
-- label when no such column exists), id column.
create function private.audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_ignore text[] := array['updated_at', 'created_at', 'sort_order', 'created_by'];
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb;
  v_label text := coalesce(v_row ->> tg_argv[1], tg_argv[1]);
begin
  -- Add-ons removed together with their menu item are covered by the item's entry.
  if tg_table_name = 'addons' then
    if tg_op = 'DELETE' and not exists (select 1 from public.menu_items m where m.id = old.menu_item_id) then
      return null;
    end if;
    v_label := coalesce((select m.name from public.menu_items m where m.id = (v_row ->> 'menu_item_id')::uuid), '?')
               || ' › ' || (v_row ->> 'name');
  end if;

  v_changes := private.jsonb_changes(v_old - v_ignore, v_new - v_ignore);
  if v_changes = '{}'::jsonb then
    return null;
  end if;

  perform private.audit(
    tg_argv[0],
    tg_argv[0] || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    v_row ->> tg_argv[2],
    v_label,
    v_changes
  );
  return null;
end
$$;
revoke all on function private.audit_row() from public;

create trigger menu_items_audit after insert or update or delete on public.menu_items
  for each row execute function private.audit_row('menu_item', 'name', 'id');
create trigger addons_audit after insert or update or delete on public.addons
  for each row execute function private.audit_row('addon', 'name', 'id');
create trigger categories_audit after insert or update or delete on public.categories
  for each row execute function private.audit_row('category', 'name', 'id');
create trigger cafe_settings_audit after update on public.cafe_settings
  for each row execute function private.audit_row('settings', 'Café settings', 'id');
create trigger cafe_tables_audit after insert or update or delete on public.cafe_tables
  for each row execute function private.audit_row('table', 'label', 'label');
create trigger staff_audit after insert or update or delete on public.staff
  for each row execute function private.audit_row('staff', 'display_name', 'user_id');

-- Orders: payment decisions and cancellations (routine kitchen progress is
-- already timestamped on the order itself).
create function private.audit_order()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_label text := format('Order BS-%s · ₹%s %s', new.order_no, new.total, upper(new.payment_method::text));
begin
  if new.payment_status is distinct from old.payment_status then
    perform private.audit('order',
      case when new.payment_status = 'paid' then 'order.marked_paid' else 'order.marked_unpaid' end,
      new.id::text, v_label,
      private.jsonb_changes(
        jsonb_build_object('payment_status', old.payment_status, 'payment_reference', old.payment_reference),
        jsonb_build_object('payment_status', new.payment_status, 'payment_reference', new.payment_reference)));
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform private.audit('order', 'order.cancelled', new.id::text, v_label,
      jsonb_build_object('status', jsonb_build_array(old.status, new.status),
                         'cancel_reason', jsonb_build_array(null, new.cancel_reason)));
  end if;
  return null;
end
$$;
revoke all on function private.audit_order() from public;

create trigger orders_audit after update on public.orders
  for each row execute function private.audit_order();

-- ---------------------------------------------------------------------------
-- Costs (owner-only)
-- ---------------------------------------------------------------------------
create table public.menu_item_costs (
  menu_item_id uuid primary key references public.menu_items (id) on delete cascade,
  cost integer not null check (cost between 0 and 5000),
  updated_at timestamptz not null default now()
);

create table public.addon_costs (
  addon_id uuid primary key references public.addons (id) on delete cascade,
  cost integer not null check (cost between 0 and 1000),
  updated_at timestamptz not null default now()
);

-- Cost of each sold line at the moment of sale, so later cost changes never
-- rewrite past profit. No row = the item had no cost set.
create table public.order_item_costs (
  order_item_id uuid primary key references public.order_items (id) on delete cascade,
  unit_cost integer not null check (unit_cost >= 0)
);

create trigger menu_item_costs_touch before update on public.menu_item_costs
  for each row execute function private.touch_updated_at();
create trigger addon_costs_touch before update on public.addon_costs
  for each row execute function private.touch_updated_at();

create function private.audit_cost()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_label text;
  v_id text;
begin
  if tg_table_name = 'menu_item_costs' then
    v_id := v_row ->> 'menu_item_id';
    select m.name into v_label from public.menu_items m where m.id = v_id::uuid;
  else
    v_id := v_row ->> 'addon_id';
    select m.name || ' › ' || a.name into v_label
    from public.addons a join public.menu_items m on m.id = a.menu_item_id where a.id = v_id::uuid;
  end if;
  -- Removed together with the item or add-on: nothing separate to record.
  if v_label is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.cost = old.cost then
    return null;
  end if;
  perform private.audit('cost', 'cost.' || case tg_op when 'INSERT' then 'set' when 'UPDATE' then 'changed' else 'removed' end,
    v_id, v_label,
    jsonb_build_object('cost', jsonb_build_array(
      case when tg_op <> 'INSERT' then old.cost end,
      case when tg_op <> 'DELETE' then new.cost end)));
  return null;
end
$$;
revoke all on function private.audit_cost() from public;

create trigger menu_item_costs_audit after insert or update or delete on public.menu_item_costs
  for each row execute function private.audit_cost();
create trigger addon_costs_audit after insert or update or delete on public.addon_costs
  for each row execute function private.audit_cost();

-- ---------------------------------------------------------------------------
-- Inventory
-- A menu item is stock-tracked when it has a row in stock_levels. Tracked
-- items are sold out automatically at zero.
-- ---------------------------------------------------------------------------
create table public.stock_levels (
  menu_item_id uuid primary key references public.menu_items (id) on delete cascade,
  on_hand integer not null default 0 check (on_hand between 0 and 100000),
  low_at integer not null default 5 check (low_at between 0 and 10000),
  updated_at timestamptz not null default now()
);

create type public.stock_movement_kind as enum ('initial', 'sale', 'cancel_return', 'restock', 'waste', 'count', 'correction');

create table public.stock_movements (
  id bigint generated always as identity primary key,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  kind public.stock_movement_kind not null,
  delta integer not null,
  on_hand_after integer not null,
  unit_cost integer check (unit_cost is null or unit_cost >= 0),
  order_id uuid references public.orders (id) on delete set null,
  note text check (note is null or char_length(note) <= 140),
  actor uuid references auth.users (id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now()
);
create index stock_movements_item_idx on public.stock_movements (menu_item_id, created_at desc);
create index stock_movements_created_idx on public.stock_movements (created_at desc);
create index stock_movements_order_idx on public.stock_movements (order_id) where order_id is not null;

-- Owner: start/stop tracking an item and set its low-stock level.
create function public.stock_configure(p_menu_item_id uuid, p_track boolean, p_low_at integer, p_on_hand integer)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_item public.menu_items;
  v_level public.stock_levels;
  v_old_low integer;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'item_not_found';
  end if;
  if p_low_at is not null and (p_low_at < 0 or p_low_at > 10000) then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;
  if p_on_hand is not null and (p_on_hand < 0 or p_on_hand > 100000) then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;

  select * into v_level from public.stock_levels where menu_item_id = p_menu_item_id for update;

  if not coalesce(p_track, false) then
    if found then
      delete from public.stock_levels where menu_item_id = p_menu_item_id;
      perform private.audit('stock', 'stock.tracking_off', p_menu_item_id::text, v_item.name,
        jsonb_build_object('on_hand', jsonb_build_array(v_level.on_hand, null)));
    end if;
    return jsonb_build_object('menu_item_id', p_menu_item_id, 'tracked', false);
  end if;

  if not found then
    insert into public.stock_levels (menu_item_id, on_hand, low_at)
    values (p_menu_item_id, coalesce(p_on_hand, 0), coalesce(p_low_at, 5))
    returning * into v_level;
    insert into public.stock_movements (menu_item_id, item_name, kind, delta, on_hand_after, actor, actor_name)
    values (p_menu_item_id, v_item.name, 'initial', v_level.on_hand, v_level.on_hand, (select auth.uid()), private.actor_name());
    perform private.audit('stock', 'stock.tracking_on', p_menu_item_id::text, v_item.name,
      jsonb_build_object('on_hand', jsonb_build_array(null, v_level.on_hand), 'low_at', jsonb_build_array(null, v_level.low_at)));
  elsif p_low_at is not null and p_low_at <> v_level.low_at then
    v_old_low := v_level.low_at;
    update public.stock_levels set low_at = p_low_at, updated_at = now()
    where menu_item_id = p_menu_item_id returning * into v_level;
    perform private.audit('stock', 'stock.low_level_changed', p_menu_item_id::text, v_item.name,
      jsonb_build_object('low_at', jsonb_build_array(v_old_low, v_level.low_at)));
  end if;

  return jsonb_build_object('menu_item_id', p_menu_item_id, 'tracked', true,
    'on_hand', v_level.on_hand, 'low_at', v_level.low_at, 'updated_at', v_level.updated_at);
end
$$;

-- Any staff member: received stock, waste, a recount, or a correction.
create function public.stock_adjust(p_menu_item_id uuid, p_kind text, p_quantity integer, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_level public.stock_levels;
  v_name text;
  v_note text := private.clean_text(p_note);
  v_delta integer;
  v_cost integer;
  v_before integer;
begin
  if not private.is_staff() then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if p_kind is null or p_kind not in ('restock', 'waste', 'count', 'correction') then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if p_quantity is null then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;
  if v_note is not null and char_length(v_note) > 140 then
    raise exception using errcode = '22023', message = 'invalid_note';
  end if;

  select * into v_level from public.stock_levels where menu_item_id = p_menu_item_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'stock_not_tracked';
  end if;
  select m.name into v_name from public.menu_items m where m.id = p_menu_item_id;
  v_before := v_level.on_hand;

  case p_kind
    when 'restock' then
      if p_quantity < 1 or p_quantity > 10000 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      v_delta := p_quantity;
    when 'waste' then
      if p_quantity < 1 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      if p_quantity > v_level.on_hand then
        raise exception using errcode = 'P0001', message = 'insufficient_stock', detail = v_name, hint = v_level.on_hand::text;
      end if;
      v_delta := -p_quantity;
      select c.cost into v_cost from public.menu_item_costs c where c.menu_item_id = p_menu_item_id;
    when 'count' then
      if p_quantity < 0 or p_quantity > 100000 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      v_delta := p_quantity - v_level.on_hand;
    when 'correction' then
      if p_quantity = 0 or abs(p_quantity) > 10000 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      if v_note is null then
        raise exception using errcode = '22023', message = 'note_required';
      end if;
      if v_level.on_hand + p_quantity < 0 then
        raise exception using errcode = 'P0001', message = 'insufficient_stock', detail = v_name, hint = v_level.on_hand::text;
      end if;
      v_delta := p_quantity;
  end case;

  if v_level.on_hand + v_delta > 100000 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;

  update public.stock_levels set on_hand = on_hand + v_delta, updated_at = now()
  where menu_item_id = p_menu_item_id returning * into v_level;

  insert into public.stock_movements (menu_item_id, item_name, kind, delta, on_hand_after, unit_cost, note, actor, actor_name)
  values (p_menu_item_id, v_name, p_kind::public.stock_movement_kind, v_delta, v_level.on_hand, v_cost, v_note,
          (select auth.uid()), private.actor_name());

  perform private.audit('stock', 'stock.' || p_kind, p_menu_item_id::text, v_name,
    jsonb_build_object('on_hand', jsonb_build_array(v_before, v_level.on_hand))
      || case when v_note is not null then jsonb_build_object('note', jsonb_build_array(null, v_note)) else '{}'::jsonb end);

  return jsonb_build_object('menu_item_id', p_menu_item_id, 'tracked', true,
    'on_hand', v_level.on_hand, 'low_at', v_level.low_at, 'updated_at', v_level.updated_at);
end
$$;

-- A cancelled order puts its tracked items back on the shelf. Food that was
-- thrown away is recorded separately as waste.
create function private.orders_restock_on_cancel()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    with sold as (
      select m.menu_item_id, max(m.item_name) as item_name, -sum(m.delta)::integer as quantity
      from public.stock_movements m
      where m.order_id = new.id and m.kind in ('sale', 'cancel_return') and m.menu_item_id is not null
      group by m.menu_item_id
      having -sum(m.delta) > 0
    ),
    upd as (
      update public.stock_levels s set on_hand = s.on_hand + sold.quantity, updated_at = now()
      from sold where s.menu_item_id = sold.menu_item_id
      returning s.menu_item_id, s.on_hand, sold.quantity, sold.item_name
    )
    insert into public.stock_movements (menu_item_id, item_name, kind, delta, on_hand_after, order_id, actor, actor_name)
    select upd.menu_item_id, upd.item_name, 'cancel_return', upd.quantity, upd.on_hand, new.id,
           case when coalesce(current_setting('bite.actor', true), '') = 'customer' then null else (select auth.uid()) end,
           private.actor_name()
    from upd;
  end if;
  return null;
end
$$;
revoke all on function private.orders_restock_on_cancel() from public;

create trigger orders_restock_on_cancel after update on public.orders
  for each row execute function private.orders_restock_on_cancel();

-- ---------------------------------------------------------------------------
-- Expenses (owner-only)
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  spent_on date not null,
  category text not null check (category in (
    'ingredients', 'salaries', 'rent', 'utilities', 'gas', 'packaging', 'maintenance', 'marketing', 'other')),
  amount integer not null check (amount between 1 and 10000000),
  note text check (note is null or char_length(note) <= 140),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index expenses_spent_on_idx on public.expenses (spent_on desc);

create function private.expenses_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.note := private.clean_text(new.note);
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger expenses_prepare before insert or update on public.expenses
  for each row execute function private.expenses_prepare();
create trigger expenses_audit after insert or update or delete on public.expenses
  for each row execute function private.audit_row('expense', 'category', 'id');

-- ---------------------------------------------------------------------------
-- Ordering: price from the menu, snapshot costs, enforce and deduct stock.
-- (Replaces the core version; the signature and grants are unchanged.)
-- ---------------------------------------------------------------------------
create or replace function public.place_order(
  p_client_request_id uuid,
  p_access_token text,
  p_customer_name text,
  p_customer_phone text,
  p_payment_method public.payment_method,
  p_table_label text,
  p_items jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_settings public.cafe_settings;
  v_name text := private.clean_text(p_customer_name);
  v_phone text := private.normalize_phone(p_customer_phone);
  v_table text := upper(private.clean_text(p_table_label));
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

  -- An unknown or inactive table is dropped rather than blocking the order:
  -- fulfilment is counter pickup, the table is only a hint for staff.
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

    v_total := v_total + (v_item.price + v_addon_total) * v_qty;
    v_count := v_count + v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'menu_item_id', v_item.id, 'name', v_item.name, 'base_price', v_item.price,
      'addons', v_addons, 'unit_price', v_item.price + v_addon_total,
      'unit_cost', case when v_item_cost is null then null else v_item_cost + v_addon_cost end,
      'quantity', v_qty, 'note', v_note));
    v_item := null;
    v_item_cost := null;
  end loop;

  if v_count > 50 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
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
    table_label, payment_method, total, item_count
  ) values (
    v_hash, encode(extensions.gen_random_bytes(16), 'hex'), p_client_request_id, v_name, v_phone,
    v_table, p_payment_method, v_total, v_count
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

  insert into public.order_items (id, order_id, menu_item_id, name, base_price, addons, unit_price, quantity, line_total, note)
  select (l ->> 'id')::uuid, v_order.id, (l ->> 'menu_item_id')::uuid, l ->> 'name', (l ->> 'base_price')::integer, l -> 'addons',
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
-- Menu editing with costs. Keys "cost" (item) and "cost" (each add-on) are
-- optional: absent = unchanged, null = remove the cost.
-- ---------------------------------------------------------------------------
create or replace function public.save_menu_item(p_item jsonb)
returns uuid
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_id uuid := nullif(p_item ->> 'id', '')::uuid;
  v_addon jsonb;
  v_addon_id uuid;
  v_pos integer := 0;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if jsonb_typeof(coalesce(p_item -> 'addons', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_item -> 'addons', '[]'::jsonb)) > 12 then
    raise exception using errcode = '22023', message = 'invalid_addons';
  end if;
  if p_item ? 'cost' and jsonb_typeof(p_item -> 'cost') not in ('number', 'null') then
    raise exception using errcode = '22023', message = 'invalid_cost';
  end if;

  if v_id is null then
    insert into public.menu_items (category_id, name, description, price, is_veg, is_available, is_popular, image_path, sort_order)
    values (
      (p_item ->> 'category_id')::uuid,
      btrim(p_item ->> 'name'),
      coalesce(btrim(p_item ->> 'description'), ''),
      (p_item ->> 'price')::integer,
      coalesce((p_item ->> 'is_veg')::boolean, true),
      coalesce((p_item ->> 'is_available')::boolean, true),
      coalesce((p_item ->> 'is_popular')::boolean, false),
      nullif(p_item ->> 'image_path', ''),
      coalesce((p_item ->> 'sort_order')::integer,
               (select coalesce(max(sort_order), 0) + 1 from public.menu_items where category_id = (p_item ->> 'category_id')::uuid))
    )
    returning id into v_id;
  else
    update public.menu_items set
      category_id = (p_item ->> 'category_id')::uuid,
      name = btrim(p_item ->> 'name'),
      description = coalesce(btrim(p_item ->> 'description'), ''),
      price = (p_item ->> 'price')::integer,
      is_veg = coalesce((p_item ->> 'is_veg')::boolean, true),
      is_available = coalesce((p_item ->> 'is_available')::boolean, true),
      is_popular = coalesce((p_item ->> 'is_popular')::boolean, false),
      image_path = nullif(p_item ->> 'image_path', '')
    where id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'item_not_found';
    end if;
  end if;

  if p_item ? 'cost' then
    if jsonb_typeof(p_item -> 'cost') = 'null' then
      delete from public.menu_item_costs where menu_item_id = v_id;
    else
      insert into public.menu_item_costs (menu_item_id, cost) values (v_id, (p_item ->> 'cost')::integer)
      on conflict (menu_item_id) do update set cost = excluded.cost
      where public.menu_item_costs.cost is distinct from excluded.cost;
    end if;
  end if;

  -- Remove add-ons that are no longer listed first, so their names can be reused.
  delete from public.addons a
  where a.menu_item_id = v_id
    and a.id not in (
      select (x ->> 'id')::uuid from jsonb_array_elements(coalesce(p_item -> 'addons', '[]'::jsonb)) x
      where nullif(x ->> 'id', '') is not null
    );

  for v_addon in select * from jsonb_array_elements(coalesce(p_item -> 'addons', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_addon_id := nullif(v_addon ->> 'id', '')::uuid;
    if v_addon ? 'cost' and jsonb_typeof(v_addon -> 'cost') not in ('number', 'null') then
      raise exception using errcode = '22023', message = 'invalid_cost';
    end if;
    if v_addon_id is not null and exists (select 1 from public.addons where id = v_addon_id and menu_item_id = v_id) then
      update public.addons set
        name = btrim(v_addon ->> 'name'),
        price = (v_addon ->> 'price')::integer,
        is_available = coalesce((v_addon ->> 'is_available')::boolean, true),
        sort_order = v_pos
      where id = v_addon_id;
    else
      insert into public.addons (menu_item_id, name, price, is_available, sort_order)
      values (v_id, btrim(v_addon ->> 'name'), (v_addon ->> 'price')::integer,
              coalesce((v_addon ->> 'is_available')::boolean, true), v_pos)
      returning id into v_addon_id;
    end if;
    if v_addon ? 'cost' then
      if jsonb_typeof(v_addon -> 'cost') = 'null' then
        delete from public.addon_costs where addon_id = v_addon_id;
      else
        insert into public.addon_costs (addon_id, cost) values (v_addon_id, (v_addon ->> 'cost')::integer)
        on conflict (addon_id) do update set cost = excluded.cost
        where public.addon_costs.cost is distinct from excluded.cost;
      end if;
    end if;
  end loop;

  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Profit & loss (owner-only). Business day = Asia/Kolkata date, as in sales_summary.
--   sales      = non-cancelled orders (same as the sales report)
--   food cost  = quantity × cost recorded at the moment of sale
--   waste      = written-off stock × the item's cost at the time
--   expenses   = logged by date; the app decides how ingredient purchases are used
-- ---------------------------------------------------------------------------
create function public.profit_and_loss(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_result jsonb;
  v_start timestamptz := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;

  with o as (
    select * from public.orders where created_at >= v_start and created_at < v_end
  ),
  live as (select * from o where status <> 'cancelled'),
  lines as (
    select i.name, i.quantity, i.line_total, c.unit_cost,
           (live.created_at at time zone 'Asia/Kolkata')::date as day
    from public.order_items i
    join live on live.id = i.order_id
    left join public.order_item_costs c on c.order_item_id = i.id
  ),
  per_item as (
    select name, sum(quantity)::integer as quantity, sum(line_total)::integer as sales,
           coalesce(sum(quantity * unit_cost), 0)::integer as cost,
           count(*) filter (where unit_cost is null)::integer as uncosted_lines
    from lines group by name
  ),
  exp as (select * from public.expenses where spent_on between p_from and p_to),
  waste as (
    select * from public.stock_movements
    where kind = 'waste' and created_at >= v_start and created_at < v_end
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'orders', (select count(*) from live),
    'sales', (select coalesce(sum(total), 0) from live),
    'outstanding', (select coalesce(sum(total), 0) from live where payment_status = 'unpaid'),
    'refunds_due', (select coalesce(sum(total), 0) from o where status = 'cancelled' and payment_status = 'paid'),
    'food_cost', (select coalesce(sum(quantity * unit_cost), 0) from lines where unit_cost is not null),
    'costed_sales', (select coalesce(sum(line_total), 0) from lines where unit_cost is not null),
    'uncosted_sales', (select coalesce(sum(line_total), 0) from lines where unit_cost is null),
    'uncosted_items', (select count(distinct name) from lines where unit_cost is null),
    'waste_cost', (select coalesce(sum(-delta * unit_cost), 0) from waste where unit_cost is not null),
    'waste_units', (select coalesce(sum(-delta), 0) from waste),
    'waste_uncosted_units', (select coalesce(sum(-delta), 0) from waste where unit_cost is null),
    'expenses', coalesce((
      select jsonb_agg(e order by e.amount desc, e.category)
      from (select category, sum(amount)::integer as amount, count(*)::integer as entries from exp group by category) e
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', name, 'quantity', quantity, 'sales', sales,
               'cost', case when uncosted_lines = 0 then cost end)
             order by sales desc, name)
      from per_item
    ), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(d order by d.day)
      from (
        select day, sum(sales)::integer as sales, sum(food_cost)::integer as food_cost, sum(expenses)::integer as expenses
        from (
          select day, line_total as sales, coalesce(quantity * unit_cost, 0) as food_cost, 0 as expenses from lines
          union all
          select spent_on, 0, 0, amount from exp
        ) u
        group by day
      ) d
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Staff directory (owner-only): staff with their sign-in address.
-- ---------------------------------------------------------------------------
create function public.staff_directory()
returns table (
  user_id uuid, display_name text, role public.staff_role, is_active boolean,
  created_at timestamptz, email text, last_sign_in_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  return query
    select s.user_id, s.display_name, s.role, s.is_active, s.created_at, u.email::text, u.last_sign_in_at
    from public.staff s join auth.users u on u.id = s.user_id
    order by s.created_at;
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;
alter table public.menu_item_costs enable row level security;
alter table public.addon_costs enable row level security;
alter table public.order_item_costs enable row level security;
alter table public.stock_levels enable row level security;
alter table public.stock_movements enable row level security;
alter table public.expenses enable row level security;

create policy "audit: owner reads" on public.audit_log
  for select to authenticated using ((select private.is_owner()));

create policy "item costs: owner reads" on public.menu_item_costs
  for select to authenticated using ((select private.is_owner()));
create policy "item costs: owner inserts" on public.menu_item_costs
  for insert to authenticated with check ((select private.is_owner()));
create policy "item costs: owner updates" on public.menu_item_costs
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "item costs: owner deletes" on public.menu_item_costs
  for delete to authenticated using ((select private.is_owner()));

create policy "addon costs: owner reads" on public.addon_costs
  for select to authenticated using ((select private.is_owner()));
create policy "addon costs: owner inserts" on public.addon_costs
  for insert to authenticated with check ((select private.is_owner()));
create policy "addon costs: owner updates" on public.addon_costs
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "addon costs: owner deletes" on public.addon_costs
  for delete to authenticated using ((select private.is_owner()));

create policy "order costs: owner reads" on public.order_item_costs
  for select to authenticated using ((select private.is_owner()));

create policy "stock: public read" on public.stock_levels
  for select to anon, authenticated using (true);

create policy "stock history: owner reads" on public.stock_movements
  for select to authenticated using ((select private.is_owner()));

create policy "expenses: owner reads" on public.expenses
  for select to authenticated using ((select private.is_owner()));
create policy "expenses: owner inserts" on public.expenses
  for insert to authenticated with check ((select private.is_owner()));
create policy "expenses: owner updates" on public.expenses
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "expenses: owner deletes" on public.expenses
  for delete to authenticated using ((select private.is_owner()));

-- Owners add staff from the app (the auth account is created server-side first).
create policy "staff: owner inserts" on public.staff
  for insert to authenticated with check ((select private.is_owner()));

revoke all on public.audit_log, public.menu_item_costs, public.addon_costs, public.order_item_costs,
  public.stock_levels, public.stock_movements, public.expenses from anon, authenticated;

grant select on public.audit_log to authenticated;
grant select, insert, delete on public.menu_item_costs, public.addon_costs to authenticated;
grant update (cost) on public.menu_item_costs, public.addon_costs to authenticated;
grant select on public.order_item_costs to authenticated;
grant select on public.stock_levels to anon, authenticated;
grant select on public.stock_movements to authenticated;
grant select, delete on public.expenses to authenticated;
grant insert (spent_on, category, amount, note), update (spent_on, category, amount, note) on public.expenses to authenticated;
grant insert (user_id, display_name, role) on public.staff to authenticated;

revoke all on function public.stock_configure(uuid, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.stock_adjust(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.profit_and_loss(date, date) from public, anon, authenticated;
revoke all on function public.staff_directory() from public, anon, authenticated;
grant execute on function public.stock_configure(uuid, boolean, integer, integer) to authenticated;
grant execute on function public.stock_adjust(uuid, text, integer, text) to authenticated;
grant execute on function public.profit_and_loss(date, date) to authenticated;
grant execute on function public.staff_directory() to authenticated;

-- Staff screens follow stock live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.stock_levels;
  end if;
end
$$;
