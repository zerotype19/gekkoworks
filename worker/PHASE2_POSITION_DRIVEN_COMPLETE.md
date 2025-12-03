# Phase 2: Position-Driven Helpers & Exit Wiring - Complete

## ✅ Completed

### 1. Portfolio Helper Queries (`db/queries.ts`)

#### ✅ `getPortfolioPositionsForSymbol`
- Returns all rows from `portfolio_positions` for a symbol
- Ordered by expiration, option_type, strike, side

#### ✅ `getSpreadLegPositions`
- Returns short and long leg positions for a specific trade
- Uses exact key columns: symbol, expiration, option_type, strike, side
- Derives `side` from trade strategy (credit vs debit spreads)
- Logs warning if both legs are missing
- Returns `null` for missing legs

### 2. Position Utility Module (`core/positions.ts`)

#### ✅ `computeSpreadPositionSnapshot`
- Pure function (no DB access)
- Takes trade + leg positions, returns normalized snapshot
- Handles null legs (qty=0, cost_basis=null)
- Always uses absolute quantity values

### 3. Exit Quantity Logic Refactored (`engine/exits.ts`)

#### ✅ `computeAvailableQuantities`
- **Before:** Called `broker.getPositions()` directly
- **After:** Uses `getSpreadLegPositions` + `computeSpreadPositionSnapshot`
- Still accounts for open orders (needs broker for that)
- Logs position snapshot instead of raw broker positions

#### ✅ `resolveExitQuantity`
- **Before:** Called `broker.getPositions()` directly
- **After:** Uses `getSpreadLegPositions` + `computeSpreadPositionSnapshot`
- **Rules implemented:**
  - Both legs zero → `BROKER_ALREADY_FLAT` (not an error)
  - One leg missing → `SPREAD_LEGS_OUT_OF_SYNC` (error, manual investigation)
  - Both legs present → normal exit quantity calculation

### 4. Phantom Detection Updated (`cron/monitorCycle.ts`)

#### ✅ `closePhantomTrades` - OPEN trades
- **Before:** Called `broker.getPositions()` and built position set
- **After:** Uses `getSpreadLegPositions` + `computeSpreadPositionSnapshot` for each OPEN trade
- **Rules implemented:**
  - **Rule A - Fully flat:** Both legs zero → Close with `BROKER_ALREADY_FLAT`, `exit_price=0`
  - **Rule B - Legs out of sync:** One leg zero, other > 0 → Log warning, leave OPEN for manual investigation
  - **Rule C - Normal case:** Both legs > 0 → Do nothing, monitoring continues

#### ✅ Pending trades (ENTRY_PENDING, CLOSING_PENDING)
- Kept existing broker order check logic
- Removed broken position checking code
- These still need order validation, not just position checks

### 5. Strategy Classification Helper (`core/strategies.ts`)

#### ✅ `classifySpreadFromStrikesAndType`
- Classifies spread from option type and strike relationship
- Rules:
  - Put: `shortStrike > longStrike` → `BULL_PUT_CREDIT`, else → `BEAR_PUT_DEBIT`
  - Call: `shortStrike < longStrike` → `BEAR_CALL_CREDIT`, else → `BULL_CALL_DEBIT`
- Available for future use (entry.ts already uses `proposal.strategy`)

## 🔄 What Changed

### Exit Flow
1. **Quantity determination:** Now from `portfolio_positions` (via helpers)
2. **"Already flat" detection:** Both legs zero → `BROKER_ALREADY_FLAT` (not error)
3. **Leg sync errors:** One leg missing → `SPREAD_LEGS_OUT_OF_SYNC` (error)

### Monitoring Flow
1. **Phantom detection:** Uses `portfolio_positions` for OPEN trades
2. **Clean closure:** Fully flat trades closed with `BROKER_ALREADY_FLAT`
3. **Data issues:** Legs out of sync left OPEN for manual investigation

### No Longer
- Direct `broker.getPositions()` calls in exit quantity helpers
- Position set building in phantom detection
- Guessing at position quantities from trade.quantity

## 📝 Notes

- **Open orders:** Still checked via broker (not in portfolio_positions)
- **Pending trades:** Still use broker order checks (not position-based)
- **Strategy classification:** Helper created but not yet integrated (entry.ts uses proposal.strategy which should be correct)
- **No schema changes:** All changes are code-only, using existing Phase 1 tables

## ✅ Validation

- ✅ TypeScript compilation passes
- ✅ All imports resolved
- ✅ Function signatures match spec exactly
- ✅ Logging updated to use position snapshots

## 🎯 Next Steps (Phase 3+)

- Integrate strategy classification into entry path (if needed)
- Add `computeSpreadEnvelope` for max_profit/max_loss calculation
- Consider adding position-based validation in entry path
- Monitor logs for `SPREAD_LEGS_OUT_OF_SYNC` to identify data issues

