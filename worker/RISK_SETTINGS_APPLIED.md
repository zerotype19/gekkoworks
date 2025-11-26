# 🔒 Capital-Preserving Risk Settings Applied

**Date Applied**: [APPLY NOW]

**Account Size**: ~$100,000 buying power (PAPER)

**Typical Spread**: $5-wide, ~$1.00–$1.20 credit → max_loss ≈ $380–$400 per spread

---

## ✅ Applied Settings

### 1. Trade-Level Controls

```
MAX_TRADE_LOSS_DOLLARS = 450
```

**Meaning**: No spread allowed where max_loss > $450. Prevents $10-wide spreads, poorly-structured spreads, and mis-priced fills.

---

### 2. Daily Risk Intake (New Risk Creation)

```
DAILY_MAX_NEW_RISK = 1500
```

**Meaning**: Once max_loss of new trades opened today reaches $1,500, the system stops opening new trades and only holds/exits existing positions. Prevents "spraying trades" when market looks choppy.

---

### 3. Daily Loss Circuit Breaker

```
DAILY_MAX_LOSS = -500
```

**Meaning**: If realized PnL for the day hits **–$500**, the system automatically shuts off new entries and stays in exit-only mode. Prevents compounding losses during bad conditions.

---

### 4. Underlying Exposure Cap

```
UNDERLYING_MAX_RISK = 2000
```

**Meaning**: For SPY specifically, if max_loss of all SPY positions hits $2,000, NO MORE SPY TRADES OPEN. Stops correlated loss from too many spreads on the same ticker.

---

### 5. Expiry Clustering Cap

```
EXPIRY_MAX_RISK = 1000
```

**Meaning**: For SPY expiring on a specific date (e.g., Dec-20), max_loss of all spreads sharing that expiry ≤ $1,000. Prevents being wiped out by one bad day before expiration.

---

### 6. Close Rules (Simplified)

```
CLOSE_RULE_PROFIT_TARGET_FRACTION = 0.50
CLOSE_RULE_STOP_LOSS_FRACTION = 0.10
```

**Meaning**: 
- Take profit at **50% of max profit**
- Stop loss at **10% of max loss**

---

### 7. Selection Tightening

```
PROPOSAL_MIN_SCORE = 95
PROPOSAL_DTE_MIN = 30
PROPOSAL_DTE_MAX = 35
PROPOSAL_STRATEGY_WHITELIST = BULL_PUT_CREDIT,BEAR_CALL_CREDIT
PROPOSAL_UNDERLYING_WHITELIST = SPY
MIN_SCORE_PAPER = 95
```

**Meaning**:
- Only accept proposals with score ≥ 95
- DTE window: 30-35 days (sweet spot)
- Only credit spread strategies
- Only SPY for next 7-10 trading days (building edge discipline, not diversification yet)

---

## 📊 Expected Behavior

### BEFORE:
- Possibly opening 8–12 spreads in one day
- Taking in $3,500–$5,000 of "risk"
- When wrong → lose $1,500–$3,000

### AFTER:
- Opens max **3–4 trades per day**
- Risk exposure tightly capped
- Worst realistic-case daily drawdown ≈ **$500**
- Normal daily range: **–$250 → +$700**
- Wins compound, losses contained

---

## 🚀 How to Apply

### Option 1: Use the Script (Recommended)

```bash
cd worker
./apply-risk-settings.sh [API_BASE_URL]
```

Example:
```bash
./apply-risk-settings.sh https://gekkoworks-api.kevin-mcgovern.workers.dev
```

### Option 2: Manual API Calls

For each setting, POST to `/v2/admin/settings`:

```bash
curl -X POST "$API_BASE_URL/v2/admin/settings" \
  -H "Content-Type: application/json" \
  -d '{"key": "MAX_TRADE_LOSS_DOLLARS", "value": "450"}'
```

### Option 3: Direct Database (Advanced)

```sql
INSERT OR REPLACE INTO settings (key, value) VALUES
  ('MAX_TRADE_LOSS_DOLLARS', '450'),
  ('DAILY_MAX_NEW_RISK', '1500'),
  ('DAILY_MAX_LOSS', '-500'),
  ('UNDERLYING_MAX_RISK', '2000'),
  ('EXPIRY_MAX_RISK', '1000'),
  ('CLOSE_RULE_PROFIT_TARGET_FRACTION', '0.50'),
  ('CLOSE_RULE_STOP_LOSS_FRACTION', '0.10'),
  ('PROPOSAL_MIN_SCORE', '95'),
  ('PROPOSAL_DTE_MIN', '30'),
  ('PROPOSAL_DTE_MAX', '35'),
  ('PROPOSAL_STRATEGY_WHITELIST', 'BULL_PUT_CREDIT,BEAR_CALL_CREDIT'),
  ('PROPOSAL_UNDERLYING_WHITELIST', 'SPY'),
  ('MIN_SCORE_PAPER', '95');
```

---

## ✅ Verification

After applying, verify at:

```
GET $API_BASE_URL/v2/admin/settings
```

You should see all the above settings with the correct values.

---

## 📈 Monitoring

Monitor system behavior with:

```
GET $API_BASE_URL/debug/pnl-summary?days=7
```

This will show:
- Realized PnL by day
- Realized PnL by underlying/strategy
- Open risk by underlying
- Exit counts by reason
- Summary stats (win rate, profit factor, etc.)

---

## 🔄 Adjusting Values

If account size is different from $100k, scale proportionally:

| Account Size | Scale Factor | MAX_TRADE_LOSS | DAILY_MAX_NEW_RISK | DAILY_MAX_LOSS | UNDERLYING_MAX_RISK |
|-------------|--------------|----------------|-------------------|----------------|---------------------|
| $50k        | 0.5x         | $225           | $750              | -$250          | $1,000              |
| $100k       | 1.0x         | $450           | $1,500            | -$500          | $2,000              |
| $200k       | 2.0x         | $900           | $3,000            | -$1,000        | $4,000              |
| $250k       | 2.5x         | $1,125         | $3,750            | -$1,250        | $5,000              |

---

**Status**: ✅ Settings defined and ready to apply
**Action Required**: Run `./apply-risk-settings.sh` to lock down the system

