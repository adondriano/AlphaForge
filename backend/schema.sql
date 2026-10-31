-- =============================================================================
--  AlphaForge — Supabase schema
--  AI-Powered Quantitative Strategy Studio & Prop-Firm Execution Engine
--
--  Apply with:  psql "$DATABASE_URL" -f backend/schema.sql
--          or:  supabase db execute --file backend/schema.sql
--          or:  paste into the Supabase SQL Editor.
--
--  Tables: strategies | optimizations | trade_logs | app_settings
--  Realtime: all four tables are added to the supabase_realtime publication so
--            the Next.js dashboard streams trade execution + metric updates.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- strategies — one row per trading strategy (the "repo" in Git-for-Strategies)
-- -----------------------------------------------------------------------------
create table if not exists public.strategies (
  id                    uuid primary key default gen_random_uuid(),
  name                  text        not null,
  symbol                text        not null default 'XAUUSD',
  timeframe             text        not null default 'H1',
  source_type           text        not null default 'text'
                        check (source_type in ('youtube', 'tiktok', 'text', 'json', 'manual')),
  source_url            text,
  description           text        not null default '',
  -- machine readable form of the TradingView / video / prose strategy
  rules                 jsonb       not null default '{}'::jsonb,
  -- live (active) parameters, mirrored from the active optimizations row
  parameters            jsonb       not null default '{}'::jsonb,
  risk_profile          jsonb       not null default '{}'::jsonb,
  status                text        not null default 'draft'
                        check (status in ('draft','backtested','optimized','shadow','paper','live','halted')),
  autonomous            boolean     not null default false,
  -- paper trading runs the strategy against the shield without sending orders
  paper_trading         boolean     not null default false,
  -- owning account (Supabase Auth). NULL rows are legacy / unowned and are
  -- readable by everybody but editable by nobody.
  user_id               uuid        references auth.users(id) on delete cascade,
  -- aggregate metrics (kept denormalised so the dashboard is a single read)
  win_rate              numeric(7,4)  not null default 0,
  total_trades          integer       not null default 0,
  net_return_pct        numeric(12,4) not null default 0,
  max_drawdown_pct      numeric(12,4) not null default 0,
  profit_factor         numeric(12,4) not null default 0,
  sharpe                numeric(12,4) not null default 0,
  expectancy_r          numeric(12,4) not null default 0,
  prop_readiness        numeric(6,2)  not null default 0,
  est_trades_per_week   numeric(10,2) not null default 0,
  active_optimization_id uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists strategies_status_idx      on public.strategies (status);
create index if not exists strategies_created_at_idx  on public.strategies (created_at desc);

-- -----------------------------------------------------------------------------
-- optimizations — immutable parameter versions ("commits")
-- -----------------------------------------------------------------------------
create table if not exists public.optimizations (
  id             uuid primary key default gen_random_uuid(),
  strategy_id    uuid        not null references public.strategies(id) on delete cascade,
  version        integer     not null,
  label          text,
  engine         text        not null default 'optuna',  -- optuna | random | manual | llm
  parameters     jsonb       not null default '{}'::jsonb,
  param_bounds   jsonb       not null default '{}'::jsonb,
  metrics        jsonb       not null default '{}'::jsonb,
  n_trials       integer     not null default 0,
  direction      text        not null default 'maximize',
  objective_name text        not null default 'sharpe',
  is_active      boolean     not null default false,
  is_baseline    boolean     not null default false,
  notes          text        not null default '',
  user_id        uuid        references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint optimizations_strategy_version_key unique (strategy_id, version)
);

create index if not exists optimizations_strategy_idx  on public.optimizations (strategy_id, version desc);
create index if not exists optimizations_active_idx     on public.optimizations (strategy_id) where is_active;

-- only one active version per strategy
create unique index if not exists optimizations_one_active_idx
  on public.optimizations (strategy_id) where is_active;

alter table public.strategies
  drop constraint if exists strategies_active_optimization_id_fkey;
alter table public.strategies
  add constraint strategies_active_optimization_id_fkey
  foreign key (active_optimization_id) references public.optimizations(id) on delete set null;

-- -----------------------------------------------------------------------------
-- trade_logs — shadow / paper / live executions (realtime stream source)
-- -----------------------------------------------------------------------------
create table if not exists public.trade_logs (
  id               uuid primary key default gen_random_uuid(),
  strategy_id      uuid        not null references public.strategies(id) on delete cascade,
  optimization_id  uuid        references public.optimizations(id) on delete set null,
  mode             text        not null default 'paper'
                   check (mode in ('shadow','paper','live')),
  symbol           text        not null,
  side             text        not null check (side in ('buy','sell')),
  entry_price      numeric(18,6) not null default 0,
  exit_price       numeric(18,6),
  stop_loss        numeric(18,6),
  take_profit      numeric(18,6),
  volume           numeric(18,6) not null default 0.01,
  pnl              numeric(18,4),
  pnl_pct          numeric(12,4),
  r_multiple       numeric(12,4),
  -- Prop-Firm Shield audit trail
  day_pnl_pct      numeric(12,4) not null default 0,
  total_pnl_pct    numeric(12,4) not null default 0,
  equity_after     numeric(18,4),
  status           text        not null default 'open'
                   check (status in ('open','closed','blocked')),
  blocked_reason   text,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  user_id          uuid        references auth.users(id) on delete cascade,
  meta             jsonb       not null default '{}'::jsonb
);

create index if not exists trade_logs_strategy_idx  on public.trade_logs (strategy_id, opened_at desc);
create index if not exists trade_logs_opened_idx    on public.trade_logs (opened_at desc);

-- -----------------------------------------------------------------------------
-- app_settings — single-row settings document (Settings tab persistence)
-- -----------------------------------------------------------------------------
create table if not exists public.app_settings (
  id          text primary key default 'default',
  settings    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

insert into public.app_settings (id, settings)
values ('default', '{}'::jsonb)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- triggers
-- -----------------------------------------------------------------------------
drop trigger if exists strategies_set_updated_at on public.strategies;
create trigger strategies_set_updated_at
  before update on public.strategies
  for each row execute function public.set_updated_at();

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Forward migration for databases created before multi-user support.
-- (The create table statements above already carry these columns; these ALTERs
--  bring an existing database up to date and are no-ops otherwise.)
-- -----------------------------------------------------------------------------
alter table public.strategies    add column if not exists user_id       uuid references auth.users(id) on delete cascade;
alter table public.strategies    add column if not exists paper_trading boolean not null default false;
alter table public.optimizations add column if not exists user_id       uuid references auth.users(id) on delete cascade;
alter table public.trade_logs    add column if not exists user_id       uuid references auth.users(id) on delete cascade;

create index if not exists strategies_user_idx    on public.strategies (user_id);
create index if not exists optimizations_user_idx on public.optimizations (user_id);
create index if not exists trade_logs_user_idx    on public.trade_logs (user_id);

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- Sharing model:
--   * anyone (anonymous visitors included) may READ every strategy, parameter
--     version and trade — AlphaForge is meant to be shared as a public studio;
--   * only the signed-in owner may INSERT / UPDATE / DELETE their rows;
--   * app_settings is server-only. It holds the Supabase service-role key and
--     the MT5 password, so no anon/authenticated policy exists at all — the
--     default is deny and only service_role (which bypasses RLS) can touch it.
-- -----------------------------------------------------------------------------
alter table public.strategies    enable row level security;
alter table public.optimizations enable row level security;
alter table public.trade_logs    enable row level security;
alter table public.app_settings  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['strategies','optimizations','trade_logs'] loop
    -- retire the old single-tenant policy
    execute format('drop policy if exists alphaforge_full_access_%1$s on public.%1$I', t);

    execute format('drop policy if exists alphaforge_public_read_%1$s on public.%1$I', t);
    execute format(
      'create policy alphaforge_public_read_%1$s on public.%1$I '
      'for select to anon, authenticated using (true)', t);

    execute format('drop policy if exists alphaforge_owner_insert_%1$s on public.%1$I', t);
    execute format(
      'create policy alphaforge_owner_insert_%1$s on public.%1$I '
      'for insert to authenticated with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists alphaforge_owner_update_%1$s on public.%1$I', t);
    execute format(
      'create policy alphaforge_owner_update_%1$s on public.%1$I '
      'for update to authenticated using (auth.uid() = user_id) '
      'with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists alphaforge_owner_delete_%1$s on public.%1$I', t);
    execute format(
      'create policy alphaforge_owner_delete_%1$s on public.%1$I '
      'for delete to authenticated using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- app_settings holds secrets: no anon/authenticated policy => deny by default.
drop policy if exists alphaforge_full_access_app_settings on public.app_settings;

-- -----------------------------------------------------------------------------
-- Realtime publication — powers the live dashboard + trade ticker
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['strategies','optimizations','trade_logs','app_settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    -- REPLICA IDENTITY FULL so DELETE + UPDATE payloads carry the full old row
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;
