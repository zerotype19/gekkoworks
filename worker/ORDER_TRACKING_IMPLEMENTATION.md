# Order Tracking System Implementation

## Overview

This document summarizes the implementation of the new order tracking system that makes Tradier the source of truth for order status, with explicit linkage between proposals → orders → trades.

## What Was Implemented

### 1. Database Schema Changes

**Migration File:** `worker/src/db/migration_add_orders_table.sql`

- Created `orders` table with:
  - `id`, `proposal_id`, `trade_id`, `client_order_id`, `tradier_order_id`
  - `side` ('ENTRY' | 'EXIT'), `status` ('PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED')
  - `avg_fill_price`, `filled_quantity`, `remaining_quantity`
  
- Updated `proposals` table with:
  - `kind` ('ENTRY' | 'EXIT')
  - `linked_trade_id` (for exit proposals)
  - `client_order_id` (the ID we send to Tradier)

### 2. Order Placement Updates

**Files Modified:**
- `worker/src/broker/tradierClient.ts` - Added `client_order_id` parameter support
- `worker/src/engine/entry.ts` - Generates `client_order_id` and creates order records for entry orders
- `worker/src/engine/exits.ts` - Creates exit proposals and order records for exit orders
- `worker/src/engine/orderHelpers.ts` - Helper functions for order management

**Key Changes:**
- Every order now gets a stable `client_order_id` (format: `gekkoworks-{proposalId}-{side}-{timestamp}`)
- Order records are created in the database BEFORE placing the order with Tradier
- Orders are linked to proposals and trades explicitly

### 3. Order Sync System

**New File:** `worker/src/engine/orderSyncNew.ts`

- `syncOrdersFromTradier()` - Polls Tradier for recent orders (last 2 days)
- Matches Tradier orders to our local orders by `client_order_id` or `tradier_order_id`
- Updates order status, fill prices, and quantities from Tradier
- `reconcileOrderWithTrade()` - Updates trade status based on order status:
  - ENTRY orders: Creates/updates trades when FILLED
  - EXIT orders: Closes trades when FILLED

**Integration:**
- Updated `worker/src/cron/monitorCycle.ts` to use the new sync system

### 4. Database Queries

**New File:** `worker/src/db/queries_orders.ts`

Functions:
- `insertOrder()`, `getOrder()`, `getOrderByClientOrderId()`, `getOrderByTradierOrderId()`
- `getOrdersByProposalId()`, `getOrdersByTradeId()`, `updateOrder()`, `getRecentOrders()`

**Updated:** `worker/src/db/queries.ts`
- Added `updateProposal()` function for updating proposal fields
- Updated `insertProposal()` to include new fields (`kind`, `linked_trade_id`, `client_order_id`)

### 5. API Updates

**Updated:** `worker/src/http/proposalsAndOrders.ts`

- Now queries the `orders` table to get real order status from Tradier
- Returns new fields:
  - `proposalKind`: 'ENTRY' | 'EXIT'
  - `order`: Order status, side, fill price, Tradier order ID, client order ID
  - `lifecycleStatus`: Human-readable status (e.g., "Entry filled – trade OPEN")

### 6. Frontend Updates

**Updated:** `web/src/pages/ProposalsAndOrders.tsx` and `web/src/api.ts`

- Added "Type" column showing ENTRY/EXIT badge
- Updated "Order Status" column to show real order status from Tradier
- Added order details in expanded view showing:
  - Order side (ENTRY/EXIT)
  - Order status (FILLED, CANCELLED, etc.)
  - Fill price
  - Tradier order ID
  - Lifecycle status

### 7. Type Definitions

**Updated:** `worker/src/types.ts`

- Added `OrderRow`, `OrderStatus`, `OrderSide`, `ProposalKind` types
- Added `MonitoringMetrics`, `ExitTriggerType` types
- Updated `MonitoringDecision` to include `metrics`
- Added `EntryAttemptResult`, `ExitExecutionResult` types
- Updated `BrokerOrder` to include `client_order_id` and `tag`

## What Still Needs to Be Done

### 1. Run Database Migration

The migration file `worker/src/db/migration_add_orders_table.sql` needs to be run on the D1 database:

```sql
-- Run this migration on your D1 database
-- See worker/src/db/migration_add_orders_table.sql
```

### 2. Backfill Existing Orders

Existing trades that have `broker_order_id_open` or `broker_order_id_close` should be backfilled into the `orders` table. This can be done via a script or manually.

### 3. Testing

- Test entry order creation and tracking
- Test exit order creation and tracking
- Test order sync from Tradier
- Test trade reconciliation when orders fill
- Verify UI displays correct information

### 4. Optional: Debug Orders Page

As requested, a debug page showing Tradier orders and their mapping to local orders/trades/proposals would be useful. This can be added later.

## Key Benefits

1. **Tradier as Source of Truth**: Order status comes directly from Tradier via polling, not from webhooks
2. **Explicit Linkage**: Clear proposal → order → trade relationships via `client_order_id`
3. **Accurate UI**: Frontend shows real order status, not inferred status
4. **Entry/Exit Distinction**: Clear separation between entry and exit proposals/orders
5. **Better Debugging**: Can trace any order through the entire lifecycle

## Migration Path

1. Run the database migration
2. Deploy the code changes
3. New orders will automatically be tracked
4. Existing orders can be backfilled later (optional)

## Notes

- The old `orderSync.ts` is still present but `monitorCycle` now uses `orderSyncNew.ts`
- Backward compatibility is maintained - trades still have `broker_order_id_open` and `broker_order_id_close`
- The `orders` table is the new source of truth, but we keep the old fields for compatibility

