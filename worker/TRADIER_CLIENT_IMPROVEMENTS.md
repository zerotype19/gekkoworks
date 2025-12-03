# TradierClient Improvements Applied

## ✅ Fixes Applied

### 1. Fail Hard on Missing Credentials
**Before:**
```typescript
this.apiToken = env.TRADIER_API_TOKEN || 'PLACEHOLDER_API_TOKEN';
this.accountId = env.TRADIER_ACCOUNT_ID || 'PLACEHOLDER_ACCOUNT_ID';
```

**After:**
```typescript
if (!env.TRADIER_API_TOKEN) {
  throw new Error('TRADIER_API_TOKEN is required');
}
if (!env.TRADIER_ACCOUNT_ID) {
  throw new Error('TRADIER_ACCOUNT_ID is required');
}
this.apiToken = env.TRADIER_API_TOKEN;
this.accountId = env.TRADIER_ACCOUNT_ID;
```

**Rationale:** Worker should fail loudly in dev/staging if credentials are missing, not silently use placeholders and get 401s.

### 2. Throw on Unknown Strategy Patterns
**Before:**
```typescript
} else {
  console.warn('[broker][placeSpreadOrder] Unknown strategy pattern, defaulting to credit', ...);
  baseType = 'credit';
}
```

**After:**
```typescript
} else {
  const msg = `Unknown strategy pattern for placeSpreadOrder: ${params.strategy}`;
  console.error('[broker][placeSpreadOrder][unknown-strategy]', ...);
  throw new Error(msg);
}
```

**Rationale:** Forces strategy naming consistency instead of silently doing the wrong thing.

### 3. Assert Leg Quantity Equality
**Before:**
```typescript
remaining_quantity: params.legs[0].quantity, // Assuming both legs same quantity
```

**After:**
```typescript
// CRITICAL: Assert leg quantity equality - spread orders require symmetric legs
if (params.legs[0].quantity !== params.legs[1].quantity) {
  throw new Error(`Mismatched leg quantities in spread: ${params.legs[0].quantity} vs ${params.legs[1].quantity}`);
}
```

**Rationale:** Prevents asymmetric spreads from being sent through code that assumes symmetry.

### 4. Fix Operation Name in `getOpenOrders`
**Before:**
```typescript
operation: 'GET_ALL_ORDERS',  // Same as getAllOrders - confusing
```

**After:**
```typescript
operation: 'GET_OPEN_ORDERS',  // Distinct from getAllOrders
```

**Rationale:** Makes log analysis clearer - can distinguish between open orders vs full history.

### 5. Tighten `avg_fill_price` Normalization
**Before (in `getOrder`):**
```typescript
avgFillPrice = Math.abs(rawPrice);  // Always absolute
```

**After:**
```typescript
if (order.type === 'credit' && rawPrice < 0) {
  avgFillPrice = Math.abs(rawPrice);
} else {
  avgFillPrice = rawPrice;
}
```

**Also applied to `getOpenOrders`** for consistency.

**Rationale:** Matches the logic in `getAllOrders` - only normalize credit spreads that are negative, keep debit spreads as-is.

### 6. Retry Count Comment
**Before:**
```typescript
const TRADIER_MAX_RETRIES = 2; // Maximum retries for transient failures
```

**After:**
```typescript
const TRADIER_MAX_RETRIES = 2; // Maximum retries for transient failures (total attempts = 3: initial + 2 retries)
```

**Rationale:** Clarifies that total attempts = 3, not 2.

## 📝 Notes

### Status Map Duplication
The `statusMap` is duplicated in `getOrder`, `getOpenOrders`, and `getAllOrders`. This is acceptable for now, but could be centralized in the future:

```typescript
function mapTradierStatus(status?: string): BrokerOrderStatus {
  const statusMap: Record<string, BrokerOrderStatus> = {
    'filled': 'FILLED',
    'open': 'OPEN',
    'cancelled': 'CANCELLED',
    'rejected': 'REJECTED',
    'expired': 'EXPIRED',
    'pending': 'NEW',
    'partially_filled': 'OPEN',
    'partial': 'OPEN',
  };
  return statusMap[status?.toLowerCase()] || 'UNKNOWN';
}
```

This would prevent drift if status mappings need to change.

## ✅ Validation

- ✅ TypeScript compilation passes
- ✅ All error cases now fail fast
- ✅ Logging operation names are distinct
- ✅ `avg_fill_price` normalization is consistent across methods

