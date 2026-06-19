create table if not exists safeloop_action_ledger (
  intent_id text primary key,
  idempotency_key text not null,
  lock_scope text not null,
  wallet text not null,
  chain_id integer not null,
  action_type text not null,
  status text not null,
  reason_codes text[] not null default '{}',
  quote_id text,
  polling_id text,
  tx_hash text,
  canonical_intent jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists safeloop_action_ledger_idempotency_key_uidx
  on safeloop_action_ledger (idempotency_key);

create unique index if not exists safeloop_action_ledger_active_lock_scope_uidx
  on safeloop_action_ledger (lock_scope)
  where status in (
    'LOCKED',
    'SIMULATED',
    'APPROVED_FOR_SIGNING',
    'SIGNED',
    'REQUEST_PENDING',
    'REQUEST_WATCH_REQUIRED',
    'AWAITING_HUMAN_APPROVAL',
    'SUBMITTED',
    'BROADCASTING',
    'LANDED',
    'VENUE_RECONCILED'
  );

create index if not exists safeloop_action_ledger_wallet_chain_idx
  on safeloop_action_ledger (wallet, chain_id, created_at desc);

create or replace function safeloop_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists safeloop_action_ledger_touch_updated_at
  on safeloop_action_ledger;

create trigger safeloop_action_ledger_touch_updated_at
before update on safeloop_action_ledger
for each row
execute function safeloop_touch_updated_at();

