/**
 * SAS v1 Environment Configuration
 * 
 * Defines the Worker Env type that all modules use.
 * This is the canonical environment shape per system-interfaces.md
 */

export interface Env {
  DB: D1Database;
  SYNC_CACHE: KVNamespace;

  TRADIER_ENV: 'sandbox' | 'live';
  TRADIER_API_TOKEN: string;
  TRADIER_ACCOUNT_ID: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;

  // Optional: logging verbosity flags, etc.
  // LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
}

