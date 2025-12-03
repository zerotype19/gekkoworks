# Tradier Sync Topology

## Current Architecture (Before Master Sync Refactor)

### Sync Functions

1. **`syncPortfolioFromTradier`** (`engine/portfolioSync.ts`)
   - **Tradier Endpoint**: `GET /v1/accounts/{account}/positions`
   - **D1 Table**: `portfolio_positions`
   - **What it does**: 
     - Fetches all positions from Tradier
     - Parses option symbols to extract underlying, expiration, strike, type
     - Groups positions into spreads
     - Upserts positions into `portfolio_positions` table
     - Deletes positions not in Tradier response
   - **Callers**:
     - `runMonitorCycle` (every 1 minute during market hours)
     - `runTradeCycle` (every 15 minutes during market hours)
     - `runAccountSync` (dedicated sync cron)
     - `handleAlreadyFlat` (in exits.ts, after detecting flat position)
     - `handleTestPortfolioSync` (debug endpoint)
     - `handleDebugForcePortfolioSync` (debug endpoint)
     - `handleDebugPortfolioSync` (debug endpoint)
     - `handleDebugTradeCycleStatus` (debug endpoint)
     - `handleDebugCleanupStalePositions` (debug endpoint)

2. **`syncOrdersFromTradier`** (`engine/orderSync.ts`) - OLD
   - **Tradier Endpoint**: `GET /v1/accounts/{account}/orders` (all orders)
   - **D1 Table**: `orders`
   - **What it does**: 
     - Fetches all orders from Tradier
     - Updates order status in `orders` table
     - Detects orphaned orders
   - **Callers**:
     - `runTradeCycle` (with `suppressOrphanedLogs: true`)
     - `handleTestOrderSync` (debug endpoint)
     - `handleDebugSyncPendingOrders` (debug endpoint)

3. **`syncOrdersFromTradierNew`** (`engine/orderSyncNew.ts`) - NEW
   - **Tradier Endpoint**: `GET /v1/accounts/{account}/orders` (all orders)
   - **D1 Table**: `orders`
   - **What it does**:
     - Fetches all orders from Tradier
     - Updates order status by `client_order_id`
     - Reconciles orders with trades (updates trade status)
     - More robust than old version
   - **Callers**:
     - `runMonitorCycle` (primary order sync)

4. **`syncBalancesFromTradier`** (`engine/balancesSync.ts`)
   - **Tradier Endpoint**: `GET /v1/accounts/{account}/balances`
   - **D1 Table**: None (just returns balances, updates sync timestamp in settings)
   - **What it does**:
     - Fetches balances from Tradier
     - Updates sync freshness timestamp
     - Returns balances (not stored in dedicated table)
   - **Callers**:
     - `runMonitorCycle`
     - `runTradeCycle`
     - `runAccountSync`
     - `handleAlreadyFlat` (in exits.ts)
     - `handleDailySummary` (for daily summaries)

### Sync Call Patterns

**Monitor Cycle** (`runMonitorCycle`):
```
syncPortfolioFromTradier()
syncOrdersFromTradierNew()
syncBalancesFromTradier()
```

**Trade Cycle** (`runTradeCycle`):
```
syncPortfolioFromTradier()
syncOrdersFromTradier(env, { suppressOrphanedLogs: true })
syncBalancesFromTradier()
```

**Account Sync** (`runAccountSync`):
```
syncPortfolioFromTradier()
syncOrdersFromTradier(env, { suppressOrphanedLogs: true })
syncBalancesFromTradier()
```

**After Entry** (`attemptEntryForLatestProposal`):
```
syncPortfolioFromTradier()
syncOrdersFromTradier()
syncBalancesFromTradier()
```

**After Exit** (`handleAlreadyFlat` in exits.ts):
```
syncPortfolioFromTradier()
syncOrdersFromTradier()
syncBalancesFromTradier()
```

### Issues with Current Architecture

1. **No Snapshot Tracking**: Each sync is independent, no way to correlate what was synced together
2. **Multiple Sync Functions**: Different functions for different resources, called separately
3. **No Atomicity**: Syncs can partially fail, leaving inconsistent state
4. **Duplicate API Calls**: Same Tradier endpoints called multiple times in different places
5. **No Consistency Checks**: No way to verify D1 matches Tradier
6. **Balances Not Stored**: Balances are fetched but not stored in a table for historical tracking

### Target Architecture (After Master Sync)

**Single Master Sync Function**:
```
syncTradierSnapshot(accountId)
  → Fetches account, balances, positions, orders in parallel
  → Writes all to D1 with shared snapshotId
  → Returns normalized snapshot
```

**All Callers Use Master Sync**:
- Monitor cycle: `syncTradierSnapshot()` once at start
- Trade cycle: `syncTradierSnapshot()` once at start
- After order placement: `syncTradierSnapshot()` immediately
- Debug endpoints: `syncTradierSnapshot()` on demand

