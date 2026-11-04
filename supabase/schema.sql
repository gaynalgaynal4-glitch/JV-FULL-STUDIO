-- JV PostZen Publisher: run this entire file once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.app_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  postzen_profile_id text unique,
  profile_name text not null default 'My TikTok Workspace',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.oauth_attempts (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  postzen_profile_id text not null,
  platform text not null default 'tiktok',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  postzen_account_id text not null unique,
  postzen_profile_id text not null,
  platform text not null,
  username text,
  display_name text,
  status text,
  connected_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  postzen_post_id text,
  account_id text,
  platform text not null default 'tiktok',
  caption text not null default '',
  status text not null default 'submitted',
  publish_mode text not null,
  scheduled_for timestamptz,
  media_url text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists oauth_attempts_user_idx on public.oauth_attempts(user_id);
create index if not exists connected_accounts_user_idx on public.connected_accounts(user_id);
create index if not exists posts_user_created_idx on public.posts(user_id, created_at desc);

alter table public.app_profiles enable row level security;
alter table public.oauth_attempts enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.posts enable row level security;

-- The application server uses the Supabase secret/service key only on the server.
-- No direct browser policies are granted. All user-scoped access is enforced by server
-- routes after validating the Supabase access token and filtering by auth user id.
revoke all on public.app_profiles from anon, authenticated;
revoke all on public.oauth_attempts from anon, authenticated;
revoke all on public.connected_accounts from anon, authenticated;
revoke all on public.posts from anon, authenticated;

grant all on public.app_profiles to service_role;
grant all on public.oauth_attempts to service_role;
grant all on public.connected_accounts to service_role;
grant all on public.posts to service_role;
