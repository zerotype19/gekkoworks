# System Mode Management

## Overview

The system has two modes:
- **NORMAL**: System is operating normally, can open new trades
- **HARD_STOP**: System is stopped, cannot open new trades (requires manual review)

## When HARD_STOP is Triggered

HARD_STOP is only triggered for **serious, legitimate conditions**:

1. **Emergency Exit Threshold** (>= 2 emergency exits in one day)
   - Triggered by: `incrementEmergencyExitCount()` in `core/risk.ts`
   - Reason: `EMERGENCY_EXIT_THRESHOLD`
   - Details: `{ emergency_exit_count, threshold: 2 }`

2. **Kill Switch Conditions** (via `checkAndApplyKillSwitch()`)
   - Mark-to-market loss > 3% of equity
   - Other critical risk breaches

## What Does NOT Trigger HARD_STOP

The following conditions are **explicitly excluded** from triggering HARD_STOP:

1. **After-Hours Order Rejections**
   - Market closed errors
   - Trading hours errors
   - Session not open errors
   - These are logged as `[exit][order][rejected]` with `benign: true`
   - No emergency exit is triggered
   - No HARD_STOP is set

2. **Missing entry_price on External Trades**
   - External trades (not opened by system) are skipped in monitoring
   - Missing entry_price does not trigger emergency exits
   - These trades are logged as `[monitor][skip-external]` or `[data][missing-entry-price]`

3. **Normal Exit Failures**
   - Order rejections for normal reasons (e.g., insufficient buying power)
   - These are logged but don't trigger HARD_STOP

## System Mode Change Logging

Every system mode change is logged with:
- `[system][mode-change]` console log
- Entry in `system_logs` table with type `system_mode_change`
- Stored in `LAST_SYSTEM_MODE_CHANGE` risk state
- If entering HARD_STOP, also stored in `LAST_HARD_STOP_AT` and `LAST_HARD_STOP_REASON`

## Debug Endpoints

### GET /debug/system-mode
View current system mode, risk state, and recent change history.

**Response:**
```json
{
  "system_mode": "NORMAL" | "HARD_STOP",
  "risk_state": "NORMAL" | "EMERGENCY_EXIT_OCCURRED_TODAY" | ...,
  "emergency_exit_count_today": 0,
  "trading_mode": "SANDBOX_PAPER",
  "last_hard_stop_at": "2025-11-23T...",
  "last_hard_stop_reason": "EMERGENCY_EXIT_THRESHOLD",
  "last_mode_change": "2025-11-23T...",
  "history": [...]
}
```

### POST /debug/system-mode
Change system mode (PAPER/SANDBOX only, disabled in LIVE).

**Request:**
```json
{
  "mode": "NORMAL" | "HARD_STOP",
  "reason": "MANUAL_OVERRIDE" | "custom reason"
}
```

**Response:**
```json
{
  "success": true,
  "system_mode": "NORMAL",
  "reason": "MANUAL_OVERRIDE",
  "timestamp": "2025-11-23T..."
}
```

## Emergency Exit Logic

Emergency exits are triggered by:
- Missing critical data (option legs, quotes)
- Data integrity failures
- System errors during exit execution

**Important:** After-hours rejections are **NOT** emergency exits. They are benign and logged separately.

## External Trades

External trades (trades not opened by this system, `broker_order_id_open === null`) are:
- **Skipped in monitoring** - not evaluated for exits
- **Not counted** toward `MAX_OPEN_POSITIONS`
- **Not managed** by the system

This prevents:
- Fake P&L calculations
- Emergency exits on trades we didn't open
- System managing positions it doesn't control

## Recovery from HARD_STOP

1. **Investigate** why HARD_STOP was triggered:
   - Check `GET /debug/system-mode` for last reason
   - Review logs for `[system][mode-change]` entries
   - Check `emergency_exit_count_today`

2. **Resolve** the underlying issue:
   - If emergency exits were legitimate → fix the root cause
   - If emergency exits were false positives → adjust logic

3. **Reset** system mode:
   - Use `POST /debug/system-mode` with `mode: "NORMAL"`
   - Or wait for premarket check to reset (if it was a daily stop)

## Best Practices

1. **Always log mode changes** - Use `setSystemMode()` helper, never `setRiskState()` directly
2. **Check for benign rejections** - Use `isBenignRejection()` before treating errors as emergencies
3. **Skip external trades** - Don't attempt to manage trades we didn't open
4. **Monitor mode changes** - Review `[system][mode-change]` logs regularly
5. **Document reasons** - Always provide clear reasons when changing modes

