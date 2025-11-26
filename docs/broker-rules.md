Love it. Broker time. This is where we pin Tradier to the wall so Cursor *cannot* be fuzzy about how orders, quotes, and chains are handled.

What follows is the **Broker Rules Bible**. It’s written specifically for Tradier, but in a way that still maps cleanly to an abstract `BrokerClient` if you ever need that later.

---

# 📘 `/docs/broker-rules.md`

**SAS Broker Integration – Tradier v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines exactly how SAS interacts with the broker (Tradier) at the API level.

It governs:

* Base URLs
* Authentication
* Required endpoints
* Payload shapes
* Error handling
* Timeouts and retries
* Data integrity rules

Cursor MUST implement broker calls exactly as specified.
Cursor MUST NOT change endpoints, payload formats, or behaviors unless this file is revised.

---

## 1. Broker & Environment

### 1.1 Broker

* Broker: **Tradier**
* Mode for v1: **Paper / Sandbox** only

### 1.2 Environment Variables

The Worker must be configured with:

* `TRADIER_ENV` – `"sandbox"` or `"live"`
* `TRADIER_API_TOKEN` – bearer token for the selected environment
* `TRADIER_ACCOUNT_ID` – account id for the selected environment

### 1.3 Base URLs

* If `TRADIER_ENV == "sandbox"` →
  `BASE_URL = "https://sandbox.tradier.com/v1"`

* If `TRADIER_ENV == "live"` →
  `BASE_URL = "https://api.tradier.com/v1"`

Cursor must compute base URL from `TRADIER_ENV` only, no guessing.

---

## 2. HTTP & Auth Rules

All calls:

* HTTP method: `GET` or `POST` as specified per endpoint
* Auth: header `"Authorization: Bearer {TRADIER_API_TOKEN}"`
* Common headers:

  * `"Accept": "application/json"`
  * `"Content-Type": "application/x-www-form-urlencoded"` for POSTs with body
  * `"Content-Type": "application/json"` for plain GETs

Timeout rules:

* Default timeout: **10 seconds** for most operations
* Positions sync: **10 seconds**
* Orders sync: **15 seconds** (bulk operations)
* If timeout occurs → automatic retry (up to 2 retries with exponential backoff)
* If all retries fail → treat as error and follow error handling rules.

No websockets.
No streaming.
All interactions are stateless HTTP.

---

## 3. Required Endpoints

SAS v1 needs **only** these endpoints:

1. **Quotes** – `/markets/quotes`
2. **Option Chains** – `/markets/options/chains`
3. **Order Placement** – `/accounts/{account_id}/orders`
4. **Order Status** – `/accounts/{account_id}/orders/{order_id}`
5. **Positions** – `/accounts/{account_id}/positions`

Cursor MUST NOT use any other Tradier endpoints in v1.

---

## 4. Quotes Endpoint

### 4.1 Path

`GET {BASE_URL}/markets/quotes`

### 4.2 Query Params

* `symbols` – comma-separated symbols (e.g., `SPY`)
* `greeks` – `"true"` or `"false"` (for underlying we can set `"false"`)

Example:

`/markets/quotes?symbols=SPY&greeks=false`

### 4.3 Response Handling

Expected JSON structure:

```jsonc
{
  "quotes": {
    "quote": { ... }        // object or array
  }
}
```

SAS must normalize:

* If `quote` is an array → use as-is
* If `quote` is an object → wrap in array `[quote]`

Required fields for SPY:

* `symbol`
* `last`
* `bid`
* `ask`
* `change_percentage` (or can be recomputed from `change` / `previous_close`)

If any required field is missing or null → treat as data failure and abort that cycle (no proposal, consider emergency behavior if monitoring).

---

## 5. Option Chains Endpoint

### 5.1 Path

`GET {BASE_URL}/markets/options/chains`

### 5.2 Query Params

* `symbol` – underlying symbol (e.g. `SPY`)
* `expiration` – expiration date in `YYYY-MM-DD`
* `greeks` – `"true"`

Example:

`/markets/options/chains?symbol=SPY&expiration=2025-02-21&greeks=true`

### 5.3 Response Handling

Expected structure:

```jsonc
{
  "options": {
    "option": [ ... ]  // or single object
  }
}
```

Normalize:

* If `option` is array → use
* If `option` is object → wrap in array `[option]`

For each option we require:

* `symbol` – OCC option symbol (used as `option_symbol` in orders)
* `strike` – numeric strike
* `bid`
* `ask`
* `last` (optional but helpful)
* `type` – `"put"` or `"call"`
* `expiration_date`
* `delta` – from greeks
* `implied_volatility` – from greeks

If any of these mandatory fields is missing → that **option leg** cannot be used for candidates.

SAS must treat missing fields as hard invalidation of the leg; no interpolation.

---

## 6. Order Placement (Multi-Leg Credit Spread)

### 6.1 Path

`POST {BASE_URL}/accounts/{TRADIER_ACCOUNT_ID}/orders`

### 6.2 Content-Type

`application/x-www-form-urlencoded`

### 6.3 Body Parameters – v1

We only send **multileg option orders** for SPY bull put spreads (entry) and their closing counterparts.

Required body fields:

* `class` – `"multileg"`
* `symbol` – `"SPY"`
* `type` – `"limit"`
* `duration` – `"day"`
* `price` – numeric (stringified) – the **limit_price** per our execution rules
* `side[0]` – `"sell_to_open"` for entry, `"buy_to_close"` for exit
* `quantity[0]` – `"1"`
* `option_symbol[0]` – OCC symbol of short put
* `side[1]` – `"buy_to_open"` for entry, `"sell_to_close"` for exit
* `quantity[1]` – `"1"`
* `option_symbol[1]` – OCC symbol of long put
* `tag` – `"SAS_ENTRY"` or `"SAS_EXIT"` (for logging/tracing)

No other legs.
No partial quantity differences.
No other `class` values.
No market orders.

### 6.4 Response Handling

Tradier returns an order response that includes an order id (field name may be `id` or inside a nested structure; Cursor must parse the official field and store as `broker_order_id`).

Rule:

* If HTTP status >= 400 → treat as HARD error.
* If response JSON missing expected order id → treat as ERROR.
* On error: mark trade as `CANCELLED` and never auto-retry entry (per execution rules).

Order id must be persisted and used ONLY for:

* Status checks
* Logging
* Mapping fills to internal trades

---

## 7. Order Status

### 7.1 Path

`GET {BASE_URL}/accounts/{TRADIER_ACCOUNT_ID}/orders/{order_id}`

### 7.2 Purpose

Used for:

* After entry placement → determine fill status and average fill price
* After exit placement → determine closure and final PnL

### 7.3 Required Fields

From the order response, we need:

* `status` – e.g., `"filled"`, `"open"`, `"cancelled"`
* `avg_fill_price` or equivalent (average fill price per spread or leg basis)
* If per-leg fills exist, Cursor must compute net credit/debit exactly.

If `status` indicates filled and `avg_fill_price` is missing → treat as data error and escalate to emergency handling (never invent a price).

### 7.4 Polling Rules

* Poll every 2 seconds while in ENTRY or CLOSING_PENDING state
* Stop once:

  * status is filled → success
  * or cancel confirmed → failure, record as such

---

## 8. Positions Endpoint

### 8.1 Path

`GET {BASE_URL}/accounts/{TRADIER_ACCOUNT_ID}/positions`

### 8.2 Purpose

Used for:

* Reconciliation
* Sanity checks that our internal `OPEN` trades match Tradier’s view
* Detecting orphaned positions

### 8.3 Rules

* SAS should NOT depend on this for core PnL or exit decisions (that’s from quotes + chains).
* But if positions API shows a spread we think is closed (or vice versa), that is a **data integrity warning** and may trigger emergency behavior.

---

## 9. Error Handling Rules

For ANY broker call:

### 9.1 Detectable Errors

* HTTP status ≥ 400
* Timeout (no response within 1 second)
* JSON parse failures
* Missing required fields
* Unknown response structure

### 9.2 Behavior on Error

* For **entry**: mark attempt as `CANCELLED` with reason `"broker_error"`, do NOT retry.
* For **exit**: flag `EMERGENCY_EXIT_PENDING` and attempt emergency close with conservative pricing.
* Log full response body (redact secrets).

### 9.3 Retry Policy

For v1:

* No automatic retry for **entry**.
* For **exit**: one retry allowed per exit rules; if broker error hits on both attempts → escalate to HARD_STOP.

Cursor must NOT implement exponential backoff or background retry loops in v1.

---

## 10. Rate Limiting & Throttling

SAS v1 is low-volume:

* 1 symbol
* 1 position max
* Monitoring loop every 2 seconds

Even with that, we must respect conservative behavior:

* Do not query option chains more than **once per cycle** per expiration.
* Do not call order status more than once per 2 seconds per active order.
* Do not call positions more than once per minute, and only for reconciliation.

If Tradier returns rate-limit errors, treat as:

* System-level risk issue
* Trigger **Emergency Exit** for any open positions
* Enter `RISK_STATE = "BROKER_RATE_LIMITED"` and forbid new entries for the rest of the day.

---

## 11. Data Integrity Rules

Broker data is considered **authoritative**, but **not infallible**.

SAS must:

* Never overwrite internal trade state with nonsensical data (e.g., negative prices, NaNs)
* Validate:

  * `bid ≤ ask`
  * `prices ≥ 0`
  * DTE non-negative
* If broker data fails validation → treat as data corruption → emergency exit path.

No smoothing.
No interpolation.
No assumptions.

---

## 12. Broker Abstraction (Optional v1 Implementation Detail)

Even though v1 uses only Tradier, the `BrokerClient` interface should be defined, with methods:

* `getUnderlyingQuote(symbol)`
* `getOptionChain(symbol, expiration)`
* `placeSpreadOrder(entryOrExitPayload)`
* `getOrder(orderId)`
* `getPositions()`

But:

* Only `TradierBrokerClient` is implemented in v1.
* No IBKR, no Alpaca, no anything else.
* Cursor must not generate unused broker implementations.

---

## 13. Logging & Auditing

Every broker call must log:

* Endpoint and HTTP method
* Request parameters (excluding secrets)
* Response status and key fields
* Errors and error messages

Logs must make it possible to reconstruct:

* Each entry
* Each exit
* Each failure
* Each emergency decision tied to broker behavior

---

## 14. Forbidden Broker Behaviors

Cursor MUST NEVER:

* Change base URLs based on anything other than `TRADIER_ENV`
* Add extra endpoints or features “for convenience”
* Switch to market orders
* Use unsupported order classes or side codes
* Infer fills without confirmation
* Retry entries on its own
* Mask or swallow errors silently
* Modify quantity or leg structure
* Collapse multi-leg orders into leg-by-leg orders (v1 SPECIFICALLY requires atomic multileg orders)

---

### END OF BROKER RULES DOCUMENT

This file is the contract between SAS and Tradier.
If the broker integration differs from this, the system is invalid.
