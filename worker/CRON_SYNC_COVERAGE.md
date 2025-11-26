# Cron Sync Coverage

This document tracks which sync functions are called by each recurring cron job.

## Sync Functions

1. **`syncPortfolioFromTradier()`** - Syncs positions from Tradier → D1, updates positions sync freshness timestamp
2. **`syncOrdersFromTradier()`** - Syncs orders from Tradier → D1, updates orders sync freshness timestamp  
3. **`syncBalancesFromTradier()`** - Syncs balances from Tradier → D1, updates balances sync freshness timestamp

---

## Cron Jobs & Sync Coverage

### 1. Monitor Cycle (`1-59/1 14-20 * * MON-FRI`)
**Frequency:** Every 1 minute during market hours (9:30-15:59 ET)

**Syncs:**
- ✅ `syncPortfolioFromTradier()` - Positions
- ✅ `syncOrdersFromTradier()` - Orders
- ✅ `syncBalancesFromTradier()` - Balances

**Status:** ✅ **COMPLETE** - All three syncs called

---

### 2. Trade Cycle (`30-59 14 * * MON-FRI`, `*/1 15-20 * * MON-FRI`, `0 21 * * MON-FRI`)
**Frequency:** Every 1 minute during market hours (9:30-16:00 ET)

**Syncs:**
- ✅ `syncPortfolioFromTradier()` - Positions
- ✅ `syncOrdersFromTradier()` - Orders
- ✅ `syncBalancesFromTradier()` - Balances

**Status:** ✅ **COMPLETE** - All three syncs called

---

### 3. Account Sync (`*/1 14-21 * * MON-FRI`)
**Frequency:** Every 1 minute during market hours (9:00-16:59 ET) (updated 2025-11-24)

**Syncs:**
- ✅ `syncPortfolioFromTradier()` - Positions
- ✅ `syncOrdersFromTradier()` - Orders
- ✅ `syncBalancesFromTradier()` - Balances

**Status:** ✅ **COMPLETE** - All three syncs called, runs every 1 minute

---

### 4. Premarket Check (`0 13 * * MON-FRI`)
**Frequency:** Once per day at 8:00 ET (before market open)

**Syncs:**
- ❌ `syncPortfolioFromTradier()` - Positions (NOT called)
- ❌ `syncOrdersFromTradier()` - Orders (NOT called)
- ✅ `syncBalancesFromTradier()` - Balances

**Status:** ⚠️ **PARTIAL** - Only balances synced (acceptable since it runs once per day)

---

## Summary

### During Market Hours (9:00-16:59 ET):
- **Every 1 minute:** Monitor cycle + Trade cycle + Account sync all sync all three (positions, orders, balances)

### Result:
- **Positions sync:** Updated every 1 minute (via monitor/trade/account cycles)
- **Orders sync:** Updated every 1 minute (via monitor/trade/account cycles)
- **Balances sync:** Updated every 1 minute (via monitor/trade/account cycles)

**Note:** Account sync now runs every 1 minute (updated 2025-11-24) to prevent stale syncs and ensure readiness check always passes during market hours.

### Sync Freshness:
All sync freshness timestamps are updated automatically during market hours. Syncs are considered "fresh" if < 120 seconds old.

---

**Last Updated:** 2025-11-24  
**Status:** ✅ All recurring crons now sync positions, orders, and balances

