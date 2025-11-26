# Tradier API Credentials

**⚠️ DO NOT COMMIT THIS FILE TO GIT**

This file is for reference only. Credentials are stored as Cloudflare secrets.

## Current Configuration

**Environment:** Sandbox (Paper Trading)
- **API Endpoint:** `sandbox.tradier.com`
- **Account ID:** `VA13978285`
- **API Token:** Set via `wrangler secret put TRADIER_API_TOKEN`
- **TRADIER_ENV:** `sandbox` (in `wrangler.toml`)

## Production Credentials (Stored for Reference)

**Environment:** Live Trading
- **API Endpoint:** `api.tradier.com`
- **API Token:** `wDp7ad3HAPeLCYPnjmzU6dQFM9kh`
- **Account ID:** (Use your live account ID when switching)

## Switching to Production

When ready to switch from sandbox to live trading:

1. **Update wrangler.toml:**
   ```toml
   [vars]
   TRADIER_ENV = "live"  # Change from "sandbox" to "live"
   ```

2. **Update API Token:**
   ```bash
   wrangler secret put TRADIER_API_TOKEN
   # Paste: wDp7ad3HAPeLCYPnjmzU6dQFM9kh
   ```

3. **Update Account ID:**
   ```bash
   wrangler secret put TRADIER_ACCOUNT_ID
   # Paste your live account ID
   ```

4. **Deploy:**
   ```bash
   wrangler deploy
   ```

5. **Update Trading Mode in D1:**
   ```sql
   UPDATE settings SET value = 'LIVE' WHERE key = 'TRADING_MODE';
   ```
   (Only after thorough testing in SANDBOX_PAPER mode!)

## Switching Back to Sandbox

1. **Update wrangler.toml:**
   ```toml
   [vars]
   TRADIER_ENV = "sandbox"
   ```

2. **Update API Token:**
   ```bash
   wrangler secret put TRADIER_API_TOKEN
   # Paste: kj2lO252cKKXEJC1xdxql8BzW2JF
   ```

3. **Update Account ID:**
   ```bash
   wrangler secret put TRADIER_ACCOUNT_ID
   # Paste: VA13978285
   ```

4. **Deploy:**
   ```bash
   wrangler deploy
   ```

## Security Notes

- All credentials are stored as Cloudflare secrets (encrypted)
- Never commit API keys or account IDs to git
- This file should be in `.gitignore`
- Rotate keys if they are ever exposed

