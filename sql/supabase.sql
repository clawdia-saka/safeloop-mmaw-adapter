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
  nonce_domain text,
  nonce integer,
  account_lock_scope text,
  global_collateral_lock_scope text,
  collateral_pool_id text,
  priority text not null default 'normal',
  lock_owner_id text,
  lock_epoch bigint,
  locked_until timestamptz,
  signature_expires_at timestamptz,
  in_flight_gas_usd numeric,
  reverted_gas_usd numeric,
  preemption_count integer not null default 0,
  last_preempted_at timestamptz,
  preemption_cancel_status text not null default 'not_required',
  preemption_cancel_tx_hash text,
  preemption_cancel_nonce integer,
  preemption_cancel_replaces_tx_hash text,
  preemption_cancel_submitted_at timestamptz,
  preemption_cancel_observed_at timestamptz,
  preemption_cancel_rpc_quorum integer,
  gas_reservation_status text not null default 'none',
  gas_reserved_usd numeric,
  gas_reservation_updated_at timestamptz,
  partial_fill_count integer not null default 0,
  last_partial_fill_at timestamptz,
  time_calibration_source text,
  time_calibration_synced_at timestamptz,
  time_calibration_round_trip_ms integer,
  time_calibration_max_volatility_bps integer,
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
  intent_id text not null references safeloop_action_ledger(intent_id)
    on delete cascade,
  lock_owner_id text not null,
  lock_epoch bigint,
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
  p_account_lock_scope text,
  p_global_collateral_lock_scope text,
  p_collateral_pool_id text,
  p_priority text,
  p_lock_owner_id text,
  p_wallet text,
  p_chain_id integer,
  p_action_type text,
  p_locked_until timestamptz,
  p_canonical_intent jsonb,
  p_nonce_domain text default null,
  p_nonce integer default null,
  p_lock_epoch bigint default null
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
    account_lock_scope,
    global_collateral_lock_scope,
    collateral_pool_id,
    priority,
    lock_owner_id,
    nonce_domain,
    nonce,
    lock_epoch,
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
    p_account_lock_scope,
    p_global_collateral_lock_scope,
    p_collateral_pool_id,
    coalesce(p_priority, 'normal'),
    p_lock_owner_id,
    p_nonce_domain,
    p_nonce,
    p_lock_epoch,
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
    lock_owner_id,
    lock_epoch,
    locked_until
  )
  values (
    p_lock_scope,
    p_intent_id,
    p_lock_owner_id,
    p_lock_epoch,
    p_locked_until
  );

  if p_account_lock_scope is not null then
    insert into safeloop_action_locks (
      lock_scope,
      intent_id,
      lock_owner_id,
      lock_epoch,
      locked_until
    )
    values (
      p_account_lock_scope,
      p_intent_id,
      p_lock_owner_id,
      p_lock_epoch,
      p_locked_until
    );
  end if;

  if p_global_collateral_lock_scope is not null then
    insert into safeloop_action_locks (
      lock_scope,
      intent_id,
      lock_owner_id,
      lock_epoch,
      locked_until
    )
    values (
      p_global_collateral_lock_scope,
      p_intent_id,
      p_lock_owner_id,
      p_lock_epoch,
      p_locked_until
    );
  end if;

  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create or replace function safeloop_verify_action_lock(
  p_intent_id text,
  p_lock_scope text,
  p_account_lock_scope text,
  p_global_collateral_lock_scope text,
  p_lock_owner_id text,
  p_lock_epoch bigint default null
)
returns boolean
language sql
as $$
  select exists (
    select 1
    from safeloop_action_locks
    where intent_id = p_intent_id
      and lock_scope = p_lock_scope
      and lock_owner_id = p_lock_owner_id
      and (p_lock_epoch is null or lock_epoch = p_lock_epoch)
      and locked_until > now()
  )
  and (
    p_account_lock_scope is null
    or exists (
      select 1
      from safeloop_action_locks
      where intent_id = p_intent_id
        and lock_scope = p_account_lock_scope
        and lock_owner_id = p_lock_owner_id
        and (p_lock_epoch is null or lock_epoch = p_lock_epoch)
        and locked_until > now()
    )
  )
  and (
    p_global_collateral_lock_scope is null
    or exists (
      select 1
      from safeloop_action_locks
      where intent_id = p_intent_id
        and lock_scope = p_global_collateral_lock_scope
        and lock_owner_id = p_lock_owner_id
        and (p_lock_epoch is null or lock_epoch = p_lock_epoch)
        and locked_until > now()
    )
  );
$$;

create or replace function safeloop_extend_action_lock(
  p_intent_id text,
  p_lock_owner_id text,
  p_locked_until timestamptz
)
returns boolean
language plpgsql
as $$
begin
  update safeloop_action_locks
  set locked_until = p_locked_until
  where intent_id = p_intent_id
    and lock_owner_id = p_lock_owner_id
    and locked_until > now();

  update safeloop_action_ledger
  set locked_until = p_locked_until
  where intent_id = p_intent_id
    and lock_owner_id = p_lock_owner_id;

  return found;
end;
$$;

create or replace function safeloop_mark_signature_expiry(
  p_intent_id text,
  p_signature_expires_at timestamptz
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set signature_expires_at = p_signature_expires_at
  where intent_id = p_intent_id;
$$;

create or replace function safeloop_mark_preemption_required(
  p_preempted_intent_id text
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set preemption_count = preemption_count + 1,
      last_preempted_at = now(),
      preemption_cancel_status = 'required'
  where intent_id = p_preempted_intent_id;
$$;

create or replace function safeloop_mark_preemption_cancel(
  p_intent_id text,
  p_cancel_status text,
  p_cancel_tx_hash text default null,
  p_cancel_nonce integer default null,
  p_cancel_replaces_tx_hash text default null,
  p_submitted_at timestamptz default null,
  p_observed_at timestamptz default null,
  p_rpc_quorum integer default null
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set preemption_cancel_status = p_cancel_status,
      preemption_cancel_tx_hash = p_cancel_tx_hash,
      preemption_cancel_nonce = p_cancel_nonce,
      preemption_cancel_replaces_tx_hash = p_cancel_replaces_tx_hash,
      preemption_cancel_submitted_at = p_submitted_at,
      preemption_cancel_observed_at = p_observed_at,
      preemption_cancel_rpc_quorum = p_rpc_quorum
  where intent_id = p_intent_id;
$$;

create or replace function safeloop_mark_gas_reservation(
  p_intent_id text,
  p_status text,
  p_reserved_usd numeric default null
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set gas_reservation_status = p_status,
      gas_reserved_usd = p_reserved_usd,
      gas_reservation_updated_at = now()
  where intent_id = p_intent_id;
$$;

create or replace function safeloop_mark_partial_fill(
  p_intent_id text
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set partial_fill_count = partial_fill_count + 1,
      last_partial_fill_at = now()
  where intent_id = p_intent_id;
$$;

create or replace function safeloop_mark_time_calibration(
  p_intent_id text,
  p_source text,
  p_synced_at timestamptz,
  p_round_trip_ms integer,
  p_max_volatility_bps integer default null
)
returns void
language sql
as $$
  update safeloop_action_ledger
  set time_calibration_source = p_source,
      time_calibration_synced_at = p_synced_at,
      time_calibration_round_trip_ms = p_round_trip_ms,
      time_calibration_max_volatility_bps = p_max_volatility_bps
  where intent_id = p_intent_id;
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
