-- TEAM JM UAT v3 - non-member donations and receipt address snapshots
-- Run once after 002_multi_year_quota_receipts.sql on an existing UAT v2 database.

begin;

alter table public.receipts
  add column if not exists payer_address varchar(500);

-- Preserve the best address available for existing receipts. The explicit
-- legacy text is honest when no historical address can be reconstructed.
update public.receipts as receipt
set payer_address = nullif(pg_catalog.btrim(member.address), '')
from public.members as member
where receipt.member_id = member.id
  and receipt.payer_address is null;

update public.receipts
set payer_address = 'Morada não registada no recibo original'
where payer_address is null;

alter table public.receipts
  alter column payer_address set not null,
  alter column payer_address set default 'Morada não indicada',
  alter column member_id drop not null,
  alter column member_number drop not null;

alter table public.receipts
  drop constraint if exists receipts_payer_address_not_blank,
  drop constraint if exists receipts_member_identity_pair,
  drop constraint if exists receipts_member_required_for_non_donation;

alter table public.receipts
  add constraint receipts_payer_address_not_blank check (
    pg_catalog.btrim(payer_address) <> ''
  ),
  add constraint receipts_member_identity_pair check (
    (member_id is null and member_number is null)
    or (member_id is not null and member_number is not null)
  ),
  add constraint receipts_member_required_for_non_donation check (
    receipt_type = 'Donativo' or member_id is not null
  );

-- Keep the audited UAT v2 quota implementation as a private helper. The v3
-- entry point adds an address snapshot to member receipts and handles the one
-- permitted member-free case: Donativo.
revoke all on function public.issue_receipt(jsonb) from public, anon, authenticated;
alter function public.issue_receipt(jsonb) rename to issue_member_receipt_v2;
revoke all on function public.issue_member_receipt_v2(jsonb) from public, anon, authenticated;

create or replace function public.issue_receipt(payload jsonb)
returns public.receipts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role public.app_role;
  v_receipt public.receipts%rowtype;
  v_text text;
  v_receipt_date date;
  v_receipt_type text;
  v_payment_method text;
  v_payer_name text;
  v_payer_tax_id text;
  v_payer_address text;
  v_amount numeric;
  v_description text;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select app_user.role into v_role
  from public.app_users as app_user
  where app_user.user_id = v_actor;

  if v_role is null or v_role not in ('admin'::public.app_role, 'staff'::public.app_role) then
    raise exception using errcode = '42501', message = 'Only an administrator or staff user can issue receipts';
  end if;

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be a JSON object';
  end if;

  v_receipt_type := pg_catalog.btrim(coalesce(payload ->> 'receipt_type', ''));
  if v_receipt_type not in ('Quota', 'Inscrição', 'Donativo', 'Patrocínio', 'Outro') then
    raise exception using errcode = '22023', message = 'receipt_type is invalid';
  end if;

  -- Any receipt with a member continues through the v2 atomic quota path.
  if nullif(pg_catalog.btrim(payload ->> 'member_id'), '') is not null
    or nullif(pg_catalog.btrim(payload ->> 'member_number'), '') is not null then
    v_receipt := public.issue_member_receipt_v2(payload);
    v_payer_address := coalesce(
      nullif(pg_catalog.btrim(payload ->> 'payer_address'), ''),
      (
        select nullif(pg_catalog.btrim(member.address), '')
        from public.members as member
        where member.id = v_receipt.member_id
      )
    );

    if v_payer_address is null then
      raise exception using errcode = '22023', message = 'payer_address is required';
    end if;
    if pg_catalog.char_length(v_payer_address) > 500 then
      raise exception using errcode = '22023', message = 'payer_address is too long';
    end if;

    update public.receipts as receipt
    set payer_address = v_payer_address
    where receipt.id = v_receipt.id
    returning * into v_receipt;

    return v_receipt;
  end if;

  if v_receipt_type <> 'Donativo' then
    raise exception using errcode = '22023', message = 'member_id or member_number is required for this receipt type';
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

  v_payer_name := nullif(pg_catalog.btrim(payload ->> 'payer_name'), '');
  v_payer_tax_id := nullif(pg_catalog.btrim(payload ->> 'payer_tax_id'), '');
  v_payer_address := nullif(pg_catalog.btrim(payload ->> 'payer_address'), '');
  v_description := coalesce(
    nullif(pg_catalog.btrim(payload ->> 'description'), ''),
    v_receipt_type
  );

  if v_payer_name is null then
    raise exception using errcode = '22023', message = 'payer_name is required';
  end if;
  if v_payer_address is null then
    raise exception using errcode = '22023', message = 'payer_address is required';
  end if;
  if pg_catalog.char_length(v_payer_name) > 200
    or pg_catalog.char_length(coalesce(v_payer_tax_id, '')) > 32
    or pg_catalog.char_length(v_payer_address) > 500
    or pg_catalog.char_length(v_description) > 500 then
    raise exception using errcode = '22023', message = 'A receipt text field is too long';
  end if;

  insert into public.receipts (
    member_id, member_number, receipt_date, receipt_type, payment_method,
    payer_name, payer_tax_id, payer_address, amount, description, quota_year,
    quota_years, created_by
  )
  values (
    null, null, v_receipt_date, v_receipt_type, v_payment_method,
    v_payer_name, v_payer_tax_id, v_payer_address, v_amount, v_description,
    null, null, v_actor
  )
  returning * into v_receipt;

  return v_receipt;
end;
$function$;

revoke all on function public.issue_receipt(jsonb) from public, anon, authenticated;
grant execute on function public.issue_receipt(jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
