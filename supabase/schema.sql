create extension if not exists vector;

create table if not exists card_scans (
  id bigint generated always as identity primary key,
  scan_id text not null unique,
  created_at timestamptz not null default now(),
  payload jsonb not null,
  embedding vector(768)
);

create index if not exists idx_card_scans_created_at on card_scans (created_at desc);

-- TODO: add ivfflat or hnsw indexes once CLIP/DINO embeddings are available.
-- TODO: split payload into normalized relational tables if scan volume grows.
