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
  locked_until timestamptz,
  canonical_intent jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists safeloop_action_ledger_idempotency_key_uidx
  on safeloop_action_ledger (idempotency_key);

drop index if exists safeloop_action_ledger_active_lock_scope_uidx;

create index if not exists safeloop_action_ledger_wallet_chain_idx
  on safeloop_action_ledger (wallet, chain_id, created_at desc);

create table if not exists safeloop_action_locks (
  lock_scope text primary key,
  intent_id text not null unique references safeloop_action_ledger(intent_id)
    on delete cascade,
  locked_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists safeloop_action_locks_expiry_idx
  on safeloop_action_locks (locked_until);

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

drop trigger if exists safeloop_action_locks_touch_updated_at
  on safeloop_action_locks;

create trigger safeloop_action_locks_touch_updated_at
before update on safeloop_action_locks
for each row
execute function safeloop_touch_updated_at();

create or replace function safeloop_try_lock_action(
  p_intent_id text,
  p_idempotency_key text,
  p_lock_scope text,
  p_wallet text,
  p_chain_id integer,
  p_action_type text,
  p_locked_until timestamptz,
  p_canonical_intent jsonb
)
returns boolean
language plpgsql
as $$
begin
  delete from safeloop_action_locks
  where locked_until <= now();

  insert into safeloop_action_ledger (
    intent_id,
    idempotency_key,
    lock_scope,
    wallet,
    chain_id,
    action_type,
    status,
    locked_until,
    canonical_intent
  )
  values (
    p_intent_id,
    p_idempotency_key,
    p_lock_scope,
    p_wallet,
    p_chain_id,
    p_action_type,
    'LOCKED',
    p_locked_until,
    p_canonical_intent
  );

  insert into safeloop_action_locks (
    lock_scope,
    intent_id,
    locked_until
  )
  values (
    p_lock_scope,
    p_intent_id,
    p_locked_until
  );

  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create or replace function safeloop_release_action_lock(p_intent_id text)
returns void
language sql
as $$
  delete from safeloop_action_locks
  where intent_id = p_intent_id;
$$;

create or replace function safeloop_release_terminal_lock()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('ABORTED', 'SIGN_FAILED', 'REVERTED', 'TIMED_OUT', 'CONFIRMED') then
    delete from safeloop_action_locks
    where intent_id = new.intent_id;
  end if;

  return new;
end;
$$;

drop trigger if exists safeloop_action_ledger_release_terminal_lock
  on safeloop_action_ledger;

create trigger safeloop_action_ledger_release_terminal_lock
after update of status on safeloop_action_ledger
for each row
execute function safeloop_release_terminal_lock();
