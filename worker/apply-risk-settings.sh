#!/bin/bash
# Apply Capital-Preserving Risk Settings
# 
# This script applies all the recommended risk settings to lock down the system
# and prevent bleeding. Run this immediately after deploying the new risk code.
#
# Usage:
#   ./apply-risk-settings.sh [API_BASE_URL]
#
# Example:
#   ./apply-risk-settings.sh https://gekkoworks-api.kevin-mcgovern.workers.dev

API_BASE_URL=${1:-"https://gekkoworks-api.kevin-mcgovern.workers.dev"}

echo "🔒 Applying Capital-Preserving Risk Settings..."
echo "API Base URL: $API_BASE_URL"
echo ""

# Function to update a setting
update_setting() {
  local key=$1
  local value=$2
  local description=$3
  
  echo "Setting $key = $value ($description)..."
  
  response=$(curl -s -X POST "$API_BASE_URL/v2/admin/settings" \
    -H "Content-Type: application/json" \
    -d "{\"key\": \"$key\", \"value\": \"$value\"}")
  
  if echo "$response" | grep -q '"success":true'; then
    echo "  ✅ Success"
  else
    echo "  ❌ Failed: $response"
  fi
  echo ""
}

# ============================================================================
# 1. TRADE-LEVEL CONTROLS
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "1. TRADE-LEVEL CONTROLS"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "MAX_TRADE_LOSS_DOLLARS" "450" "No spread with max_loss > $450"

# ============================================================================
# 2. DAILY RISK INTAKE (NEW RISK CREATION)
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "2. DAILY RISK INTAKE (NEW RISK CREATION)"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "DAILY_MAX_NEW_RISK" "1500" "Stop opening new trades once today's new risk hits $1,500"

# ============================================================================
# 3. DAILY LOSS CIRCUIT BREAKER
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "3. DAILY LOSS CIRCUIT BREAKER"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "DAILY_MAX_LOSS" "-500" "Shut off new entries if daily realized PnL hits -$500"

# ============================================================================
# 4. UNDERLYING EXPOSURE CAP
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "4. UNDERLYING EXPOSURE CAP"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "UNDERLYING_MAX_RISK" "2000" "No more SPY trades once SPY max_loss hits $2,000"

# ============================================================================
# 5. EXPIRY CLUSTERING CAP
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "5. EXPIRY CLUSTERING CAP"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "EXPIRY_MAX_RISK" "1000" "Limit max_loss per (symbol, expiry) pair to $1,000"

# ============================================================================
# 6. CLOSE RULES
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "6. CLOSE RULES (SIMPLIFIED)"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "CLOSE_RULE_PROFIT_TARGET_FRACTION" "0.50" "Take profit at 50% of max profit"
update_setting "CLOSE_RULE_STOP_LOSS_FRACTION" "0.10" "Stop loss at 10% of max loss"

# ============================================================================
# 7. SELECTION TIGHTENING
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "7. SELECTION TIGHTENING"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "PROPOSAL_MIN_SCORE" "95" "Only accept proposals with score ≥ 95"
update_setting "PROPOSAL_DTE_MIN" "30" "Minimum DTE window start"
update_setting "PROPOSAL_DTE_MAX" "35" "Maximum DTE window end"
update_setting "PROPOSAL_STRATEGY_WHITELIST" "BULL_PUT_CREDIT,BEAR_CALL_CREDIT" "Only these strategies"
update_setting "PROPOSAL_UNDERLYING_WHITELIST" "SPY" "Only SPY for now"

# ============================================================================
# 8. PAPER MODE SPECIFIC OVERRIDES
# ============================================================================
echo "════════════════════════════════════════════════════════════════════════"
echo "8. PAPER MODE SPECIFIC OVERRIDES"
echo "════════════════════════════════════════════════════════════════════════"
update_setting "MIN_SCORE_PAPER" "95" "Paper mode min score (overrides PROPOSAL_MIN_SCORE)"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "✅ ALL RISK SETTINGS APPLIED"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  • Max trade loss: $450"
echo "  • Daily new risk cap: $1,500"
echo "  • Daily loss circuit breaker: -$500"
echo "  • Underlying max risk: $2,000"
echo "  • Expiry max risk: $1,000"
echo "  • Profit target: 50%"
echo "  • Stop loss: 10%"
echo "  • Min score: 95"
echo "  • DTE window: 30-35 days"
echo "  • Strategies: BULL_PUT_CREDIT, BEAR_CALL_CREDIT"
echo "  • Underlying: SPY only"
echo ""
echo "🔒 System is now LOCKED DOWN for capital preservation."
echo ""
echo "Verify settings at: $API_BASE_URL/v2/admin/settings"

