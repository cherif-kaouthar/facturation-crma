-- 0001_init.sql
-- Cloud schema for the CRMA/LFB invoicing app.
--
-- Mirrors the local SQLite model 1:1 (server/db.js + server/repo.js):
--   invoices, invoice_lines, units, clients, counters, settings.
-- Cloud ids are UUIDs so rows created on different devices never collide.
--
-- Auth note: this app deliberately has NO login wall. Requests carry only the
-- publishable key, so the Postgres role is `anon` and RLS policies are
-- permissive (using (true)). The profiles/is_admin hooks are dormant and will
-- only matter if email/password auth is re-enabled later.

-- gen_random_uuid() is core in Postgres 13+; pgcrypto is a no-op on Supabase.
create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* profiles — dormant auth hook: one row per auth.users, is_admin flag */
/* ------------------------------------------------------------------ */
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

/* ------------------------------------------------------------------ */
/* settings — key/value, one JSONB row per local settings section      */
/* (company, client, billing, branding, app)                           */
/* ------------------------------------------------------------------ */
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

/* ------------------------------------------------------------------ */
/* units — mirror of local `units`                                     */
/* ------------------------------------------------------------------ */
create table if not exists public.units (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text not null default '',
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  deleted_at timestamptz
);

/* ------------------------------------------------------------------ */
/* clients — mirror of local `clients`                                 */
/* ------------------------------------------------------------------ */
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  type       text not null default 'company' check (type in ('company', 'person')),
  location   text not null default '',
  nif        text not null default '',
  art        text not null default '',
  phone      text not null default '',
  email      text not null default '',
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  deleted_at timestamptz
);

/* ------------------------------------------------------------------ */
/* invoices — mirror of local `invoices` + soft delete + author        */
/* ------------------------------------------------------------------ */
create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
  unit_id          uuid not null references public.units(id) on delete restrict,
  client_id        uuid references public.clients(id) on delete set null,
  client_name      text not null default '',
  client_type      text not null default 'company' check (client_type in ('company', 'person')),
  client_location  text not null default '',
  client_nif       text not null default '',
  client_art       text not null default '',
  client_phone     text not null default '',
  seq              integer not null,
  number           text not null,
  year             integer not null,
  date             date not null,
  notes            text not null default '',
  tva_rate         double precision not null default 0.19,
  page_orientation text not null default 'portrait' check (page_orientation in ('portrait', 'landscape')),
  total_nette      double precision not null default 0,
  total_tva        double precision not null default 0,
  total_fga        double precision not null default 0,
  total_timbre     double precision not null default 0,
  total_amount     double precision not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  deleted_at       timestamptz,
  unique (year, seq)
);

/* ------------------------------------------------------------------ */
/* invoice_lines — mirror of local `invoice_lines`; lines are replaced */
/* wholesale on every edit (matches the local DELETE + INSERT)         */
/* ------------------------------------------------------------------ */
create table if not exists public.invoice_lines (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  position   integer not null,
  police     text not null default '',
  echeance   date,
  nette      double precision not null default 0,
  fga        double precision not null default 0,
  timbre     double precision not null default 0,
  obs        text not null default '',
  unique (invoice_id, position)
);

create index if not exists idx_invoices_unit   on public.invoices (unit_id);
create index if not exists idx_invoices_year   on public.invoices (year);
create index if not exists idx_invoices_active on public.invoices (deleted_at) where deleted_at is null;
create index if not exists idx_lines_invoice   on public.invoice_lines (invoice_id);

/* ------------------------------------------------------------------ */
/* counters — per-year numbering authority (mirror of local `counters`) */
/* ------------------------------------------------------------------ */
create table if not exists public.counters (
  year     integer primary key,
  next_seq integer not null
);

/* ------------------------------------------------------------------ */
/* schema_migrations — tracked by the Electron migration runner        */
/* ------------------------------------------------------------------ */
create table if not exists public.schema_migrations (
  version    integer primary key,
  applied_at timestamptz not null default now()
);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  -- Keep an explicit updated_at (sync pushes carry one); only stamp now()
  -- when the caller did not set it (cloud-side edits, tombstones).
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

/* Dormant: only fires once email/password auth is re-enabled. */
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, not exists (select 1 from public.profiles))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ------------------------------------------------------------------ */
/* Server-side invoice numbering                                       */
/* ------------------------------------------------------------------ */
-- On INSERT, if seq is NULL the trigger atomically reserves the next seq
-- for the year (counter row locked via FOR UPDATE), re-anchors to
-- max(seq)+1 so backfilled/imported invoices never clash, and formats
-- `number` from the billing.numberPadding setting. UNIQUE(year, seq)
-- stays as the backstop. Runs as the definer (postgres) so it can touch
-- counters/settings regardless of RLS.
create or replace function public.invoices_assign_number() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_padding int;
  v_next    int;
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_at := now();

  select coalesce((value ->> 'numberPadding')::int, 4) into v_padding
    from settings where key = 'billing';

  -- Explicit seq (imports, or numbers reserved via reserve_invoice_numbers):
  -- keep it, only re-anchor the counter so the next auto-assign never repeats.
  if new.seq is not null then
    insert into counters (year, next_seq) values (new.year, new.seq + 1)
      on conflict (year) do update set next_seq = greatest(counters.next_seq, excluded.next_seq);
    if new.number = '' then
      new.number := lpad(new.seq::text, v_padding, '0');
    end if;
    return new;
  end if;

  insert into counters (year, next_seq) values (new.year, 1)
    on conflict (year) do nothing;

  select next_seq into v_next from counters where year = new.year for update;

  select coalesce(max(seq), 0) + 1 into new.seq from invoices where year = new.year;
  new.seq := greatest(new.seq, v_next);

  update counters set next_seq = new.seq + 1 where year = new.year;

  new.number := lpad(new.seq::text, v_padding, '0');
  return new;
end $$;

drop trigger if exists trg_invoices_number on public.invoices;
create trigger trg_invoices_number
  before insert on public.invoices
  for each row execute function public.invoices_assign_number();

drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

/* ------------------------------------------------------------------ */
/* reserve_invoice_numbers — atomically reserve a batch of seqs for a   */
/* year so a device can keep numbering invoices while offline without  */
/* colliding with another device. Returns (seq, number) rows.          */
/* ------------------------------------------------------------------ */
create or replace function public.reserve_invoice_numbers(y integer, n integer)
returns table (seq integer, number text)
language plpgsql security definer set search_path = public as $$
declare
  v_padding int;
  v_start   int;
  v_count   int;
  v_cur     int;
begin
  if y is null or n is null or n < 1 or n > 1000 then
    raise exception 'reserve_invoice_numbers: invalid arguments';
  end if;

  select coalesce((value ->> 'numberPadding')::int, 4) into v_padding
    from settings where key = 'billing';

  insert into counters (year, next_seq) values (y, 1)
    on conflict (year) do nothing;

  select next_seq into v_start from counters where year = y for update;

  -- Re-anchor so already-issued numbers are never handed out twice.
  select coalesce(max(invoices.seq), 0) + 1 into v_cur
    from public.invoices where year = y;
  if v_cur > v_start then v_start := v_cur; end if;

  v_count := n;
  update counters set next_seq = v_start + v_count where year = y;

  for i in v_start .. v_start + v_count - 1 loop
    seq := i;
    number := lpad(i::text, v_padding, '0');
    return next;
  end loop;
end $$;

/* ------------------------------------------------------------------ */
/* RLS — permissive on `anon` because the app has no login.             */
/* Public data is guarded only by possession of the project URL + key.  */
/* ------------------------------------------------------------------ */
alter table public.profiles      enable row level security;
alter table public.settings      enable row level security;
alter table public.units         enable row level security;
alter table public.clients       enable row level security;
alter table public.invoices      enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.counters      enable row level security;

do $$ declare t text; begin
  foreach t in array array['profiles', 'settings', 'units', 'clients', 'invoices', 'invoice_lines'] loop
    execute format(
      'create policy "full_access" on public.%I for all using (true) with check (true)',
      t
    );
  end loop;
  -- counters: readable by clients (number preview), writeable only by the
  -- security-definer trigger / reserve function.
  execute 'create policy "counters_read" on public.counters for select using (true)';
end $$;

/* ------------------------------------------------------------------ */
/* Grants — explicit, because new Supabase projects are "secure by      */
/* default" and revoke the default anon/authenticated privileges.       */
/* ------------------------------------------------------------------ */
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
  on public.profiles, public.settings, public.units, public.clients,
     public.invoices, public.invoice_lines
  to anon, authenticated;
grant select on public.counters to anon, authenticated;
grant execute on function public.reserve_invoice_numbers(integer, integer)
  to anon, authenticated;
