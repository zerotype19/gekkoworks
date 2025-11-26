# Phase 2 → Phase 3 Promotion Criteria

**Purpose:** Define clear criteria for promoting from Phase 2 (Supervised PAPER) to Phase 3 (Hardening + Auto-Mode Prep).

---

## Required: Minimum Testing Period

### Duration
- **Minimum:** 1 full trading day (9:30 AM - 4:00 PM ET)
- **Recommended:** 2-3 full trading days
- **Maximum:** 5 trading days (if issues found)

### Sessions Required
- [ ] At least 1 complete trading session
- [ ] At least 1 session with proposal generation
- [ ] At least 1 session with exit signal evaluation
- [ ] At least 1 session with order execution

---

## Required: Zero Critical Issues

### Emergency Exits
- [ ] **ZERO** emergency exits during market hours
- [ ] **ZERO** false positive structural breaks
- [ ] **ZERO** emergency exits from after-hours rejections
- [ ] Emergency exit counter remains at 0 throughout testing

### Sync Failures
- [ ] **ZERO** positions sync failures
- [ ] **ZERO** orders sync failures
- [ ] **ZERO** balances sync failures
- [ ] All sync timestamps remain < 2 minutes old

### Data Integrity
- [ ] **ZERO** reconciliation mismatches
- [ ] **ZERO** spread structure violations
- [ ] **ZERO** quantity mismatches
- [ ] **ZERO** entry_price calculation errors

### System Stability
- [ ] **ZERO** crashes or unhandled exceptions
- [ ] **ZERO** cron failures
- [ ] **ZERO** database errors
- [ ] **ZERO** API timeouts

---

## Required: Functional Validation

### Proposal Generation
- [ ] Proposals generated during market hours
- [ ] All proposals meet criteria:
  - [ ] Delta: -0.30 to -0.20
  - [ ] DTE: 30-35 days
  - [ ] Credit ≥ $1.00
  - [ ] Score ≥ minimum threshold
- [ ] Portfolio net credit rule enforced
- [ ] No stale quote proposals
- [ ] Quote freshness validated (90 seconds)

### Monitoring & Exits
- [ ] Monitor cycle runs every minute
- [ ] All open trades evaluated correctly
- [ ] P&L calculations accurate (from Tradier)
- [ ] Exit rules evaluate correctly:
  - [ ] Profit target: +35% to +40%
  - [ ] Stop loss: -30%
  - [ ] Time exit: DTE ≤ 2 AND time ≥ 15:50 ET
  - [ ] IV crush: IV ≤ 85% of entry AND PnL ≥ +15%
- [ ] Exit signals trigger at correct thresholds
- [ ] Exit orders execute correctly

### Order Execution
- [ ] Entry orders placed correctly
- [ ] Entry orders filled in Tradier
- [ ] Exit orders placed correctly
- [ ] Exit orders filled in Tradier
- [ ] Order polling works (30s timeout, 2s interval)
- [ ] Order cancellation works on timeout

### Sync Subsystem
- [ ] Positions sync updates after order fills
- [ ] Orders sync updates after order placement
- [ ] Balances sync updates regularly
- [ ] Sync freshness enforced (< 2 minutes)
- [ ] Reconciliation detects no mismatches

---

## Required: Performance Metrics

### Response Times
- [ ] Proposal generation: < 10 seconds
- [ ] Monitor cycle: < 5 seconds per trade
- [ ] Sync operations: < 3 seconds each
- [ ] Order placement: < 2 seconds

### Reliability
- [ ] Cron jobs fire on schedule (100%)
- [ ] No missed monitor cycles
- [ ] No missed proposal cycles
- [ ] No sync gaps > 5 minutes

### Data Accuracy
- [ ] Entry prices match Tradier fill prices
- [ ] Quantities match Tradier positions
- [ ] P&L calculations match Tradier gain/loss
- [ ] Spread structure matches Tradier positions

---

## Required: Logging & Observability

### Log Quality
- [ ] All critical events logged
- [ ] Logs include trade IDs
- [ ] Logs include timestamps
- [ ] Logs include error details
- [ ] No excessive log noise

### Debug Endpoints
- [ ] `/v2/debug/health` returns accurate data
- [ ] `/v2/admin/reconcile` works correctly
- [ ] `/debug/portfolio-sync` shows correct data
- [ ] `/status` shows accurate system state

---

## Optional: Nice-to-Have Validations

### Edge Cases
- [ ] Handles market gaps correctly
- [ ] Handles after-hours correctly
- [ ] Handles weekend/holiday correctly
- [ ] Handles partial fills correctly
- [ ] Handles order rejections correctly

### Stress Testing
- [ ] Handles 10+ open positions
- [ ] Handles rapid proposal generation
- [ ] Handles multiple exit signals simultaneously
- [ ] Handles high market volatility

---

## Promotion Decision Matrix

### ✅ **PROMOTE TO PHASE 3** if:
- All "Required" criteria met
- Minimum testing period completed
- Zero critical issues
- Functional validation passes
- Performance metrics acceptable

### ⚠️ **EXTEND PHASE 2** if:
- Minor issues found (non-critical)
- Need more testing time
- Performance metrics borderline
- Some edge cases need validation

### ❌ **DO NOT PROMOTE** if:
- Any critical issues found
- Emergency exits occurred
- Sync failures occurred
- Data integrity issues found
- System stability issues found

---

## Promotion Checklist

Before promoting to Phase 3, confirm:

- [ ] All required criteria met
- [ ] Minimum testing period completed
- [ ] Zero critical issues
- [ ] Functional validation passes
- [ ] Performance metrics acceptable
- [ ] Logging & observability working
- [ ] Documentation updated
- [ ] Team sign-off (if applicable)

**Promotion Date:** _______________  
**Promoted By:** _______________  
**Notes:** _______________

---

## Phase 3 Readiness

Once promoted, Phase 3 will add:
- Exposure limits
- Circuit breakers
- Daily summaries
- Integrity audits
- Fill-quality improvements
- Dry-run modes
- Auto-mode safety rails

**Then:** Enable auto-mode for final validation before production.

