# TEAM JM — UAT v2

This directory is an isolated test version of the membership application. It must use a **separate Supabase UAT project**. Do not point it at the production project, and do not copy production credentials or personal data into this repository.

The database design includes:

- authenticated, shared read access to members and receipts;
- `admin`, `staff`, and `viewer` application roles;
- admin/staff member editing, with soft removal instead of browser-side deletion;
- admin-only transactional Excel imports;
- persistent, sequential receipts issued through one atomic database operation;
- automatic quota updates when a receipt specifies a quota year;
- an `updated_at` value for optimistic concurrency checks; and
- no unauthenticated/local-storage fallback.

## 1. Create the separate Supabase UAT project

1. Create a new project in Supabase specifically for UAT. Give it an unmistakable name such as `team-jm-uat`.
2. In that project's SQL Editor, open and run [`supabase/schema.sql`](supabase/schema.sql) as one script.
3. Confirm that `public.app_users`, `public.members`, and `public.receipts` exist and have Row Level Security enabled.
4. In Authentication settings, keep access invitation-only for UAT unless open registration is deliberately required. The application itself has no sign-up screen.

The schema lives in `public` inside the separate UAT project. The separate project—not merely a different browser URL—is the isolation boundary from production.

## 2. Create users and assign roles

Create or invite users from **Authentication → Users** in the UAT Supabase dashboard. Add `http://localhost:8080/` to the UAT authentication redirect URLs if the invitation/password setup flow needs it, and have each user accept the invitation and set a password before testing. A database trigger automatically creates an `app_users` row with the safe default role `viewer`. Users cannot promote themselves through the browser API.

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
| Import Excel data | Yes | No | No |
| Export from the application UI | Yes | No | No |

Import authorization is checked again inside the database RPC, so hiding a button is not its security boundary. Receipts likewise can only be issued by an admin or staff user through the secured RPC.

## 3. Configure the UAT browser app

Open [`supabase-config.js`](supabase-config.js) and replace only:

- `supabaseUrl` with the URL of the new UAT project; and
- `supabaseAnonKey` with that project's browser-safe publishable/anon key.

Never put a `service_role` key, database password, production project URL, or production key in this file. A publishable/anon key identifies the project; RLS and the signed-in user's role provide authorization.

The browser dependencies are pinned and vendored locally:

- `vendor/supabase-2.112.4.min.js` — Supabase JavaScript 2.112.4;
- `vendor/xlsx-0.20.3.full.min.js` — SheetJS 0.20.3; and
- their license files in the same directory.

No CDN or package installation is needed for these libraries.

## 4. Serve it locally

Serve the directory over HTTP rather than opening `index.html` directly. From the repository root, one simple option is:

```powershell
python -m http.server 8080 --directory uat-v2
```

Then visit `http://localhost:8080/`. Stop the server with `Ctrl+C`.

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

`issue_receipt(payload jsonb)` looks up an active member by `member_id` or `member_number`, persists the receipt with an identity receipt number, and returns the stored row. A `Quota` receipt must include `quota_year`; other receipt types must omit it. The same transaction sets that member's matching dues entry to `Pago`. If either write fails, neither is committed.

Direct browser inserts into `receipts` are intentionally not granted. This prevents a client from choosing a receipt number or bypassing the atomic quota update.

## Optimistic editing

Every member has a server-maintained `updated_at`. When updating an existing member, the app should match both `id` and the `updated_at` value it originally loaded. If no row is returned, another user changed that record first; reload it before deciding whether to apply the edit again. The database also prevents changes to a member's UUID, identity member number, and creation timestamp.

## UAT checklist

Use separate test accounts for each role and synthetic member data.

- [ ] With no valid UAT configuration, the app fails closed and does not save member data to local storage.
- [ ] An unauthenticated visitor sees no member or receipt data.
- [ ] A newly invited user starts as `viewer`.
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
- [ ] Issue a `Quota` receipt with a year and confirm the receipt and paid quota appear together.
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
