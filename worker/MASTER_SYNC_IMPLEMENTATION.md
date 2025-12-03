# Master Tradier Sync Implementation

## Summary

Implemented a single **master Tradier sync** function (`syncTradierSnapshot`) that orchestrates all Tradier data synchronization into D1 in a coherent snapshot. This replaces the previous ad-hoc sync functions (`syncPortfolioFromTradier`, `syncOrdersFromTradier`, `syncBalancesFromTradier`) with a unified approach.

## What Was Implemented

### 1. Master Sync Function (`src/tradier/syncTradierSnapshot.ts`)

- **Single orchestrator** that fetches account, balances, positions, and orders from Tradier
- **Snapshot tracking** with `snapshotId` (UUID) and `asOf` timestamp
- **Atomic writes** to D1 with shared snapshot ID across all resources
- **Comprehensive error handling** with warnings for non-fatal issues
- **Order reconciliation** integrated (creates/updates trades when orders fill)

### 2. Database Schema Updates

**New Tables:**
- `tradier_snapshots` - Tracks each sync operation
- `account_balances` - Stores balance snapshots (historical tracking)

**Updated Tables:**
- `portfolio_positions` - Added `snapshot_id` column
- `orders` - Added `snapshot_id` column

**Migration:** `src/db/migration_add_snapshot_tracking.sql`

### 3. Updated Callers

**Monitor Cycle** (`src/cron/monitorCycle.ts`):
- Replaced three separate sync calls with single `syncTradierSnapshot()` call
- Improved logging with snapshot ID tracking

**Other Callers** (to be updated in future):
- `runTradeCycle` - Still uses old syncs (can be updated later)
- `runAccountSync` - Still uses old syncs (can be updated later)
- `attemptEntryForLatestProposal` - Still uses old syncs (can be updated later)
- Various debug endpoints - Still use old syncs (can be updated later)

### 4. Debug Endpoint

**`GET /debug/tradier/snapshot`**:
- `?sync=true` - Triggers a new sync and returns the result
- Without query param - Returns latest snapshot from D1
- Includes consistency checks (positions/orders counts match)

## Benefits

1. **Coherent Snapshots**: All positions, orders, and balances are synced together with a shared `snapshotId`
2. **Better Debugging**: Can answer "At time T, what did Tradier think vs what does D1 think?"
3. **Reduced API Calls**: Single sync function reduces duplicate Tradier API calls
4. **Historical Tracking**: Balance snapshots stored for historical analysis
5. **Consistency Checks**: Debug endpoint shows if D1 matches Tradier counts

## Migration Status

**⚠️ IMPORTANT**: The database migration (`migration_add_snapshot_tracking.sql`) needs to be run manually on the remote D1 database. The migration:

1. Creates `tradier_snapshots` table
2. Creates `account_balances` table
3. Adds `snapshot_id` column to `portfolio_positions` (nullable)
4. Adds `snapshot_id` column to `orders` (nullable)

**To run the migration:**
```bash
npx wrangler d1 execute gekkoworks_db --remote --file=src/db/migration_add_snapshot_tracking.sql
```

**Note**: The migration uses `ALTER TABLE` with nullable columns, so it's safe to run even if columns already exist (SQLite will ignore duplicate ALTER TABLE statements).

## Next Steps

1. **Run the migration** on remote D1 database
2. **Update remaining callers** to use `syncTradierSnapshot`:
   - `runTradeCycle`
   - `runAccountSync`
   - `attemptEntryForLatestProposal`
   - Debug endpoints
3. **Add consistency checks** as a cron job or monitoring alert
4. **Deprecate old sync functions** once all callers are migrated

## Testing

1. **Trigger a sync**: `GET /debug/tradier/snapshot?sync=true`
2. **View latest snapshot**: `GET /debug/tradier/snapshot`
3. **Monitor logs**: Look for `[tradier_sync:start]`, `[tradier_sync:counts]`, `[tradier_sync:done]` log entries
4. **Check consistency**: Verify positions/orders counts match between Tradier and D1

## Logging

The master sync logs structured events:
- `[tradier_sync:start]` - Sync started with snapshotId
- `[tradier_sync:counts]` - Counts of positions/orders fetched
- `[tradier_sync:done]` - Sync completed with summary
- `[tradier_sync:error]` - Sync failed with error details

