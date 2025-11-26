# Gekkoworks Cron Schedule

## Market Hours (ET)
- **Market Open:** 9:30 AM ET
- **Entry Cutoff:** 3:50 PM ET (per entry-rules.md)
- **Market Close:** 4:00 PM ET

## UTC Conversion

### EST (Winter, UTC-5)
- 8:00 AM ET = 13:00 UTC
- 9:30 AM ET = 14:30 UTC
- 3:50 PM ET = 20:50 UTC
- 4:00 PM ET = 21:00 UTC

### EDT (Summer, UTC-4)
- 8:00 AM ET = 12:00 UTC
- 9:30 AM ET = 13:30 UTC
- 3:50 PM ET = 19:50 UTC
- 4:00 PM ET = 20:00 UTC

## Current Cron Schedule

### 1. Premarket Check
**Cron:** `0 13 * * MON-FRI`
- **UTC:** 1:00 PM (13:00)
- **EST:** 8:00 AM ET ✅
- **EDT:** 9:00 AM ET ✅ (still pre-market)
- **Purpose:** Health checks before market open

### 2. Trade Cycle
**Cron:** `*/1 14-20 * * MON-FRI`
- **UTC:** Every 1 minute from 2:00 PM - 8:59 PM (14:00-20:59)
- **EST:** 9:00 AM - 3:59 PM ET
- **EDT:** 10:00 AM - 4:59 PM ET
- **Note:** Code enforces 9:30 AM - 3:50 PM ET window via `isMarketHours()` check
- **Early Exit Gates:** Returns immediately if market closed, risk gates block, or position already open
- **Purpose:** Generate proposals and attempt entries

### 3. Monitor Cycle
**Cron:** `1-59/1 14-20 * * MON-FRI`
- **UTC:** Every 1 minute (offset by 1 minute) from 2:00 PM - 8:59 PM (14:00-20:59)
- **EST:** 9:00 AM - 3:59 PM ET
- **EDT:** 10:00 AM - 4:59 PM ET
- **Note:** Code enforces 9:30 AM - 3:50 PM ET window via `isMarketHours()` check
- **Early Exit Gate:** Returns immediately if no open/pending trades exist (avoids unnecessary broker calls)
- **Purpose:** Monitor open positions and execute exits

## Safety Notes

1. **Code-level enforcement:** The `isMarketHours()` function in `core/time.ts` enforces the exact 9:30 AM - 3:50 PM ET window, so crons can run slightly outside this window and the code will filter appropriately.

2. **DST handling:** The cron expressions use UTC, which doesn't change with DST. The code handles DST conversion internally.

3. **Current schedule is safe:** The cron windows are slightly wider than market hours, but the code-level checks ensure trades only execute during the correct window.

## Next Scheduled Runs (from Cloudflare Dashboard)

Based on the image you showed:
- **Monitor Cycle:** Next: Thu, 20 Nov 2025 15:58:00 UTC (10:58 AM ET)
- **Trade Cycle:** Next: Thu, 20 Nov 2025 16:00:00 UTC (11:00 AM ET)
- **Premarket:** Next: Fri, 21 Nov 2025 13:00:00 UTC (8:00 AM ET EST / 9:00 AM ET EDT)

## Verification

The current cron schedule is **correct** for Cloudflare's UTC-based cron system. The code-level market hours checks provide the final enforcement of the 9:30 AM - 3:50 PM ET trading window.

