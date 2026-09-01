-- TEAM JM UAT v2 - multi-year quota receipts
-- Run once in the SQL editor of an existing UAT project that already received
-- supabase/schema.sql. The transaction makes the upgrade all-or-nothing.

begin;

create or replace function public.quota_years_are_valid(p_years integer[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_year integer;
  v_previous integer;
begin
  if p_years is null or pg_catalog.cardinality(p_years) = 0 then
    return false;
  end if;

  foreach v_year in array p_years
  loop
    if v_year is null or v_year < 1900 or v_year > 2200 then
      return false;
    end if;

    if v_previous is not null and v_year <= v_previous then
      return false;
    end if;

    v_previous := v_year;
  end loop;

  return true;
end;
$function$;

alter table public.receipts
  add column if not exists quota_years integer[];

-- Widening varchar(500) to text is lossless and lets the canonical description
-- list every newly paid and previously paid year.
alter table public.receipts
  alter column description type text;

-- Preserve every legacy receipt: its former quota_year becomes a one-item list.
update public.receipts
set quota_years = array[quota_year]
where receipt_type = 'Quota'
  and quota_year is not null
  and quota_years is null;

alter table public.receipts
  drop constraint if exists receipts_quota_year_matches_type;

alter table public.receipts
  add constraint receipts_quota_year_matches_type check (
    (
      receipt_type = 'Quota'
      and quota_year is not null
      and quota_years is not null
      and quota_year = quota_years[1]
      and public.quota_years_are_valid(quota_years)
    )
    or (
      receipt_type <> 'Quota'
      and quota_year is null
      and quota_years is null
    )
  );

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
  v_legacy_quota_year integer;
  v_quota_years integer[];
  v_paid_years integer[] := '{}'::integer[];
  v_previously_paid_years integer[] := '{}'::integer[];
  v_year_item jsonb;
  v_year integer;
  v_new_dues jsonb;
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
    v_legacy_quota_year := v_text::integer;
    if v_legacy_quota_year < 1900 or v_legacy_quota_year > 2200 then
      raise exception using errcode = '22023', message = 'quota_year is outside the supported range';
    end if;
  end if;

  if payload ? 'quota_years' and payload -> 'quota_years' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(payload -> 'quota_years') <> 'array' then
      raise exception using errcode = '22023', message = 'quota_years must be a JSON array';
    end if;

    if pg_catalog.jsonb_array_length(payload -> 'quota_years') = 0 then
      raise exception using errcode = '22023', message = 'quota_years cannot be empty';
    end if;

    if pg_catalog.jsonb_array_length(payload -> 'quota_years') > 301 then
      raise exception using errcode = '22023', message = 'quota_years contains too many years';
    end if;

    v_quota_years := '{}'::integer[];
    for v_year_item in
      select item.value
      from pg_catalog.jsonb_array_elements(payload -> 'quota_years') as item(value)
    loop
      if pg_catalog.jsonb_typeof(v_year_item) <> 'number'
        or v_year_item::text !~ '^[0-9]{4}$' then
        raise exception using errcode = '22023', message = 'Every quota_years item must be a four-digit integer';
      end if;

      v_year := v_year_item::text::integer;
      if v_year < 1900 or v_year > 2200 then
        raise exception using errcode = '22023', message = 'A quota_years item is outside the supported range';
      end if;

      if v_year = any(v_quota_years) then
        raise exception using errcode = '22023', message = 'quota_years cannot contain duplicate years';
      end if;

      v_quota_years := pg_catalog.array_append(v_quota_years, v_year);
    end loop;

    select pg_catalog.array_agg(item.year order by item.year)
    into v_quota_years
    from pg_catalog.unnest(v_quota_years) as item(year);
  end if;

  if v_receipt_type = 'Quota' then
    if v_quota_years is null then
      if v_legacy_quota_year is null then
        raise exception using errcode = '22023', message = 'quota_years is required for a Quota receipt';
      end if;
      v_quota_years := array[v_legacy_quota_year];
    end if;

    v_quota_year := v_quota_years[1];
    if v_legacy_quota_year is not null and v_legacy_quota_year <> v_quota_year then
      raise exception using errcode = '22023', message = 'quota_year must match the first canonical quota_years item';
    end if;
  elsif v_legacy_quota_year is not null or v_quota_years is not null then
    raise exception using errcode = '22023', message = 'quota_year and quota_years can only be used with a Quota receipt';
  end if;

  v_payer_name := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'payer_name'), ''),
    v_member.name
  );
  v_payer_tax_id := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'payer_tax_id'), ''),
    v_member.nif
  );

  if v_receipt_type = 'Quota' then
    select coalesce(pg_catalog.array_agg(candidate.year order by candidate.year), '{}'::integer[])
    into v_paid_years
    from pg_catalog.unnest(v_quota_years) as candidate(year)
    where v_member.dues ->> candidate.year::text = 'Pago'
       or exists (
         select 1
         from public.receipts as existing
         where existing.member_id = v_member.id
           and existing.receipt_type = 'Quota'
           and (
             existing.quota_year = candidate.year
             or existing.quota_years @> array[candidate.year]
           )
       );

    if pg_catalog.cardinality(v_paid_years) > 0 then
      raise exception using
        errcode = '23505',
        message = pg_catalog.format(
          'A quota is already paid for year(s): %s',
          pg_catalog.array_to_string(v_paid_years, ', ')
        );
    end if;

    select coalesce(pg_catalog.array_agg(distinct history.year order by history.year), '{}'::integer[])
    into v_previously_paid_years
    from (
      select ledger.key::integer as year
      from pg_catalog.jsonb_each_text(v_member.dues) as ledger(key, value)
      where ledger.value = 'Pago'

      union

      select receipt_year.year
      from public.receipts as existing
      cross join lateral pg_catalog.unnest(
        coalesce(existing.quota_years, array[existing.quota_year])
      ) as receipt_year(year)
      where existing.member_id = v_member.id
        and existing.receipt_type = 'Quota'
        and receipt_year.year is not null
    ) as history;

    v_description := pg_catalog.format(
      'Quotas pagas agora: %s. Anos já pagos anteriormente: %s.',
      pg_catalog.array_to_string(v_quota_years, ', '),
      case
        when pg_catalog.cardinality(v_previously_paid_years) = 0 then 'nenhum'
        else pg_catalog.array_to_string(v_previously_paid_years, ', ')
      end
    );
  else
    v_description := coalesce(
      nullif(pg_catalog.btrim(payload ->> 'description'), ''),
      v_receipt_type
    );
  end if;

  if pg_catalog.char_length(v_payer_name) > 200
    or pg_catalog.char_length(coalesce(v_payer_tax_id, '')) > 32
    or (v_receipt_type <> 'Quota' and pg_catalog.char_length(v_description) > 500) then
    raise exception using errcode = '22023', message = 'A receipt text field is too long';
  end if;

  insert into public.receipts (
    member_id, member_number, receipt_date, receipt_type, payment_method,
    payer_name, payer_tax_id, amount, description, quota_year, quota_years,
    created_by
  )
  values (
    v_member.id, v_member.member_number, v_receipt_date, v_receipt_type,
    v_payment_method, v_payer_name, v_payer_tax_id, v_amount,
    v_description, v_quota_year, v_quota_years, v_actor
  )
  returning * into v_receipt;

  if v_quota_years is not null then
    v_new_dues := v_member.dues;
    foreach v_year in array v_quota_years
    loop
      v_new_dues := pg_catalog.jsonb_set(
        v_new_dues,
        array[v_year::text],
        pg_catalog.to_jsonb('Pago'::text),
        true
      );
    end loop;

    update public.members as m
    set dues = v_new_dues,
        updated_by = v_actor
    where m.id = v_member.id;
  end if;

  return v_receipt;
end;
$function$;

revoke all on function public.quota_years_are_valid(integer[]) from public, anon, authenticated;
revoke all on function public.issue_receipt(jsonb) from public, anon, authenticated;
grant execute on function public.issue_receipt(jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
