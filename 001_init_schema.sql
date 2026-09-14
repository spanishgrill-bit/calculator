-- ============================================================================
-- AUTO DEAL IQ (TM) — Initial Schema Migration
-- Target: PostgreSQL 14+ (Supabase-ready)
-- Companion doc: auto-deal-iq-schema-design.md
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------
create type user_role as enum ('admin', 'dealer_staff', 'customer');
create type vehicle_condition as enum ('new', 'used', 'cpo');
create type amount_type as enum ('flat', 'percent');
create type incentive_type as enum ('manufacturer_incentive', 'customer_rebate', 'dealer_cash');
create type data_entity_scope as enum ('vehicle_pricing', 'tax', 'apr', 'incentive', 'fee');
create type data_sync_method as enum ('api', 'csv_import', 'manual');
create type deal_status as enum ('draft', 'calculated', 'saved', 'shared');
create type deal_objective as enum (
  'lowest_payment', 'lowest_total_cost', 'lowest_cash', 'fastest_payoff', 'best_balance'
);

-- ----------------------------------------------------------------------------
-- LOOKUP / CATALOG TABLES
-- ----------------------------------------------------------------------------

create table vehicle_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true
);

create table manufacturers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table vehicle_models (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers(id),
  name text not null,
  default_category_id uuid references vehicle_categories(id),
  created_at timestamptz not null default now(),
  unique (manufacturer_id, name)
);

create table vehicle_model_years (
  id uuid primary key default gen_random_uuid(),
  vehicle_model_id uuid not null references vehicle_models(id),
  year int not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (vehicle_model_id, year)
);

create table vehicle_trims (
  id uuid primary key default gen_random_uuid(),
  vehicle_model_year_id uuid not null references vehicle_model_years(id),
  name text not null,
  body_style text,
  drivetrain text,
  fuel_type text,
  category_id uuid references vehicle_categories(id),
  created_at timestamptz not null default now(),
  unique (vehicle_model_year_id, name)
);

-- ----------------------------------------------------------------------------
-- DATA PROVENANCE
-- ----------------------------------------------------------------------------

create table data_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  entity_scope data_entity_scope not null,
  sync_method data_sync_method not null,
  url text,
  last_synced_at timestamptz
);

-- ----------------------------------------------------------------------------
-- PRICING / INCENTIVES
-- ----------------------------------------------------------------------------

create table vehicle_pricing (
  id uuid primary key default gen_random_uuid(),
  vehicle_trim_id uuid not null references vehicle_trims(id),
  condition vehicle_condition not null default 'new',
  msrp numeric(10,2) not null,
  destination_charge numeric(10,2) not null default 0,
  invoice_reference_price numeric(10,2),
  selling_price_reference numeric(10,2),
  effective_date date not null,
  expiration_date date,
  source_id uuid references data_sources(id),
  is_active boolean not null default true,
  deleted_at timestamptz,
  last_updated timestamptz not null default now()
);
create index idx_vehicle_pricing_trim_effective on vehicle_pricing (vehicle_trim_id, effective_date);

create table manual_vehicle_entries (
  id uuid primary key default gen_random_uuid(),
  year int not null,
  make text not null,
  model text not null,
  trim text,
  condition vehicle_condition not null,
  entered_price numeric(10,2) not null,
  notes text,
  created_by_user_id uuid, -- FK added after `users` table exists
  created_at timestamptz not null default now()
);

create table used_vehicle_listings (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid, -- FK added after `dealerships` table exists
  vehicle_trim_id uuid references vehicle_trims(id),
  vin text,
  year int not null,
  make text not null,
  model text not null,
  trim_name text,
  mileage int not null default 0,
  condition_grade text,
  is_cpo boolean not null default false,
  purchase_price numeric(10,2) not null,
  estimated_market_value numeric(10,2),
  warranty_description text,
  source_id uuid references data_sources(id),
  last_updated timestamptz not null default now()
);

create table incentives (
  id uuid primary key default gen_random_uuid(),
  vehicle_trim_id uuid references vehicle_trims(id),
  vehicle_model_id uuid references vehicle_models(id),
  manufacturer_id uuid references manufacturers(id),
  type incentive_type not null,
  name text not null,
  amount numeric(10,2) not null,
  amount_type amount_type not null default 'flat',
  stackable boolean not null default false,
  region_restriction text,
  effective_date date not null,
  expiration_date date,
  source_id uuid references data_sources(id),
  is_active boolean not null default true,
  deleted_at timestamptz,
  last_updated timestamptz not null default now()
);
create index idx_incentives_trim on incentives (vehicle_trim_id);
create index idx_incentives_model on incentives (vehicle_model_id);
create index idx_incentives_manufacturer on incentives (manufacturer_id);

-- ----------------------------------------------------------------------------
-- LOCATION & TAX ENGINE
-- ----------------------------------------------------------------------------

create table tax_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  zip_code text not null,
  state text not null,
  county text,
  city text,
  jurisdiction_name text
);
create index idx_tax_jurisdictions_zip on tax_jurisdictions (zip_code);

create table tax_rules (
  id uuid primary key default gen_random_uuid(),
  tax_jurisdiction_id uuid not null references tax_jurisdictions(id),
  tax_rate numeric(6,4) not null,
  taxable_categories jsonb not null default '[]',
  exempt_categories jsonb not null default '[]',
  effective_date date not null,
  expiration_date date,
  source_id uuid references data_sources(id),
  source_url text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  last_updated timestamptz not null default now()
);
create index idx_tax_rules_jurisdiction_effective on tax_rules (tax_jurisdiction_id, effective_date);

create table fee_rules (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid, -- FK added after `dealerships` table exists; null = global/government default
  name text not null,
  amount numeric(10,2) not null,
  amount_type amount_type not null default 'flat',
  is_taxable boolean not null default false,
  jurisdiction_id uuid references tax_jurisdictions(id),
  effective_date date not null,
  expiration_date date,
  is_active boolean not null default true,
  deleted_at timestamptz
);

-- ----------------------------------------------------------------------------
-- CREDIT / FINANCING RULES
-- ----------------------------------------------------------------------------

create table lenders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_info jsonb,
  is_active boolean not null default true,
  deleted_at timestamptz
);

create table credit_tiers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  score_min int,
  score_max int,
  sort_order int not null default 0,
  is_active boolean not null default true,
  deleted_at timestamptz
);

create table apr_rules (
  id uuid primary key default gen_random_uuid(),
  lender_id uuid not null references lenders(id),
  credit_tier_id uuid not null references credit_tiers(id),
  vehicle_condition vehicle_condition not null,
  term_months int not null,
  min_apr numeric(5,3) not null,
  max_apr numeric(5,3) not null,
  default_apr numeric(5,3) not null,
  effective_date date not null,
  expiration_date date,
  is_active boolean not null default true,
  deleted_at timestamptz
);
create index idx_apr_rules_lookup on apr_rules (lender_id, credit_tier_id, vehicle_condition, term_months, effective_date);

-- ----------------------------------------------------------------------------
-- DEALERSHIPS & USERS
-- ----------------------------------------------------------------------------

create table dealerships (
  id uuid primary key default gen_random_uuid(),
  parent_group_id uuid references dealerships(id),
  name text not null,
  logo_url text,
  zip_code text not null,
  city text,
  state text,
  default_settings jsonb not null default '{}',
  disclaimer_text text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid references dealerships(id),
  role user_role not null default 'customer',
  email text not null unique,
  password_hash text not null,
  name text,
  created_at timestamptz not null default now()
);

-- Back-fill FKs that depend on dealerships/users existing
alter table manual_vehicle_entries
  add constraint fk_manual_vehicle_entries_user foreign key (created_by_user_id) references users(id);

alter table used_vehicle_listings
  add constraint fk_used_vehicle_listings_dealership foreign key (dealership_id) references dealerships(id);

alter table fee_rules
  add constraint fk_fee_rules_dealership foreign key (dealership_id) references dealerships(id);

-- ----------------------------------------------------------------------------
-- DEALS
-- ----------------------------------------------------------------------------

create table deals (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid references dealerships(id),
  created_by_user_id uuid not null references users(id),
  customer_user_id uuid references users(id),

  vehicle_trim_id uuid references vehicle_trims(id),
  used_vehicle_listing_id uuid references used_vehicle_listings(id),
  manual_vehicle_entry_id uuid references manual_vehicle_entries(id),

  dealership_zip text not null,
  customer_registration_zip text not null,
  tax_jurisdiction_id uuid references tax_jurisdictions(id),

  selling_price numeric(10,2) not null,
  dealer_discount numeric(10,2) not null default 0,
  accessories_total numeric(10,2) not null default 0,
  applied_incentive_ids jsonb not null default '[]',
  net_vehicle_price numeric(10,2),

  has_trade boolean not null default false,
  down_payment numeric(10,2) not null default 0,
  cash_available numeric(10,2),

  credit_tier_id uuid references credit_tiers(id),
  apr_rule_id uuid references apr_rules(id),
  estimated_apr numeric(5,3),
  term_months int not null,
  target_payment numeric(10,2),

  status deal_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_exactly_one_vehicle_source check (
    (case when vehicle_trim_id is not null then 1 else 0 end) +
    (case when used_vehicle_listing_id is not null then 1 else 0 end) +
    (case when manual_vehicle_entry_id is not null then 1 else 0 end) = 1
  )
);
create index idx_deals_dealership on deals (dealership_id);
create index idx_deals_created_by on deals (created_by_user_id);

create table trades (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null unique references deals(id) on delete cascade,
  year int,
  make text,
  model text,
  trim text,
  mileage int,
  trade_value numeric(10,2) not null default 0,
  payoff numeric(10,2) not null default 0,
  private_party_value numeric(10,2),
  wholesale_value numeric(10,2),
  equity numeric(10,2) not null default 0
);

create table customer_preferences (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null unique references deals(id) on delete cascade,
  objective deal_objective not null default 'best_balance',
  max_cash_available numeric(10,2),
  notes jsonb
);

create table deal_scenarios (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  scenario_label text not null,
  vehicle_price numeric(10,2) not null,
  trade_equity numeric(10,2) not null default 0,
  down_payment numeric(10,2) not null default 0,
  amount_financed numeric(10,2) not null,
  apr numeric(5,3) not null,
  term_months int not null,
  monthly_payment numeric(10,2) not null,
  cash_required numeric(10,2) not null,
  total_interest numeric(10,2) not null,
  total_payments numeric(10,2) not null,
  total_cost numeric(10,2) not null,
  score numeric(6,3),
  is_recommended boolean not null default false,
  explanation_text text,
  created_at timestamptz not null default now()
);
create index idx_deal_scenarios_deal on deal_scenarios (deal_id);

create table saved_deals (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  user_id uuid not null references users(id),
  share_token text unique,
  share_expiration timestamptz,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- AUDIT
-- ----------------------------------------------------------------------------

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_entity on audit_logs (entity_type, entity_id);

-- ----------------------------------------------------------------------------
-- SEED: a starter set of vehicle categories so the dropdown isn't empty on day 1
-- ----------------------------------------------------------------------------
insert into vehicle_categories (name, sort_order) values
  ('Sedan', 1), ('Coupe', 2), ('Hatchback', 3), ('SUV', 4), ('Truck', 5),
  ('Minivan', 6), ('Van', 7), ('Hybrid', 8), ('Plug-in Hybrid', 9), ('EV', 10);
