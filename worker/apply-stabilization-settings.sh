#!/bin/bash
# Apply stabilization phase settings
# - Disable BEAR_CALL_CREDIT (only BULL_PUT_CREDIT)
# - Update min credit fraction setting

API_BASE_URL=${1:-http://localhost:8787} # Default to localhost if no URL provided

echo "🔒 Applying Stabilization Phase Settings..."
echo "API Base URL: ${API_BASE_URL}"
echo ""

# Disable BEAR_CALL_CREDIT - only allow BULL_PUT_CREDIT
echo "════════════════════════════════════════════════════════════════════════"
echo "DISABLING BEAR_CALL_CREDIT (Stabilization Phase)"
echo "════════════════════════════════════════════════════════════════════════"
echo "Setting PROPOSAL_STRATEGY_WHITELIST = BULL_PUT_CREDIT (removing BEAR_CALL_CREDIT)..."
curl -s -X POST "${API_BASE_URL}/v2/admin/settings" -H "Content-Type: application/json" -d '{"key":"PROPOSAL_STRATEGY_WHITELIST","value":"BULL_PUT_CREDIT"}' | jq -r '.message // "✅ Success"'

# Update min credit fraction (lowered from 0.18 to 0.16)
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "LOWERING MIN CREDIT FRACTION"
echo "════════════════════════════════════════════════════════════════════════"
echo "Setting MIN_CREDIT_FRACTION = 0.16 (lowered from 0.18)..."
curl -s -X POST "${API_BASE_URL}/v2/admin/settings" -H "Content-Type: application/json" -d '{"key":"MIN_CREDIT_FRACTION","value":"0.16"}' | jq -r '.message // "✅ Success"'

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "✅ STABILIZATION SETTINGS APPLIED"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  • Strategy whitelist: BULL_PUT_CREDIT only"
echo "  • Min credit fraction: 0.16 (16% of width = \$0.80 for 5-wide)"
echo ""
echo "🔒 System is now in stabilization mode (BULL_PUT_CREDIT only)."

