-- TEAM JM UAT v2
-- Run this file only in the SQL editor of the separate UAT Supabase project.
-- It intentionally creates no production credentials or seed/member data.

begin;

do $block$
begin
  create type public.app_role as enum ('admin', 'staff', 'viewer');
exception
  when duplicate_object then null;
end;
$block$;

create or replace function public.dues_are_valid(p_dues jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_entry record;
begin
  if p_dues is null or pg_catalog.jsonb_typeof(p_dues) <> 'object' then
    return false;
  end if;

  for v_entry in
    select item.key, item.value
    from pg_catalog.jsonb_each_text(p_dues) as item
  loop
    if v_entry.key !~ '^[0-9]{4}$' then
      return false;
    end if;

    if v_entry.key::integer < 1900 or v_entry.key::integer > 2200 then
      return false;
    end if;

    if v_entry.value not in ('Pago', 'Pendente') then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

create table if not exists public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'viewer'::public.app_role,
  display_name varchar(200),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  member_number bigint generated always as identity,
  name varchar(200) not null,
  contact varchar(64),
  nif varchar(32),
  locality varchar(160),
  address varchar(500),
  postal varchar(32),
  email varchar(320),
  payment_mode varchar(80),
  registration_date date,
  notes varchar(5000),
  removed boolean not null default false,
  dues jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint members_member_number_key unique (member_number),
  constraint members_member_number_positive check (member_number > 0),
  constraint members_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint members_dues_valid check (public.dues_are_valid(dues))
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number bigint generated always as identity,
  member_id uuid not null references public.members(id) on delete restrict,
  member_number bigint not null,
  receipt_date date not null default current_date,
  receipt_type varchar(40) not null,
  payment_method varchar(80) not null,
  payer_name varchar(200) not null,
  payer_tax_id varchar(32),
  amount numeric(12, 2) not null,
  description varchar(500) not null,
  quota_year integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint receipts_receipt_number_key unique (receipt_number),
  constraint receipts_receipt_number_positive check (receipt_number > 0),
  constraint receipts_member_number_positive check (member_number > 0),
  constraint receipts_payer_name_not_blank check (pg_catalog.btrim(payer_name) <> ''),
  constraint receipts_description_not_blank check (pg_catalog.btrim(description) <> ''),
  constraint receipts_amount_positive check (amount > 0),
  constraint receipts_quota_year_range check (quota_year is null or quota_year between 1900 and 2200),
  constraint receipts_type_allowed check (receipt_type in ('Quota', 'Inscrição', 'Donativo', 'Patrocínio', 'Outro')),
  constraint receipts_payment_allowed check (payment_method in ('Transferência bancária', 'Dinheiro', 'MB WAY', 'Cheque', 'Outro')),
  constraint receipts_quota_year_matches_type check ((receipt_type = 'Quota') = (quota_year is not null))
);

create index if not exists app_users_role_idx on public.app_users (role);
create index if not exists members_removed_number_idx on public.members (removed, member_number);
create index if not exists members_name_lower_idx on public.members ((pg_catalog.lower(name)));
create index if not exists receipts_member_date_idx on public.receipts (member_id, receipt_date desc);
create index if not exists receipts_created_at_idx on public.receipts (created_at desc);

create or replace function public.touch_app_user_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists app_users_touch_updated_at on public.app_users;
create trigger app_users_touch_updated_at
before update on public.app_users
for each row execute function public.touch_app_user_updated_at();

create or replace function public.touch_member_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.member_number is distinct from old.member_number
      or new.created_at is distinct from old.created_at then
      raise exception using
        errcode = '22023',
        message = 'id, member_number and created_at are immutable';
    end if;
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end;
$function$;

drop trigger if exists members_touch_audit_fields on public.members;
create trigger members_touch_audit_fields
before insert or update on public.members
for each row execute function public.touch_member_audit_fields();

create or replace function public.bootstrap_app_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.app_users (user_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
      'Utilizador'
    )
  )
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

drop trigger if exists team_jm_uat_auth_user_created on auth.users;
create trigger team_jm_uat_auth_user_created
after insert on auth.users
for each row execute function public.bootstrap_app_user();

-- Also covers users invited before this schema was installed.
insert into public.app_users (user_id, display_name)
select
  u.id,
  coalesce(
    nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'display_name'), ''),
    nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(pg_catalog.split_part(coalesce(u.email, ''), '@', 1), ''),
    'Utilizador'
  )
from auth.users as u
on conflict (user_id) do nothing;

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $function$
  select au.role
  from public.app_users as au
  where au.user_id = (select auth.uid())
$function$;

alter table public.app_users enable row level security;
alter table public.members enable row level security;
alter table public.receipts enable row level security;

drop policy if exists app_users_read_own_or_admin on public.app_users;
create policy app_users_read_own_or_admin
on public.app_users
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.current_app_role() = 'admin'::public.app_role
);

drop policy if exists members_read_authenticated on public.members;
create policy members_read_authenticated
on public.members
for select
to authenticated
using ((select auth.uid()) is not null);

drop policy if exists members_insert_editors on public.members;
create policy members_insert_editors
on public.members
for insert
to authenticated
with check (public.current_app_role() in ('admin'::public.app_role, 'staff'::public.app_role));

drop policy if exists members_update_editors on public.members;
create policy members_update_editors
on public.members
for update
to authenticated
using (public.current_app_role() in ('admin'::public.app_role, 'staff'::public.app_role))
with check (public.current_app_role() in ('admin'::public.app_role, 'staff'::public.app_role));

drop policy if exists receipts_read_authenticated on public.receipts;
create policy receipts_read_authenticated
on public.receipts
for select
to authenticated
using ((select auth.uid()) is not null);

create or replace function public.admin_import_members(payload jsonb, replace_existing boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role public.app_role;
  v_row jsonb;
  v_index integer;
  v_count integer;
  v_number bigint;
  v_text text;
  v_name text;
  v_contact text;
  v_nif text;
  v_locality text;
  v_address text;
  v_postal text;
  v_email text;
  v_payment_mode text;
  v_registration_date date;
  v_notes text;
  v_removed boolean;
  v_dues jsonb;
  v_exists boolean;
  v_changed integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_archived integer := 0;
  v_max_member_number bigint;
  v_sequence_last bigint;
  v_sequence_name text;
  v_replace boolean := coalesce(replace_existing, false);
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select au.role into v_role
  from public.app_users as au
  where au.user_id = v_actor;

  if v_role is distinct from 'admin'::public.app_role then
    raise exception using errcode = '42501', message = 'Only an administrator can import members';
  end if;

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'array' then
    raise exception using errcode = '22023', message = 'payload must be a JSON array';
  end if;

  v_count := pg_catalog.jsonb_array_length(payload);
  if v_count = 0 then
    raise exception using errcode = '22023', message = 'The import cannot be empty';
  end if;

  if v_count > 2000 then
    raise exception using errcode = '22023', message = 'The import is limited to 2000 members';
  end if;

  -- Validate the complete batch before changing a row. Any exception rolls the
  -- whole function call back, including a replacement archive operation.
  for v_row, v_index in
    select item.value, item.ordinality::integer
    from pg_catalog.jsonb_array_elements(payload) with ordinality as item(value, ordinality)
  loop
    if pg_catalog.jsonb_typeof(v_row) <> 'object' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Import row %s must be a JSON object', v_index);
    end if;

    v_text := pg_catalog.btrim(coalesce(v_row ->> 'member_number', ''));
    if v_text !~ '^[1-9][0-9]*$' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Import row %s has an invalid member_number', v_index);
    end if;

    begin
      v_number := v_text::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('Import row %s member_number is too large', v_index);
    end;

    v_name := pg_catalog.btrim(coalesce(v_row ->> 'name', ''));
    if v_name = '' or pg_catalog.char_length(v_name) > 200 then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Import row %s requires a name of at most 200 characters', v_index);
    end if;

    if pg_catalog.char_length(coalesce(v_row ->> 'contact', '')) > 64
      or pg_catalog.char_length(coalesce(v_row ->> 'nif', '')) > 32
      or pg_catalog.char_length(coalesce(v_row ->> 'locality', '')) > 160
      or pg_catalog.char_length(coalesce(v_row ->> 'address', '')) > 500
      or pg_catalog.char_length(coalesce(v_row ->> 'postal', '')) > 32
      or pg_catalog.char_length(coalesce(v_row ->> 'email', '')) > 320
      or pg_catalog.char_length(coalesce(v_row ->> 'payment_mode', '')) > 80
      or pg_catalog.char_length(coalesce(v_row ->> 'notes', '')) > 5000 then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Import row %s contains a field that is too long', v_index);
    end if;

    v_text := pg_catalog.btrim(coalesce(v_row ->> 'registration_date', ''));
    if v_text <> '' then
      begin
        perform v_text::date;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          raise exception using
            errcode = '22023',
            message = pg_catalog.format('Import row %s has an invalid registration_date', v_index);
      end;
    end if;

    if v_row ? 'removed' and v_row -> 'removed' <> 'null'::jsonb then
      v_text := pg_catalog.lower(pg_catalog.btrim(v_row ->> 'removed'));
      if v_text not in ('true', 'false') then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('Import row %s removed must be true or false', v_index);
      end if;
    end if;

    v_dues := case
      when v_row ? 'dues' and v_row -> 'dues' <> 'null'::jsonb then v_row -> 'dues'
      else '{}'::jsonb
    end;

    if not public.dues_are_valid(v_dues) then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Import row %s has invalid dues; use four-digit years with Pago or Pendente', v_index);
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(payload) as item(value)
    group by (item.value ->> 'member_number')::bigint
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'The import contains duplicate member_number values';
  end if;

  -- Serialize imports with normal member writes. This prevents two simultaneous
  -- imports from racing while still keeping the entire operation transactional.
  lock table public.members in share row exclusive mode;

  if v_replace then
    update public.members as m
    set removed = true,
        updated_by = v_actor
    where not m.removed
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(payload) as item(value)
        where (item.value ->> 'member_number')::bigint = m.member_number
      );
    get diagnostics v_archived = row_count;
  end if;

  for v_row in
    select item.value
    from pg_catalog.jsonb_array_elements(payload) as item(value)
  loop
    v_number := (v_row ->> 'member_number')::bigint;
    v_name := pg_catalog.btrim(v_row ->> 'name');
    v_contact := nullif(pg_catalog.btrim(v_row ->> 'contact'), '');
    v_nif := nullif(pg_catalog.btrim(v_row ->> 'nif'), '');
    v_locality := nullif(pg_catalog.btrim(v_row ->> 'locality'), '');
    v_address := nullif(pg_catalog.btrim(v_row ->> 'address'), '');
    v_postal := nullif(pg_catalog.btrim(v_row ->> 'postal'), '');
    v_email := nullif(pg_catalog.btrim(v_row ->> 'email'), '');
    v_payment_mode := nullif(pg_catalog.btrim(v_row ->> 'payment_mode'), '');
    v_text := nullif(pg_catalog.btrim(v_row ->> 'registration_date'), '');
    v_registration_date := case when v_text is null then null else v_text::date end;
    v_notes := nullif(pg_catalog.btrim(v_row ->> 'notes'), '');
    v_removed := case
      when v_row ? 'removed' and v_row -> 'removed' <> 'null'::jsonb
        then pg_catalog.lower(pg_catalog.btrim(v_row ->> 'removed'))::boolean
      else false
    end;
    v_dues := case
      when v_row ? 'dues' and v_row -> 'dues' <> 'null'::jsonb then v_row -> 'dues'
      else '{}'::jsonb
    end;

    select exists (
      select 1 from public.members as m where m.member_number = v_number
    ) into v_exists;

    if v_exists then
      update public.members as m
      set name = v_name,
          contact = v_contact,
          nif = v_nif,
          locality = v_locality,
          address = v_address,
          postal = v_postal,
          email = v_email,
          payment_mode = v_payment_mode,
          registration_date = v_registration_date,
          notes = v_notes,
          removed = v_removed,
          dues = v_dues,
          updated_by = v_actor
      where m.member_number = v_number
        and row(
          m.name, m.contact, m.nif, m.locality, m.address, m.postal,
          m.email, m.payment_mode, m.registration_date, m.notes,
          m.removed, m.dues
        ) is distinct from row(
          v_name, v_contact, v_nif, v_locality, v_address, v_postal,
          v_email, v_payment_mode, v_registration_date, v_notes,
          v_removed, v_dues
        );
      get diagnostics v_changed = row_count;
      v_updated := v_updated + v_changed;
    else
      insert into public.members (
        member_number, name, contact, nif, locality, address, postal, email,
        payment_mode, registration_date, notes, removed, dues, updated_by
      ) overriding system value
      values (
        v_number, v_name, v_contact, v_nif, v_locality, v_address, v_postal,
        v_email, v_payment_mode, v_registration_date, v_notes, v_removed,
        v_dues, v_actor
      );
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  -- Explicit member numbers used by an import do not advance an identity by
  -- themselves. Move it to the current maximum so the next manual member is safe.
  select pg_catalog.max(m.member_number) into v_max_member_number
  from public.members as m;

  if v_max_member_number is not null then
    v_sequence_name := pg_catalog.pg_get_serial_sequence('public.members', 'member_number');
    select sequence_state.last_value into v_sequence_last
    from public.members_member_number_seq as sequence_state;
    perform pg_catalog.setval(
      v_sequence_name::regclass,
      greatest(v_max_member_number, v_sequence_last),
      true
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'mode', case when v_replace then 'replace' else 'merge' end,
    'imported', v_count,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_count - v_inserted - v_updated,
    'archived', v_archived
  );
end;
$function$;

create or replace function public.issue_receipt(payload jsonb)
returns public.receipts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role public.app_role;
  v_member public.members%rowtype;
  v_receipt public.receipts%rowtype;
  v_member_id uuid;
  v_member_number bigint;
  v_text text;
  v_receipt_date date;
  v_receipt_type text;
  v_payment_method text;
  v_payer_name text;
  v_payer_tax_id text;
  v_amount numeric;
  v_description text;
  v_quota_year integer;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select au.role into v_role
  from public.app_users as au
  where au.user_id = v_actor;

  if v_role is null or v_role not in ('admin'::public.app_role, 'staff'::public.app_role) then
    raise exception using errcode = '42501', message = 'Only an administrator or staff user can issue receipts';
  end if;

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be a JSON object';
  end if;

  v_text := nullif(pg_catalog.btrim(payload ->> 'member_id'), '');
  if v_text is not null then
    begin
      v_member_id := v_text::uuid;
    exception
      when invalid_text_representation then
        raise exception using errcode = '22023', message = 'member_id must be a UUID';
    end;
  end if;

  v_text := nullif(pg_catalog.btrim(payload ->> 'member_number'), '');
  if v_text is not null then
    if v_text !~ '^[1-9][0-9]*$' then
      raise exception using errcode = '22023', message = 'member_number must be a positive integer';
    end if;
    begin
      v_member_number := v_text::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception using errcode = '22023', message = 'member_number is too large';
    end;
  end if;

  if v_member_id is null and v_member_number is null then
    raise exception using errcode = '22023', message = 'member_id or member_number is required';
  end if;

  select m.* into v_member
  from public.members as m
  where (v_member_id is null or m.id = v_member_id)
    and (v_member_number is null or m.member_number = v_member_number)
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found, or member_id and member_number do not match';
  end if;

  if v_member.removed then
    raise exception using errcode = '22023', message = 'A receipt cannot be issued to an archived member';
  end if;

  v_text := nullif(pg_catalog.btrim(payload ->> 'receipt_date'), '');
  if v_text is null then
    v_receipt_date := current_date;
  else
    begin
      v_receipt_date := v_text::date;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'receipt_date must be a valid ISO date';
    end;
  end if;

  v_receipt_type := pg_catalog.btrim(coalesce(payload ->> 'receipt_type', ''));
  if v_receipt_type not in ('Quota', 'Inscrição', 'Donativo', 'Patrocínio', 'Outro') then
    raise exception using errcode = '22023', message = 'receipt_type is invalid';
  end if;

  v_payment_method := pg_catalog.btrim(coalesce(payload ->> 'payment_method', ''));
  if v_payment_method not in ('Transferência bancária', 'Dinheiro', 'MB WAY', 'Cheque', 'Outro') then
    raise exception using errcode = '22023', message = 'payment_method is invalid';
  end if;

  v_text := nullif(pg_catalog.btrim(payload ->> 'amount'), '');
  if v_text is null then
    raise exception using errcode = '22023', message = 'amount is required';
  end if;
  begin
    v_amount := v_text::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'amount must be a valid number';
  end;
  if v_amount <= 0 or v_amount > 9999999999.99 then
    raise exception using errcode = '22023', message = 'amount must be greater than zero and fit the receipt limit';
  end if;

  v_text := nullif(pg_catalog.btrim(payload ->> 'quota_year'), '');
  if v_text is not null then
    if v_text !~ '^[0-9]{4}$' then
      raise exception using errcode = '22023', message = 'quota_year must be a four-digit year';
    end if;
    v_quota_year := v_text::integer;
    if v_quota_year < 1900 or v_quota_year > 2200 then
      raise exception using errcode = '22023', message = 'quota_year is outside the supported range';
    end if;
  end if;

  if v_receipt_type = 'Quota' and v_quota_year is null then
    raise exception using errcode = '22023', message = 'quota_year is required for a Quota receipt';
  end if;

  if v_receipt_type <> 'Quota' and v_quota_year is not null then
    raise exception using errcode = '22023', message = 'quota_year can only be used with a Quota receipt';
  end if;

  v_payer_name := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'payer_name'), ''),
    v_member.name
  );
  v_payer_tax_id := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'payer_tax_id'), ''),
    v_member.nif
  );
  v_description := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'description'), ''),
    case
      when v_quota_year is not null then pg_catalog.format('Quota %s', v_quota_year)
      else v_receipt_type
    end
  );

  if pg_catalog.char_length(v_payer_name) > 200
    or pg_catalog.char_length(coalesce(v_payer_tax_id, '')) > 32
    or pg_catalog.char_length(v_description) > 500 then
    raise exception using errcode = '22023', message = 'A receipt text field is too long';
  end if;

  insert into public.receipts (
    member_id, member_number, receipt_date, receipt_type, payment_method,
    payer_name, payer_tax_id, amount, description, quota_year, created_by
  )
  values (
    v_member.id, v_member.member_number, v_receipt_date, v_receipt_type,
    v_payment_method, v_payer_name, v_payer_tax_id, v_amount,
    v_description, v_quota_year, v_actor
  )
  returning * into v_receipt;

  if v_quota_year is not null then
    update public.members as m
    set dues = pg_catalog.jsonb_set(
          m.dues,
          array[v_quota_year::text],
          pg_catalog.to_jsonb('Pago'::text),
          true
        ),
        updated_by = v_actor
    where m.id = v_member.id
      and m.dues ->> v_quota_year::text is distinct from 'Pago';
  end if;

  return v_receipt;
end;
$function$;

-- Remove PostgreSQL's permissive default function/table access and add back
-- only what the browser application needs. RLS remains the final row boundary.
revoke all on type public.app_role from public, anon, authenticated;
grant usage on type public.app_role to authenticated;

revoke all on table public.app_users, public.members, public.receipts from public, anon, authenticated;
grant select on table public.app_users to authenticated;
grant select, insert, update on table public.members to authenticated;
grant select on table public.receipts to authenticated;

revoke all on sequence public.members_member_number_seq, public.receipts_receipt_number_seq from public, anon, authenticated;
grant usage on sequence public.members_member_number_seq to authenticated;

revoke all on function public.dues_are_valid(jsonb) from public, anon, authenticated;
revoke all on function public.touch_app_user_updated_at() from public, anon, authenticated;
revoke all on function public.touch_member_audit_fields() from public, anon, authenticated;
revoke all on function public.bootstrap_app_user() from public, anon, authenticated;
revoke all on function public.current_app_role() from public, anon, authenticated;
revoke all on function public.admin_import_members(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.issue_receipt(jsonb) from public, anon, authenticated;

grant execute on function public.dues_are_valid(jsonb) to authenticated;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.admin_import_members(jsonb, boolean) to authenticated;
grant execute on function public.issue_receipt(jsonb) to authenticated;

grant usage on schema public to authenticated;

commit;
