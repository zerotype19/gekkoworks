# Gekkoworks = Mirror of Tradier Philosophy

## Core Principle

**Gekkoworks should be a pure mirror of Tradier - it only tracks trades that have actual broker orders.**

## What This Means

1. **Only Track Real Broker Orders**
   - Trades MUST have `broker_order_id_open` (entry order)
   - Closed trades MUST have `broker_order_id_close` (exit order)
   - No phantom trades - if there's no broker order, there's no trade

2. **No Manual Trade Creation**
   - Never create trades without placing broker orders first
   - Never close trades without placing broker orders first
   - The system is programmatic - it places orders, then tracks them

3. **Source of Truth = Tradier**
   - Portfolio positions come from Tradier portfolio sync
   - Order status comes from Tradier order sync
   - Gain/loss comes from Tradier gain/loss API
   - Our database is just a cache/mirror

## Verification

Use `/v2/debug/compare-tradier-closed?date=YYYY-MM-DD` to compare:
- Our closed trades count vs Tradier's gain/loss count
- Which trades have `broker_order_id_close` (should be all)
- Which trades don't have close orders (these are suspicious)

## Red Flags

- Trades closed without `broker_order_id_close`
- More closed trades in our system than Tradier shows
- Trades with `BROKER_ALREADY_FLAT` that don't have close orders
- Any trade that can't be traced to a Tradier order

