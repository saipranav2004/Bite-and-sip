-- Bite & Sip: raw materials (ingredients), recipes and automatic deduction.
--
--   * An ingredient has a free-text name and one base unit: grams, millilitres,
--     pieces or packets. All quantities are stored in that base unit, so
--     1.5 kg and 1500 g are the same number. The app converts kg/L/dozen.
--   * Stock changes only through functions that record a movement.
--   * An optional recipe (per menu item) deducts ingredients on every sale and
--     puts them back when the order is cancelled. Ingredient stock never blocks
--     an order: counts drift, and a missed sale costs more than a wrong count,
--     so stock may go below zero until the next count.
--   * Everything here is owner-only.

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  base_unit text not null check (base_unit in ('g', 'ml', 'pcs', 'packet')),
  display_unit text not null check (display_unit in ('g', 'kg', 'ml', 'L', 'pcs', 'dozen', 'packet')),
  on_hand numeric(14, 3) not null default 0 check (on_hand between -10000000 and 100000000),
  low_at numeric(14, 3) not null default 0 check (low_at between 0 and 100000000),
  -- ₹ per base unit, from the latest purchase.
  cost_per_unit numeric(14, 6) check (cost_per_unit is null or cost_per_unit >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredients_unit_family check (
    (base_unit = 'g' and display_unit in ('g', 'kg')) or
    (base_unit = 'ml' and display_unit in ('ml', 'L')) or
    (base_unit = 'pcs' and display_unit in ('pcs', 'dozen')) or
    (base_unit = 'packet' and display_unit = 'packet'))
);
create unique index ingredients_name_key on public.ingredients (lower(btrim(name))) where is_active;

create type public.ingredient_movement_kind as enum (
  'opening', 'purchase', 'usage', 'sale', 'cancel_return', 'waste', 'count', 'correction');

create table public.ingredient_movements (
  id bigint generated always as identity primary key,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  ingredient_name text not null,
  kind public.ingredient_movement_kind not null,
  delta numeric(14, 3) not null,
  on_hand_after numeric(14, 3) not null,
  -- ₹ per base unit at the time (purchases and waste).
  unit_cost numeric(14, 6),
  -- Total paid, for purchases.
  amount integer check (amount is null or amount between 0 and 10000000),
  order_id uuid references public.orders (id) on delete set null,
  expense_id uuid references public.expenses (id) on delete set null,
  note text check (note is null or char_length(note) <= 140),
  actor uuid references auth.users (id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now()
);
create index ingredient_movements_ingredient_idx on public.ingredient_movements (ingredient_id, created_at desc);
create index ingredient_movements_created_idx on public.ingredient_movements (created_at desc);
create index ingredient_movements_order_idx on public.ingredient_movements (order_id) where order_id is not null;

-- How much of each ingredient one unit of a menu item uses (base units).
create table public.recipe_lines (
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  quantity numeric(12, 3) not null check (quantity > 0 and quantity <= 100000),
  primary key (menu_item_id, ingredient_id)
);
create index recipe_lines_ingredient_idx on public.recipe_lines (ingredient_id);

create trigger ingredients_touch before update on public.ingredients
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Owner functions
-- ---------------------------------------------------------------------------
create function private.ingredient_json(i public.ingredients)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id, 'name', i.name, 'base_unit', i.base_unit, 'display_unit', i.display_unit,
    'on_hand', i.on_hand, 'low_at', i.low_at, 'cost_per_unit', i.cost_per_unit,
    'is_active', i.is_active, 'updated_at', i.updated_at)
$$;
revoke all on function private.ingredient_json(public.ingredients) from public;

-- Create or edit an ingredient. The base unit is fixed once it has history.
create function public.ingredient_save(p jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := private.clean_text(p ->> 'name');
  v_base text := p ->> 'base_unit';
  v_display text := p ->> 'display_unit';
  v_low numeric := coalesce((p ->> 'low_at')::numeric, 0);
  v_opening numeric := coalesce((p ->> 'opening')::numeric, 0);
  v_old public.ingredients;
  v_row public.ingredients;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if v_name is null or char_length(v_name) > 60 then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;
  if v_low < 0 or v_opening < 0 or v_opening > 100000000 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;
  if exists (select 1 from public.ingredients i where lower(btrim(i.name)) = lower(v_name) and i.is_active and i.id is distinct from v_id) then
    raise exception using errcode = 'P0001', message = 'ingredient_exists';
  end if;

  if v_id is null then
    insert into public.ingredients (name, base_unit, display_unit, on_hand, low_at)
    values (v_name, v_base, v_display, v_opening, v_low)
    returning * into v_row;
    insert into public.ingredient_movements (ingredient_id, ingredient_name, kind, delta, on_hand_after, actor, actor_name)
    values (v_row.id, v_row.name, 'opening', v_opening, v_opening, (select auth.uid()), private.actor_name());
    perform private.audit('ingredient', 'ingredient.created', v_row.id::text, v_row.name,
      jsonb_build_object('on_hand', jsonb_build_array(null, v_row.on_hand), 'display_unit', jsonb_build_array(null, v_row.display_unit)));
  else
    select * into v_old from public.ingredients where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'ingredient_not_found';
    end if;
    if v_base is distinct from v_old.base_unit then
      raise exception using errcode = 'P0001', message = 'unit_family_locked';
    end if;
    update public.ingredients set name = v_name, display_unit = v_display, low_at = v_low
    where id = v_id returning * into v_row;
    perform private.audit('ingredient', 'ingredient.updated', v_row.id::text, v_row.name,
      private.jsonb_changes(
        jsonb_build_object('name', v_old.name, 'display_unit', v_old.display_unit, 'low_at', v_old.low_at),
        jsonb_build_object('name', v_row.name, 'display_unit', v_row.display_unit, 'low_at', v_row.low_at)));
  end if;
  return private.ingredient_json(v_row);
end
$$;

-- Archive (keeps history and past costs; the name becomes free to reuse).
create function public.ingredient_archive(p_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.ingredients;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  update public.ingredients set is_active = false where id = p_id and is_active returning * into v_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'ingredient_not_found';
  end if;
  delete from public.recipe_lines where ingredient_id = p_id;
  perform private.audit('ingredient', 'ingredient.archived', p_id::text, v_row.name, '{}'::jsonb);
end
$$;

-- Bought / used / wasted / counted / corrected. Quantities in base units.
create function public.ingredient_adjust(
  p_id uuid, p_kind text, p_quantity numeric, p_amount integer, p_note text, p_add_expense boolean, p_label text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.ingredients;
  v_before numeric;
  v_delta numeric;
  v_cost numeric;
  v_note text := private.clean_text(p_note);
  v_label text := private.clean_text(p_label);
  v_expense uuid;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_kind is null or p_kind not in ('purchase', 'usage', 'waste', 'count', 'correction') then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if p_quantity is null or p_quantity > 100000000 or p_quantity < -100000000 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;
  if v_note is not null and char_length(v_note) > 140 then
    raise exception using errcode = '22023', message = 'invalid_note';
  end if;
  if v_label is not null and char_length(v_label) > 40 then
    v_label := left(v_label, 40);
  end if;

  select * into v_row from public.ingredients where id = p_id and is_active for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ingredient_not_found';
  end if;
  v_before := v_row.on_hand;

  case p_kind
    when 'purchase' then
      if p_quantity <= 0 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      if p_amount is not null and (p_amount < 0 or p_amount > 10000000) then
        raise exception using errcode = '22023', message = 'invalid_amount';
      end if;
      v_delta := p_quantity;
      if p_amount is not null and p_amount > 0 then
        v_cost := p_amount / p_quantity;
      end if;
    when 'usage', 'waste' then
      if p_quantity <= 0 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      v_delta := -p_quantity;
      v_cost := v_row.cost_per_unit;
    when 'count' then
      if p_quantity < 0 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      v_delta := p_quantity - v_row.on_hand;
    when 'correction' then
      if p_quantity = 0 then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      if v_note is null then
        raise exception using errcode = '22023', message = 'note_required';
      end if;
      v_delta := p_quantity;
  end case;

  update public.ingredients set
    on_hand = on_hand + v_delta,
    cost_per_unit = case when p_kind = 'purchase' and v_cost is not null then v_cost else cost_per_unit end
  where id = p_id returning * into v_row;

  if p_kind = 'purchase' and coalesce(p_add_expense, false) and coalesce(p_amount, 0) > 0 then
    insert into public.expenses (spent_on, category, amount, note)
    values ((now() at time zone 'Asia/Kolkata')::date, 'ingredients', p_amount,
            left(concat_ws(' · ', v_row.name || coalesce(' ' || v_label, ''), v_note), 140))
    returning id into v_expense;
  end if;

  insert into public.ingredient_movements (
    ingredient_id, ingredient_name, kind, delta, on_hand_after, unit_cost, amount, expense_id, note, actor, actor_name)
  values (
    p_id, v_row.name, p_kind::public.ingredient_movement_kind, v_delta, v_row.on_hand, v_cost,
    case when p_kind = 'purchase' then p_amount end, v_expense, v_note, (select auth.uid()), private.actor_name());

  perform private.audit('ingredient', 'ingredient.' || p_kind, p_id::text, v_row.name,
    jsonb_build_object('on_hand', jsonb_build_array(v_before, v_row.on_hand))
      || case when p_kind = 'purchase' and p_amount is not null then jsonb_build_object('amount', jsonb_build_array(null, p_amount)) else '{}'::jsonb end
      || case when v_note is not null then jsonb_build_object('note', jsonb_build_array(null, v_note)) else '{}'::jsonb end);

  return private.ingredient_json(v_row);
end
$$;

-- ---------------------------------------------------------------------------
-- Automatic deduction from recipes
-- ---------------------------------------------------------------------------
-- place_order inserts all lines of an order in one statement, so this runs
-- once per order. Rows are locked in id order so concurrent orders can't deadlock.
create function private.order_items_use_ingredients()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_order uuid;
begin
  for v_order in select distinct order_id from new_lines loop
    perform 1 from public.ingredients i
    where i.is_active and i.id in (
      select r.ingredient_id from new_lines l join public.recipe_lines r on r.menu_item_id = l.menu_item_id
      where l.order_id = v_order)
    order by i.id
    for update;

    with need as (
      select r.ingredient_id, sum(r.quantity * l.quantity) as qty
      from new_lines l join public.recipe_lines r on r.menu_item_id = l.menu_item_id
      where l.order_id = v_order
      group by r.ingredient_id
    ),
    upd as (
      update public.ingredients i set on_hand = greatest(i.on_hand - need.qty, -10000000)
      from need where i.id = need.ingredient_id and i.is_active
      returning i.id, i.name, i.on_hand, need.qty
    )
    insert into public.ingredient_movements (ingredient_id, ingredient_name, kind, delta, on_hand_after, order_id, actor_name)
    select upd.id, upd.name, 'sale', -upd.qty, upd.on_hand, v_order, 'Customer' from upd;
  end loop;
  return null;
end
$$;
revoke all on function private.order_items_use_ingredients() from public;

create trigger order_items_use_ingredients after insert on public.order_items
  referencing new table as new_lines
  for each statement execute function private.order_items_use_ingredients();

-- A cancelled order puts its ingredients back.
create function private.orders_return_ingredients()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform 1 from public.ingredients i
    where i.id in (select m.ingredient_id from public.ingredient_movements m where m.order_id = new.id)
    order by i.id
    for update;

    with used as (
      select m.ingredient_id, -sum(m.delta) as qty
      from public.ingredient_movements m
      where m.order_id = new.id and m.kind in ('sale', 'cancel_return') and m.ingredient_id is not null
      group by m.ingredient_id
      having -sum(m.delta) > 0
    ),
    upd as (
      update public.ingredients i set on_hand = least(i.on_hand + used.qty, 100000000)
      from used where i.id = used.ingredient_id
      returning i.id, i.name, i.on_hand, used.qty
    )
    insert into public.ingredient_movements (ingredient_id, ingredient_name, kind, delta, on_hand_after, order_id, actor, actor_name)
    select upd.id, upd.name, 'cancel_return', upd.qty, upd.on_hand, new.id,
           case when coalesce(current_setting('bite.actor', true), '') = 'customer' then null else (select auth.uid()) end,
           private.actor_name()
    from upd;
  end if;
  return null;
end
$$;
revoke all on function private.orders_return_ingredients() from public;

create trigger orders_return_ingredients after update on public.orders
  for each row execute function private.orders_return_ingredients();

-- Recipe edits are recorded in the audit log ("Masala Chai › Milk 100 → 120").
create function private.audit_recipe()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_item uuid := coalesce(new.menu_item_id, old.menu_item_id);
  v_ing uuid := coalesce(new.ingredient_id, old.ingredient_id);
  v_label text;
begin
  select m.name || ' › ' || i.name into v_label
  from public.menu_items m, public.ingredients i where m.id = v_item and i.id = v_ing;
  if v_label is null then
    return null; -- removed together with the item or ingredient
  end if;
  if tg_op = 'UPDATE' and new.quantity = old.quantity then
    return null;
  end if;
  perform private.audit('recipe', 'recipe.' || case tg_op when 'INSERT' then 'added' when 'UPDATE' then 'changed' else 'removed' end,
    v_item::text, v_label,
    jsonb_build_object('quantity', jsonb_build_array(
      case when tg_op <> 'INSERT' then old.quantity end,
      case when tg_op <> 'DELETE' then new.quantity end)));
  return null;
end
$$;
revoke all on function private.audit_recipe() from public;

create trigger recipe_lines_audit after insert or update or delete on public.recipe_lines
  for each row execute function private.audit_recipe();

-- ---------------------------------------------------------------------------
-- Menu editing: optional "recipe" key replaces the item's recipe
-- [{ingredient_id, quantity}], quantities in base units per item.
-- ---------------------------------------------------------------------------
create function private.save_recipe(p_menu_item_id uuid, p_lines jsonb)
returns void
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_line jsonb;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 30 then
    raise exception using errcode = '22023', message = 'invalid_recipe';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line -> 'quantity') <> 'number' or (v_line ->> 'quantity')::numeric <= 0
       or (v_line ->> 'quantity')::numeric > 100000
       or not exists (select 1 from public.ingredients i where i.id = (v_line ->> 'ingredient_id')::uuid and i.is_active) then
      raise exception using errcode = '22023', message = 'invalid_recipe';
    end if;
  end loop;

  delete from public.recipe_lines r
  where r.menu_item_id = p_menu_item_id
    and r.ingredient_id not in (select (x ->> 'ingredient_id')::uuid from jsonb_array_elements(p_lines) x);

  insert into public.recipe_lines (menu_item_id, ingredient_id, quantity)
  select p_menu_item_id, (x ->> 'ingredient_id')::uuid, round((x ->> 'quantity')::numeric, 3)
  from jsonb_array_elements(p_lines) x
  on conflict (menu_item_id, ingredient_id) do update set quantity = excluded.quantity
  where public.recipe_lines.quantity is distinct from excluded.quantity;
end
$$;
revoke all on function private.save_recipe(uuid, jsonb) from public;
grant execute on function private.save_recipe(uuid, jsonb) to authenticated;

-- Wrap the existing editor: same signature, adds the optional recipe.
alter function public.save_menu_item(jsonb) rename to save_menu_item_core;
revoke all on function public.save_menu_item_core(jsonb) from public, anon, authenticated;
alter function public.save_menu_item_core(jsonb) set schema private;
grant execute on function private.save_menu_item_core(jsonb) to authenticated;

create function public.save_menu_item(p_item jsonb)
returns uuid
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_id uuid := private.save_menu_item_core(p_item);
begin
  if p_item ? 'recipe' then
    perform private.save_recipe(v_id, coalesce(p_item -> 'recipe', '[]'::jsonb));
  end if;
  return v_id;
end
$$;
revoke all on function public.save_menu_item(jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_item(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Profit & loss: ingredient waste counts as waste (at the cost when it was wasted).
-- ---------------------------------------------------------------------------
create or replace function public.profit_and_loss(p_from date, p_to date)
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
  ),
  ing_waste as (
    select * from public.ingredient_movements
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
    'waste_cost', (select coalesce(sum(-delta * unit_cost), 0) from waste where unit_cost is not null)
                  + (select coalesce(round(sum(-delta * unit_cost)), 0) from ing_waste where unit_cost is not null),
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
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.ingredients enable row level security;
alter table public.ingredient_movements enable row level security;
alter table public.recipe_lines enable row level security;

create policy "ingredients: owner reads" on public.ingredients
  for select to authenticated using ((select private.is_owner()));
create policy "ingredient history: owner reads" on public.ingredient_movements
  for select to authenticated using ((select private.is_owner()));
create policy "recipes: owner reads" on public.recipe_lines
  for select to authenticated using ((select private.is_owner()));
create policy "recipes: owner inserts" on public.recipe_lines
  for insert to authenticated with check ((select private.is_owner()));
create policy "recipes: owner updates" on public.recipe_lines
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "recipes: owner deletes" on public.recipe_lines
  for delete to authenticated using ((select private.is_owner()));

revoke all on public.ingredients, public.ingredient_movements, public.recipe_lines from anon, authenticated;
grant select on public.ingredients, public.ingredient_movements to authenticated;
grant select, insert, delete on public.recipe_lines to authenticated;
grant update (quantity) on public.recipe_lines to authenticated;

revoke all on function public.ingredient_save(jsonb) from public, anon, authenticated;
revoke all on function public.ingredient_archive(uuid) from public, anon, authenticated;
revoke all on function public.ingredient_adjust(uuid, text, numeric, integer, text, boolean, text) from public, anon, authenticated;
grant execute on function public.ingredient_save(jsonb) to authenticated;
grant execute on function public.ingredient_archive(uuid) to authenticated;
grant execute on function public.ingredient_adjust(uuid, text, numeric, integer, text, boolean, text) to authenticated;
