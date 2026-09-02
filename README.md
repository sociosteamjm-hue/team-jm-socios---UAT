# TEAM JM — UAT v3

This directory is the v3 application upgrade for the existing pre-live Supabase database used by UAT v2. It intentionally keeps the same Supabase URL and browser-safe publishable key. No second Supabase project is required while this database remains the shared pre-live environment.

The database design includes:

- authenticated, shared read access to members and receipts;
- `admin`, `staff`, and `viewer` application roles;
- admin/staff member editing, with soft removal instead of browser-side deletion;
- admin-only transactional Excel imports;
- persistent, sequential receipts issued through one atomic database operation;
- multi-year quota receipts, with duplicate-payment protection and automatic quota updates;
- donativos for people or entities that are not members;
- an immutable payer-address snapshot on every newly issued receipt;
- an editable live draft preview and reprinting from receipt history;
- a Portuguese public page for membership applications, quota-payment notices, and donations;
- manual staff/admin approval or rejection of public requests, with atomic member/receipt creation;
- an `updated_at` value for optimistic concurrency checks; and
- no unauthenticated/local-storage fallback.

## 1. Prepare the existing pre-live Supabase database

If the existing database already has the UAT v2 schema, keep it and follow the migration instructions below. Do not reinstall the complete schema over existing tables.

Only when the existing database is completely empty should [`supabase/schema.sql`](supabase/schema.sql) be run as the initial installation. Confirm afterward that `public.app_users`, `public.members`, and `public.receipts` exist and have Row Level Security enabled. Keep authentication invitation-only unless open registration is deliberately required; the application has no sign-up screen.

### Upgrade an existing UAT project

For the existing database already running UAT v2, do **not** reinstall the full schema. Run [`supabase/migrations/003_external_donations_receipt_address.sql`](supabase/migrations/003_external_donations_receipt_address.sql) once in that same project's SQL Editor. It preserves all receipts, snapshots the best available member address onto historical receipts, and labels receipts whose old address cannot be reconstructed. Then run [`supabase/migrations/004_public_requests.sql`](supabase/migrations/004_public_requests.sql) to add the public-request workflow.

If the database predates multi-year quota receipts, run migrations `002`, `003`, and `004`, in that order. All migrations are transactional and target the same pre-live database.

## 2. Create users and assign roles

For the simplest UAT flow, create users from **Authentication → Users → Add user → Create new user** in the UAT Supabase dashboard, supply a temporary password, and enable **Auto Confirm User**. The application has no password-setup or password-recovery screen, so use **Send invitation** only after a separate password-completion page has been provided. A database trigger automatically creates an `app_users` row with the safe default role `viewer`. Users cannot promote themselves through the browser API.

After inviting the first account, promote it from the UAT SQL Editor. Replace the placeholder with that account's email:

```sql
update public.app_users as au
set role = 'admin'::public.app_role
where au.user_id = (
  select u.id
  from auth.users as u
  where lower(u.email) = lower('ADMIN_UAT_EMAIL_HERE')
);
```

Assign another invited account as staff in the same way:

```sql
update public.app_users as au
set role = 'staff'::public.app_role
where au.user_id = (
  select u.id
  from auth.users as u
  where lower(u.email) = lower('STAFF_UAT_EMAIL_HERE')
);
```

To return an account to read-only access, set `role = 'viewer'::public.app_role`. To inspect the current assignments without exposing them in the app:

```sql
select u.email, au.role, au.created_at, au.updated_at
from public.app_users as au
join auth.users as u on u.id = au.user_id
order by u.email;
```

Role capabilities are:

| Capability | Admin | Staff | Viewer |
| --- | :---: | :---: | :---: |
| View members and receipts | Yes | Yes | Yes |
| Create and edit members | Yes | Yes | No |
| Archive members | Yes | Yes | No |
| Issue receipts / mark a quota paid | Yes | Yes | No |
| Preview and reprint stored receipts | Yes | Yes | Yes |
| Review public requests | Yes | Yes | No |
| Import Excel data | Yes | No | No |
| Export from the application UI | Yes | No | No |

Import authorization is checked again inside the database RPC, so hiding a button is not its security boundary. Receipts likewise can only be issued by an admin or staff user through the secured RPC.

## 3. Configure the UAT browser app

Open [`supabase-config.js`](supabase-config.js) and replace only:

- `supabaseUrl` with the URL of the existing pre-live Supabase project; and
- `supabaseAnonKey` with that project's browser-safe publishable/anon key.

The v3 configuration is already copied from UAT v2 so both versions target the same pre-live database. Never put a `service_role` key or database password in this file. A publishable/anon key identifies the project; RLS and the signed-in user's role provide authorization.

The browser dependencies are pinned and vendored locally:

- `vendor/supabase-2.112.4.min.js` — Supabase JavaScript 2.112.4;
- `vendor/xlsx-0.20.3.full.min.js` — SheetJS 0.20.3; and
- their license files in the same directory.

No CDN or package installation is needed for these libraries.

## 4. Serve it locally

Serve the directory over HTTP rather than opening `index.html` directly. From the repository root, one simple option is:

```powershell
python -m http.server 8080 --directory uat-v3
```

Then visit `http://localhost:8080/`. Stop the server with `Ctrl+C`.

The public Portuguese form is available at `http://localhost:8080/public.html`. The login page also links to it, so a visitor does not need an application account.

## Fluxo dos pedidos públicos

A página pública permite pedir adesão como sócio, comunicar o pagamento de uma quota ou comunicar um donativo. Não cobra cartões nem confirma automaticamente transferências: o visitante indica os dados do pagamento já efetuado por transferência bancária ou MB WAY.

Cada submissão fica com o estado **Pendente** e recebe uma referência `PED-número`. Apenas utilizadores `admin` ou `staff` conseguem ler estes pedidos. Na área **Pedidos**, a equipa deve confirmar os dados e o movimento bancário antes de aprovar:

- uma adesão aprovada cria o novo sócio e atribui o próximo número disponível;
- uma quota aprovada procura o sócio ativo, emite o recibo e marca o respetivo ano como pago na mesma transação;
- um donativo aprovado emite um recibo sem exigir que o doador seja sócio;
- uma rejeição exige uma nota e não cria sócio nem recibo.

O formulário público nunca permite consultar a lista de pedidos, sócios ou recibos. Inclui um campo anti-bot invisível e limita cada endereço de email a cinco submissões por hora. Antes de uma futura publicação na Internet, recomenda-se acrescentar CAPTCHA/Turnstile e um mecanismo de email transacional caso seja necessário comunicar a decisão automaticamente.

## Theme behavior

The **Modo escuro / Modo claro** button in the top action bar changes the interface theme. On the first visit, the application follows the operating-system preference. A manual choice is stored locally in the browser under `team-jm-color-theme` and reused on later visits. This preference contains no member or receipt data.

The receipt print sheet deliberately remains white in both interface themes and the print stylesheet always uses a white page.

## Import behavior

Only an admin can reach the import flow in the application or successfully invoke `admin_import_members(payload jsonb, replace_existing boolean)` in the database.

- **Merge** (`replace_existing = false`) inserts new member numbers and updates matching member numbers. Members missing from the spreadsheet are left unchanged.
- **Replace** (`replace_existing = true`) does the same upsert and archives active members whose numbers are absent from the spreadsheet. It does not hard-delete members or their receipt history.
- The complete batch is validated before changes are made. Invalid rows, duplicate numbers, or any database error roll back the entire import.
- Member number is the idempotency key. Importing the same normalized file again creates no duplicate members.
- After an import, the identity sequence is advanced to the highest member number so a manually created member receives a safe next number.
- A single import is limited to 2,000 normalized member rows, matching `maxImportRows` in the browser configuration.

The import RPC expects a JSON array whose normalized objects use these keys:

```json
{
  "member_number": 123,
  "name": "Example Member",
  "contact": "",
  "nif": "",
  "locality": "",
  "address": "",
  "postal": "",
  "email": "",
  "payment_mode": "",
  "registration_date": "2026-05-22",
  "notes": "",
  "removed": false,
  "dues": { "2026": "Pago" }
}
```

The example is synthetic. Do not use real personal data in documentation or source control.

## Receipt behavior

`issue_receipt(payload jsonb)` normally looks up an active member by `member_id` or `member_number`, persists the receipt with an identity receipt number, and returns the stored row. A `Donativo` may omit both member identifiers; all other receipt types still require an active member. A new `Quota` receipt sends one or more years in `quota_years`; the legacy `quota_year` remains as the first selected year for compatibility. Other receipt types omit both values.

Every new receipt requires `payer_address`. This value is stored on the receipt as an immutable snapshot instead of being resolved from the current member record during reprinting. A later member-address change therefore does not alter an old receipt.

The selected years are sorted and stored together. The same transaction marks every selected year as `Pago`, rejects a year already recorded as paid, and builds the canonical description, for example: `Quotas pagas agora: 2027, 2028. Anos já pagos anteriormente: 2026.` The interface disables previously paid years and calculates the quota amount as the configured annual fee multiplied by the number of newly selected years. If any receipt or dues write fails, none of the changes are committed.

The form drives a live draft preview. Editing any field invalidates the previously selected printable receipt; the user must issue and save the new receipt before printing. Issuing no longer opens the print dialog automatically. A saved receipt can be selected from history, reviewed, and reprinted without generating another receipt or changing its saved fields.

Direct browser inserts into `receipts` are intentionally not granted. This prevents a client from choosing a receipt number, creating an unauthorized member-free receipt, or bypassing the atomic quota update.

## Optimistic editing

Every member has a server-maintained `updated_at`. When updating an existing member, the app should match both `id` and the `updated_at` value it originally loaded. If no row is returned, another user changed that record first; reload it before deciding whether to apply the edit again. The database also prevents changes to a member's UUID, identity member number, and creation timestamp.

## UAT checklist

Use separate test accounts for each role and synthetic member data.

- [ ] With no valid UAT configuration, the app fails closed and does not save member data to local storage.
- [ ] An unauthenticated visitor sees no member or receipt data.
- [ ] An unauthenticated visitor can open `public.html`, but cannot query public requests directly.
- [ ] Submit one membership, quota, and donation request and confirm each receives a `PED-` reference.
- [ ] Confirm the public form and all validation/error messages are in Portuguese.
- [ ] Confirm a viewer cannot see the **Pedidos** area or invoke the review operation.
- [ ] As staff, reject a request with a reason and confirm that no member or receipt is created.
- [ ] As staff, approve a membership request and confirm exactly one new member number is created.
- [ ] As staff, approve a quota request after checking the payment; confirm one receipt is issued and the quota year becomes paid.
- [ ] As staff, approve a non-member donation; confirm the receipt contains the submitted name/NIF/Morada.
- [ ] Try to review the same request twice or concurrently and confirm the second attempt is rejected.
- [ ] A newly created user starts as `viewer`.
- [ ] A viewer can search/view data but cannot create, edit, archive, import, export through the UI, or issue a receipt.
- [ ] A staff user can create/edit/archive a member and issue a receipt, but cannot import or export through the UI.
- [ ] An admin can merge-import, replace-import after confirmation, and export.
- [ ] Import the same file twice in merge mode and confirm that no duplicate member numbers are created.
- [ ] In merge mode, confirm that a member absent from the spreadsheet remains unchanged.
- [ ] In replace mode, confirm that a member absent from the spreadsheet becomes archived and receipt history remains present.
- [ ] Import a high member number, then create a member manually and confirm the identity number is higher.
- [ ] Export a file and import that export in merge mode; confirm fields and quota years round-trip correctly.
- [ ] Submit an invalid import and confirm that none of its rows are committed.
- [ ] Issue two receipts and confirm unique, increasing receipt numbers and persistence after reload.
- [ ] Change every editable receipt field and confirm the draft preview updates before issuing.
- [ ] Issue a member receipt and confirm its saved and printed Morada remains unchanged after editing the member.
- [ ] Issue a `Donativo` with “Sem sócio” and confirm it is saved with a blank member number and the manually entered name, NIF/NIPC and Morada.
- [ ] Confirm `Quota`, `Inscrição`, `Patrocínio` and `Outro` cannot be issued without an active member.
- [ ] Select an old receipt in history, reprint it, and confirm no new receipt number or database row is created.
- [ ] Issue a `Quota` receipt for two or more years and confirm one receipt lists all selected years and marks every matching quota as paid.
- [ ] Confirm the receipt description lists the years paid now and the years already paid previously.
- [ ] Attempt to select or submit an already paid year and confirm that it is rejected without creating another receipt.
- [ ] Attempt to issue a blank/zero-value receipt and confirm it is rejected.
- [ ] Open the same member in two sessions, save in the first, and confirm the stale second save is rejected.
- [ ] Verify mobile navigation exposes every permitted action, including sign-out.
- [ ] Sign out and confirm protected data is removed from the visible UI.

## Export limitation

Export is shown only to admins in this application's UI. That is useful workflow control, but it is **not a guarantee that staff or viewers cannot copy data**. Any user who is allowed to read member rows can copy visible text, use browser developer tools, or call the authenticated API directly.

Preventing copying would require denying that user access to the underlying fields (for example with a restricted view/RPC and stricter RLS), which is different from allowing them to view the full member list. Treat every account with read access as able to extract the data it can read.

## Before any production import

UAT testing does not replace a production backup. Before enabling or running a replace import against production later:

1. make and verify a restorable Supabase database backup/export;
2. test the exact spreadsheet in UAT;
3. review the import summary and archived count;
4. schedule the operation when other edits are paused; and
5. keep the source spreadsheet and backup under the association's data-protection controls.

Do not reuse this UAT project's URL, keys, test users, or synthetic data as a production migration shortcut.
