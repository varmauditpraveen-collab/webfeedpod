-- Multi-user schema for MorninPod
-- Run this once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- Update timestamp helper
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- 1) Users (mapped from Google OAuth profile)
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  google_sub text not null unique,
  email text,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

-- 2) Feeds (per user)
create table if not exists public.feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  website_url text not null,
  feed_url text not null,
  title text default '',
  icon_url text default '',
  is_pinned boolean not null default false,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, website_url)
);

drop trigger if exists feeds_set_updated_at on public.feeds;
create trigger feeds_set_updated_at
before update on public.feeds
for each row execute function public.set_updated_at();

-- 3) Items (stories/articles) (per user)
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  feed_id uuid references public.feeds(id) on delete set null,

  feed_title text default '',
  title text not null,
  link text not null,
  description text default '',
  content text default '',
  image_url text default '',
  youtube_id text default '',
  pub_date timestamptz,
  podcast_date date not null,
  category text default '',

  script text default '',

  -- Backwards-compatible single-path (first chunk)
  tts_audio_path text default '',
  tts_duration_seconds double precision not null default 0,

  tts_voice text default '',
  tts_attempts integer not null default 0,
  tts_last_error text default '',
  tts_last_attempt_at timestamptz,

  -- Stitched-story reconstruction fields
  tts_story_intro_audio_path text default '',
  tts_story_intro_duration_seconds double precision not null default 0,
  tts_audio_paths text[] not null default '{}',
  tts_audio_durations_seconds double precision[] not null default '{}',

  is_read boolean not null default false,
  is_saved boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, link)
);

drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_updated_at();

-- 4) Podcast build cache (timeline) (per user)
create table if not exists public.podcasts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  podcast_date date not null,
  voice text default 'af_heart',
  timeline jsonb not null default '[]'::jsonb,
  total_duration_seconds double precision not null default 0,
  built_at timestamptz not null default now(),
  status text not null default 'pending',
  status_message text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, podcast_date)
);

drop trigger if exists podcasts_set_updated_at on public.podcasts;
create trigger podcasts_set_updated_at
before update on public.podcasts
for each row execute function public.set_updated_at();

-- 5) Playback progress (per user)
create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  podcast_date date not null,
  position_seconds double precision not null default 0,
  current_item_id uuid references public.items(id) on delete set null,
  last_skipped_from_item_id uuid references public.items(id) on delete set null,
  updated_at timestamptz not null default now(),

  unique (user_id, podcast_date)
);

-- 6) User settings (per user)
create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
before update on public.settings
for each row execute function public.set_updated_at();

-- 7) Analytics events (per user)
create table if not exists public.analytics_events (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  event_name text not null,
  event_properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_user_id_created_at_idx
on public.analytics_events (user_id, created_at desc);

