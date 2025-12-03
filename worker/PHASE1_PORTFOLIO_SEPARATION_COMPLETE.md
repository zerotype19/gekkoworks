# Phase 1: Portfolio Separation - Data Model & Pure Portfolio Sync

## ✅ Completed

### 1. Data Model Changes

#### ✅ `portfolio_positions` Table Added
- **Location:** `worker/src/db/schema.sql`
- **Schema:** One row per leg (not per spread)
- **Unique Index:** `(symbol, expiration, option_type, strike, side)`
- **Fields:**
  - `id` - Composite key
  - `symbol` - Underlying symbol (e.g., 'SPY')
  - `expiration` - 'YYYY-MM-DD'
  - `option_type` - 'call' or 'put'
  - `strike` - Strike price
  - `side` - 'long' or 'short'
  - `quantity` - Always >= 0 (absolute value)
  - `cost_basis_per_contract` - Per-contract basis (nullable)
  - `last_price` - Last/mark price (nullable)
  - `updated_at` - ISO timestamp

#### ✅ `trades` Table Extended
- **New Columns:**
  - `origin` - 'ENGINE' | 'IMPORTED' | 'MANUAL' (default: 'ENGINE')
  - `managed` - 1 = engine can auto-monitor/exit, 0 = engine must ignore (default: 1)
- **Updated:** `insertTrade` function includes new columns
- **Updated:** `getOpenTrades` filters by `managed=1` (or NULL for backward compatibility)

### 2. Query Functions

#### ✅ Portfolio Position Functions
- **`upsertPortfolioPosition`** - Insert or replace position (handles unique index)
- **`getAllPortfolioPositions`** - Get all positions
- **`getPortfolioPositionsForSymbol`** - Get positions for symbol (optional expiration filter)
- **`clearAllPortfolioPositions`** - Clear all positions
- **`deletePortfolioPositionsNotInSet`** - Delete positions not in provided set (for sync cleanup)

### 3. Portfolio Sync Refactored

#### ✅ `syncPortfolioFromTradier` - Pure Mirror Function
- **Before:** Created/updated trades, detected phantoms, updated quantities
- **After:** Only mirrors Tradier positions to `portfolio_positions` table
- **Behavior:**
  1. Fetches positions from Tradier
  2. Parses each position (option symbol → underlying, expiration, type, strike)
  3. Determines side (long if quantity > 0, short if quantity < 0)
  4. Calculates `cost_basis_per_contract` (divides total by quantity)
  5. Upserts into `portfolio_positions` using unique index
  6. Deletes positions not in current Tradier snapshot (handles closed positions)
- **Return Type:** `{ success: boolean, synced: number, errors: string[] }`
- **No Longer:**
  - Creates trades
  - Updates trades
  - Detects phantoms
  - Checks concentration limits
  - Groups into spreads

### 4. Type Definitions

#### ✅ `PortfolioPositionRow` Interface
- Added to `worker/src/types.ts`
- Matches schema exactly

#### ✅ `TradeRow` Extended
- Added `origin?: string`
- Added `managed?: number`

### 5. Updated References

#### ✅ Fixed Return Type References
- `monitorCycle.ts` - Updated to use `success` instead of `created`
- `debugPortfolioSync.ts` - Updated to use `success` instead of `created`
- `tradeCycle.ts` - Already compatible (doesn't use `created`)

## 🔄 Next Steps (Phase 2+)

### Phase 2: Helper Utilities & Monitoring
- [ ] Create `engine/positions.ts` with `getSpreadPositionsForTrade`
- [ ] Update phantom detection to use `portfolio_positions`

### Phase 3: Exits & Quantity Logic
- [ ] Wire `portfolio_positions` into exit quantity helpers
- [ ] Confirm exits don't depend on `broker_order_id_open`

### Phase 4: Strategy Classification
- [ ] Create `core/spreadClassification.ts`
- [ ] Refactor `markTradeOpen` to use `computeSpreadEnvelope`

### Phase 5: Safety Switches
- [ ] Apply `managed=0` to existing problematic positions (AAPL/NVDA)

## 📝 Notes

- **Backward Compatibility:** `getOpenTrades` filters by `managed=1` OR `managed IS NULL` to handle existing trades
- **Migration:** Existing trades will have `origin='ENGINE'` and `managed=1` by default
- **No Breaking Changes:** All existing code continues to work, new functionality is additive

## ✅ Validation

- ✅ Schema validation passes
- ✅ TypeScript compilation passes
- ✅ All type definitions updated
- ✅ Return type references fixed

