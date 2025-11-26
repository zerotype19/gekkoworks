# Cron Fresh Data Verification

**Date:** 2025-11-25  
**Status:** ✅ **ALL CRONS USE FRESH DATA - NEVER OUT OF SYNC**

## Summary

All crons that handle open/close/exit operations **sync fresh data from Tradier FIRST** before any operations. If syncs fail, the cycle **ABORTS** (no stale data used). All market data operations use **fresh API calls**, never D1.

---

## ✅ 1. Trade Cycle Cron (Entry/Open Operations)

**Cron Schedule:** Every 1 minute during market hours  
**File:** `src/cron/tradeCycle.ts`

### Data Flow:

1. **Step 0: MANDATORY Sync from Tradier** (lines 26-66)
   ```typescript
   // All three syncs must succeed or we abort the cycle
   positionsSyncResult = await syncPortfolioFromTradier(env);
   ordersSyncResult = await syncOrdersFromTradier(env);
   balancesSyncResult = await syncBalancesFromTradier(env);
   
   // If ANY sync fails → ABORT (line 65)
   return; // Abort - cannot proceed without fresh Tradier data
   ```

2. **Step 3: Get Open Trades** (line 87)
   - ✅ `getOpenTrades(env)` - **Only used for COUNTING** (risk limits)
   - ✅ **NOT used for market data** - just to count how many trades are open

3. **Step 4: Generate Proposal** (line 100)
   - ✅ **Fresh API calls:** `broker.getUnderlyingQuote()`, `broker.getOptionChain()`
   - ✅ **No D1 reads for market data**

4. **Step 5: Attempt Entry** (line 116)
   - ✅ **Fresh API calls:** `checkPriceDrift()` re-fetches chain/quotes
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Sync is MANDATORY** - cycle aborts if sync fails
- ✅ **All market data from fresh API calls**
- ✅ **D1 only used for counting trades** (not market data)

---

## ✅ 2. Monitor Cycle Cron (Exit/Close Operations)

**Cron Schedule:** Every 1 minute during market hours (offset by 30s)  
**File:** `src/cron/monitorCycle.ts`

### Data Flow:

1. **Step 0: MANDATORY Sync from Tradier** (lines 37-83)
   ```typescript
   // All three syncs must succeed or we abort the cycle
   positionsSyncResult = await syncPortfolioFromTradier(env);
   ordersSyncResult = await syncOrdersFromTradier(env);
   balancesSyncResult = await syncBalancesFromTradier(env);
   
   // If ANY sync fails → ABORT (line 82)
   return; // Abort - cannot proceed without fresh Tradier data
   ```

2. **Step 2: Get Open Trades** (line 99)
   - ✅ `getOpenTrades(env)` - **Only used to get LIST of trades to monitor**
   - ✅ **NOT used for market data** - just to know which trades exist

3. **Step 3: Check Pending Entries** (line 114)
   - ✅ `checkPendingEntries()` uses **fresh API:** `broker.getOrder()`
   - ✅ **No D1 reads for market data**

4. **Step 4: Check Pending Exits** (line 117)
   - ✅ `checkPendingExits()` uses **fresh API:** `broker.getOrder()`
   - ✅ **No D1 reads for market data**

5. **Step 5: Monitor Open Trades** (line 120)
   - ✅ `evaluateOpenTrade()` uses **fresh API:** `broker.getUnderlyingQuote()`, `broker.getOptionChain()`
   - ✅ `executeExitForTrade()` uses **fresh API:** `broker.getPositions()`, `broker.getOpenOrders()`, `broker.getOptionChain()`
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Sync is MANDATORY** - cycle aborts if sync fails
- ✅ **All market data from fresh API calls**
- ✅ **D1 only used to get trade list** (not market data)

---

## ✅ 3. Account Sync Cron (Background Sync)

**Cron Schedule:** Every 1 minute during market hours  
**File:** `src/cron/accountSync.ts`

### Purpose:
- Keeps D1 database fresh (for UI/historical tracking)
- Updates sync freshness timestamps
- **Does NOT make trading decisions**

### Data Flow:

1. **Sync Operations** (lines 42-80)
   ```typescript
   positionsSyncResult = await syncPortfolioFromTradier(env);
   ordersSyncResult = await syncOrdersFromTradier(env);
   balancesSyncResult = await syncBalancesFromTradier(env);
   ```

2. **Fresh API Calls** (lines 86-103)
   - ✅ `client.getPositions()` - Fresh positions
   - ✅ `client.getGainLoss()` - Fresh gain/loss data
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Only syncs data** - doesn't make trading decisions
- ✅ **Uses fresh API calls** for snapshot data
- ✅ **Non-fatal errors** - doesn't block other operations

---

## ✅ 4. Pending Entry Handler

**Called by:** Monitor Cycle (after sync)  
**File:** `src/engine/entry.ts` - `checkPendingEntries()`

### Data Flow:

1. **Get Pending Trades from D1** (line 751)
   - ✅ `getTradesByStatus(env, 'ENTRY_PENDING')` - **Only to get list**
   - ✅ **NOT used for market data**

2. **Check Order Status** (line 774)
   - ✅ `broker.getOrder(trade.broker_order_id_open)` - **Fresh API call**
   - ✅ **No D1 reads for market data**

3. **Fetch IV if Needed** (line 788)
   - ✅ `broker.getOptionChain()` - **Fresh API call**
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Called AFTER sync** (monitorCycle line 114)
- ✅ **All market data from fresh API calls**
- ✅ **D1 only used to get trade list**

---

## ✅ 5. Pending Exit Handler

**Called by:** Monitor Cycle (after sync)  
**File:** `src/engine/exits.ts` - `checkPendingExits()`

### Data Flow:

1. **Get Pending Trades from D1** (line 770)
   - ✅ `getTradesByStatus(env, 'CLOSING_PENDING')` - **Only to get list**
   - ✅ **NOT used for market data**

2. **Check Order Status** (line 791)
   - ✅ `broker.getOrder(trade.broker_order_id_close)` - **Fresh API call**
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Called AFTER sync** (monitorCycle line 117)
- ✅ **All market data from fresh API calls**
- ✅ **D1 only used to get trade list**

---

## ✅ 6. Exit Execution

**Called by:** Monitor Cycle (after sync)  
**File:** `src/engine/exits.ts` - `executeExitForTrade()`

### Data Flow:

1. **Compute Available Quantities** (line 320)
   - ✅ `broker.getPositions()` - **Fresh positions** (line 66)
   - ✅ `broker.getOpenOrders()` - **Fresh orders** (line 76)
   - ✅ `broker.getOrderWithLegs()` - **Fresh order details** (line 86)
   - ✅ **No D1 reads for market data**

2. **Cancel Open Orders** (line 323)
   - ✅ `broker.getOpenOrders()` - **Fresh orders** (line 149)
   - ✅ **No D1 reads for market data**

3. **Build Exit Order** (line 331)
   - ✅ `broker.getOptionChain()` - **Fresh chain** (line 331, 884)
   - ✅ **No D1 reads for market data**

### Verification:
- ✅ **Called AFTER sync** (monitorCycle line 151)
- ✅ **All market data from fresh API calls**
- ✅ **No D1 reads for market data**

---

## Critical Safety Mechanisms

### 1. Mandatory Sync Before Operations

**Both Trade Cycle and Monitor Cycle:**
```typescript
// Sync MUST succeed or cycle aborts
try {
  await syncPortfolioFromTradier(env);
  await syncOrdersFromTradier(env);
  await syncBalancesFromTradier(env);
} catch (error) {
  return; // ABORT - no stale data used
}
```

**Result:** If sync fails, cycle **ABORTS** - no operations proceed with stale data.

### 2. Fresh API Calls for All Market Data

**All operations use:**
- ✅ `broker.getUnderlyingQuote()` - Fresh quotes
- ✅ `broker.getOptionChain()` - Fresh chains
- ✅ `broker.getPositions()` - Fresh positions
- ✅ `broker.getOpenOrders()` - Fresh orders
- ✅ `broker.getOrder()` - Fresh order status

**Never:**
- ❌ Reading quotes from D1
- ❌ Reading chains from D1
- ❌ Reading positions from D1 (except for trade list)
- ❌ Reading orders from D1 (except for trade list)

### 3. D1 Usage is Limited

**D1 is ONLY used for:**
- ✅ Getting **list** of trades to monitor (not their market data)
- ✅ **Counting** trades for risk limits (not their market data)
- ✅ Storing results **after** API operations complete
- ✅ Historical tracking (not current market data)

---

## Sync Failure Handling

### Trade Cycle:
```typescript
catch (error) {
  console.error('[tradeCycle][sync][fatal] unable to refresh from Tradier; skipping trading cycle');
  return; // ABORT - cannot proceed without fresh Tradier data
}
```

### Monitor Cycle:
```typescript
catch (error) {
  console.error('[monitorCycle][sync][fatal] unable to refresh from Tradier; skipping trading cycle');
  return; // ABORT - cannot proceed without fresh Tradier data
}
```

**Result:** If sync fails, **NO operations proceed** - system cannot get out of sync.

---

## Conclusion

✅ **ALL CRONS ARE PROTECTED FROM STALE DATA**

1. **Syncs are MANDATORY** - cycles abort if sync fails
2. **All market data from fresh API calls** - never from D1
3. **D1 only used for trade lists/counts** - not market data
4. **Operations happen AFTER sync** - guaranteed fresh data
5. **No way to proceed with stale data** - sync failure = abort

**The system CANNOT get out of sync because:**
- Syncs must succeed before any operations
- All market data comes from fresh API calls
- D1 is never used to read current market prices/quotes
- If sync fails, cycles abort (no stale data used)

**Verification Status: ✅ CONFIRMED - System will never use stale data**

