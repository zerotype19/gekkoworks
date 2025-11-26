
```
/docs/tradier-api-guide.md
```

---

# 📘 `/docs/tradier-api-guide.md`

**Gekkoworks Tradier API Integration Guide**
**Stable Endpoints & Usage Contract (NON-NEGOTIABLE)**

This document specifies:

* Exactly which Tradier endpoints Gekkoworks uses
* How to call each endpoint
* Required headers
* Expected response shape
* Known pitfalls
* Official documentation links

Cursor MUST refer to this file whenever implementing broker logic.
Cursor MUST NOT call any other Tradier endpoints.

---

# 🔑 1. API Base URLs

Gekkoworks supports two environments:

### **SANDBOX / PAPER TRADING**

```
https://sandbox.tradier.com/v1
```

### **LIVE TRADING**

```
https://api.tradier.com/v1
```

Cursor MUST pick the correct base via:

```
env.TRADIER_ENV === 'sandbox' ? SANDBOX_URL : LIVE_URL
```

---

# 🔒 2. Authentication

Tradier uses **bearer token** auth:

```
Authorization: Bearer ${env.TRADIER_API_TOKEN}
Accept: application/json
Content-Type: application/x-www-form-urlencoded
```

Cursor MUST include these headers in all requests.

---

# 📦 3. Endpoints Used by Gekkoworks

These are the ONLY endpoints required for SAS v1.

---

# **3.1 Underlying Quote**

**GET** `/markets/quotes`

### URL:

```
GET /markets/quotes?symbols=SPY
```

### Docs:

[https://documentation.tradier.com/brokerage-api/markets/get-quotes](https://documentation.tradier.com/brokerage-api/markets/get-quotes)

### Response (abridged):

```json
{
  "quotes": {
    "quote": {
      "symbol": "SPY",
      "last": 441.23,
      "bid": 441.20,
      "ask": 441.22,
      "change": 1.26,
      "change_percentage": 0.29,
      "prevclose": 439.97,
      "type": "etf"
    }
  }
}
```

---

# **3.2 Option Chain (Per Expiration)**

**GET** `/markets/options/chains`

### URL:

```
GET /markets/options/chains?symbol=SPY&expiration=2024-12-20
```

### Docs:

[https://documentation.tradier.com/brokerage-api/markets/get-options-chains](https://documentation.tradier.com/brokerage-api/markets/get-options-chains)

### Response (abridged):

```json
{
  "options": {
    "option": [
      {
        "symbol": "SPY231220P00450000",
        "underlying": "SPY",
        "strike": 450.0,
        "option_type": "put",
        "expiration_date": "2023-12-20",
        "bid": 4.35,
        "ask": 4.40,
        "last": 4.38,
        "greeks": {
          "delta": -0.23,
          "iv": 0.162
        }
      }
    ]
  }
}
```

Cursor MUST extract:

* `bid`
* `ask`
* `last`
* `greeks.delta`
* `greeks.iv`

---

# **3.3 Place Multi-Leg Spread Order**

**POST** `/accounts/{account_id}/orders`

This is how Gekkoworks enters both ENTRY and EXIT orders.

### URL:

```
POST /accounts/{account_id}/orders
```

### Docs:

[https://documentation.tradier.com/brokerage-api/trading/place-order](https://documentation.tradier.com/brokerage-api/trading/place-order)

### Headers:

```
Content-Type: application/x-www-form-urlencoded
Authorization: Bearer ${env.TRADIER_API_TOKEN}
```

### Body Format (required EXACTLY):

#### Bull Put Credit Spread Entry (example)

```
class=multileg
type=limit
symbol=SPY
duration=day
price=1.25
option_symbol[0]=SPY231220P00450000
side[0]=sell_to_open
quantity[0]=1
option_symbol[1]=SPY231220P00455000
side[1]=buy_to_open
quantity[1]=1
tag=GEKKOWORKS-ENTRY
```

#### Notes:
 
* `class=multileg`
* `type=limit` **for both entries and exits** – Tradier infers net credit/debit from the leg directions
* `duration=day` (NO other types allowed in v1)
* price = LIMIT PRICE (positive number; Tradier interprets credit/debit via legs)
* Both legs at once
* DO NOT try to send combo or “OCO” structures

#### Response:

```json
{
  "order": {
    "id": "123456789",
    "status": "open"
  }
}
```

---

# **3.4 Get Order Status**

**GET** `/accounts/{account_id}/orders/{order_id}`

### URL:

```
GET /accounts/{account_id}/orders/123456789
```

### Docs:

[https://documentation.tradier.com/brokerage-api/trading/get-order](https://documentation.tradier.com/brokerage-api/trading/get-order)

### Response (abridged):

```json
{
  "order": {
    "id": 123456789,
    "status": "filled",
    "avg_fill_price": 1.23,
    "filled_quantity": 1,
    "remaining_quantity": 0
  }
}
```

Cursor MUST map:

* `status`
* `avg_fill_price`
* `filled_quantity`

---

# **3.5 List Open Positions (optional reconciliation)**

**GET** `/accounts/{account_id}/positions`

Not core logic, used only for reconciliation/debug.

### URL:

```
GET /accounts/{account_id}/positions
```

### Docs:

[https://documentation.tradier.com/brokerage-api/accounts/get-positions](https://documentation.tradier.com/brokerage-api/accounts/get-positions)

### Response (example):

```json
{
  "positions": {
    "position": [
      {
        "symbol": "SPY231220P00450000",
        "quantity": -1,
        "cost_basis": 1.25
      }
    ]
  }
}
```

---

# 🟥 Endpoints Cursor MUST NOT Use

Cursor MUST NOT touch:

* `/markets/quotes/options`
* `/markets/history`
* `/markets/timesales`
* `/markets/search`
* `/watchlists/*`
* `/orders/preview`
* WebSocket streaming
* `/accounts/balances` (Gekkoworks handles risk separately)
* Any margin or portfolio endpoints
* Any undocumented endpoints

These introduce drift & complexity → forbidden in v1.

---

# ⚙️ 4. Required Tradier → Gekkoworks Mappings

### Underlying Quote → `UnderlyingQuote`

Cursor MUST map:

```
last → last
bid → bid
ask → ask
change → change
change_percentage → change_percentage
prevclose → prev_close
```

---

### Option Quote → `OptionQuote`

Cursor MUST map:

From chain response:

```
symbol → symbol
underlying → underlying
option_type → type ("put" / "call")
expiration_date → expiration_date
strike → strike
bid → bid
ask → ask
last → last
greeks.delta → delta
greeks.iv → implied_volatility
```

---

### Order Result → `BrokerOrder`

Cursor MUST map:

```
order.id → id
order.status → status
order.avg_fill_price → avg_fill_price
order.filled_quantity → filled_quantity
order.remaining_quantity → remaining_quantity
```

---

# 🔍 5. Broker Polling Rules

Cursor MUST:

* Poll order status every ~10–20 seconds
* Update trade state via lifecycle functions
* Never assume fills
* Never multiply orders
* Never retry with wider prices
* Never use MARKET orders

If Tradier returns:

* `"open"` → wait
* `"filled"` → transition trade state
* `"cancelled"` → mark ENTRY_PENDING or CLOSING_PENDING as failed
* `"rejected"` → emergency exit logic

---

# 🚫 6. Known Pitfalls (Cursor MUST avoid)

### 6.1 Missing Greeks

Sandbox sometimes returns:

```
"greeks": null
```

Cursor MUST treat missing delta or IV as an **invalid quote**, triggering emergency-exit logic in monitoring or simply rejecting the candidate chain during proposal generation.

---

### 6.2 Zero bid/ask

If bid or ask = 0:

* mark price becomes invalid
* monitoring triggers emergency exit
* proposal generator MUST ignore those legs

---

### 6.3 Option symbol formatting

Tradier uses OCC format:

```
SPY231220P00450000
```

Cursor MUST NOT attempt to build symbols manually; always read from chain data.

---

### 6.4 Order placement requires form-encoded body

`application/x-www-form-urlencoded` — NOT JSON.

Cursor MUST use:

```
new URLSearchParams(bodyObj)
```

---

# 🔗 7. Official Tradier Links (All Stable)

### REST Reference Top-Level

[https://documentation.tradier.com/brokerage-api](https://documentation.tradier.com/brokerage-api)

### Quotes

[https://documentation.tradier.com/brokerage-api/markets/get-quotes](https://documentation.tradier.com/brokerage-api/markets/get-quotes)

### Option Chains

[https://documentation.tradier.com/brokerage-api/markets/get-options-chains](https://documentation.tradier.com/brokerage-api/markets/get-options-chains)

### Place Orders

[https://documentation.tradier.com/brokerage-api/trading/place-order](https://documentation.tradier.com/brokerage-api/trading/place-order)

### Get Order

[https://documentation.tradier.com/brokerage-api/trading/get-order](https://documentation.tradier.com/brokerage-api/trading/get-order)

### Positions

[https://documentation.tradier.com/brokerage-api/accounts/get-positions](https://documentation.tradier.com/brokerage-api/accounts/get-positions)

Cursor MUST refer to these links when implementing.

---

# 🎯 8. Final Directive for Cursor

### **“Use EXACTLY the endpoints listed.

Follow EXACT mappings.
Do not add endpoints.
When uncertain — ask.”**

This document must be used in combination with:

* `/docs/system-interfaces.md`
* `/docs/broker-rules.md`
* `/docs/architecture.md`
* `/docs/cursor-implementation-brief.md`

This is the complete and final guide for the Gekkoworks x Tradier integration.

