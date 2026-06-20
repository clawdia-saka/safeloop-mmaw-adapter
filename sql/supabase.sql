-- Settlement Watcher Database Schema

-- Extend existing action_ledger or similar table with new tracking fields
ALTER TABLE action_ledger 
ADD COLUMN IF NOT EXISTS settlement_confirmation_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS watcher_id TEXT,
ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS lock_extension_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS partial_filled_size NUMERIC,
ADD COLUMN IF NOT EXISTS remaining_size NUMERIC,
ADD COLUMN IF NOT EXISTS gas_burned_usd NUMERIC;

-- Helper to update reverted gas burn
CREATE OR REPLACE FUNCTION update_reverted_gas_burn(
  p_intent_id TEXT,
  p_gas_burned_usd NUMERIC
) RETURNS VOID AS $$
BEGIN
  UPDATE action_ledger
  SET 
    gas_burned_usd = p_gas_burned_usd,
    status = 'REVERTED',
    updated_at = NOW()
  WHERE intent_id = p_intent_id;
END;
$$ LANGUAGE plpgsql;

-- Helper for heartbeat updates
CREATE OR REPLACE FUNCTION update_watcher_heartbeat(
  p_watcher_id TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE action_ledger
  SET 
    heartbeat_at = NOW()
  WHERE watcher_id = p_watcher_id;
END;
$$ LANGUAGE plpgsql;
