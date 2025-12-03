/**
 * SAS v1 Time Utilities
 * 
 * Market hours, DTE calculation, and day-of-week logic.
 * All time calculations must account for ET (Eastern Time).
 */

/**
 * Check if current time is within market hours (9:30 AM to 3:50 PM ET)
 * 
 * Per entry-rules.md:
 * - Trades may ONLY be placed during 9:30:00 AM to 3:50:00 PM ET
 * - Reject entries if pre-market, post-market, or after 3:50 PM
 */
export function isMarketHours(now: Date): boolean {
  // First check if it's a trading day (Monday-Friday, excluding holidays)
  if (!isTradingDay(now)) {
    return false; // Market is closed on weekends and holidays
  }
  
  // Convert to ET (Eastern Time)
  const etTime = toET(now);
  
  const hours = etTime.getUTCHours();
  const minutes = etTime.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  // 9:30 AM ET = 9 * 60 + 30 = 570 minutes
  // 3:50 PM ET = 15 * 60 + 50 = 950 minutes
  const marketOpen = 9 * 60 + 30;  // 9:30 AM
  const marketClose = 15 * 60 + 50; // 3:50 PM
  
  return timeInMinutes >= marketOpen && timeInMinutes < marketClose;
}

/**
 * Check if date is a trading day (Monday-Friday, excluding holidays)
 * 
 * For v1, we only check for weekday. Holiday handling can be added later.
 */
export function isTradingDay(date: Date): boolean {
  const etDate = toET(date);
  const dayOfWeek = etDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
  
  // Monday = 1, Friday = 5
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

/**
 * Calculate Days To Expiration (DTE)
 * 
 * Per system-interfaces.md:
 * export function computeDTE(expiration: string, now: Date): number;
 * 
 * Expiration is in ISO date format (YYYY-MM-DD)
 * Returns number of calendar days until expiration
 */
export function computeDTE(expiration: string, now: Date): number {
  const expirationDate = new Date(expiration + 'T16:00:00Z'); // 4 PM ET expiration
  const nowDate = new Date(now);
  
  // Set both to midnight UTC for day calculation
  const expMidnight = new Date(Date.UTC(
    expirationDate.getUTCFullYear(),
    expirationDate.getUTCMonth(),
    expirationDate.getUTCDate()
  ));
  
  const nowMidnight = new Date(Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate()
  ));
  
  const diffMs = expMidnight.getTime() - nowMidnight.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // Guard against NaN or invalid calculations
  if (Number.isNaN(diffDays) || !Number.isFinite(diffDays)) {
    console.log('[time] computeDTE_nan', JSON.stringify({ 
      expiration, 
      now: now.toISOString(),
      expMidnight: expMidnight.toISOString(),
      nowMidnight: nowMidnight.toISOString(),
      diffMs,
    }));
    return -1; // Return invalid value so filter rejects it
  }
  
  return diffDays;
}

/**
 * Check if DTE is within valid window (30-35 days)
 * 
 * Per strategy-engine.md:
 * Only expirations with 30 ≤ DTE ≤ 35 are allowed
 * 
 * @deprecated Use isDTEInWindowWithThresholds for mode-specific thresholds
 */
export function isDTEInWindow(dte: number): boolean {
  return dte >= 30 && dte <= 35;
}

/**
 * Check if DTE is within valid window with custom thresholds
 */
export function isDTEInWindowWithThresholds(dte: number, minDte: number, maxDte: number): boolean {
  return dte >= minDte && dte <= maxDte;
}

/**
 * Convert a Date to Eastern Time
 * 
 * Handles both EST (UTC-5) and EDT (UTC-4) based on date.
 * For simplicity in v1, we use a fixed offset approach.
 * More sophisticated DST handling can be added if needed.
 */
export function toET(date: Date): Date {
  // Create a date string in ET format
  // ET is UTC-5 (EST) or UTC-4 (EDT)
  // For v1, we'll use a simple approach: check if DST is likely active
  // DST in US: second Sunday in March to first Sunday in November
  
  const utcDate = new Date(date.toISOString());
  const month = utcDate.getUTCMonth(); // 0-11
  const day = utcDate.getUTCDate();
  const dayOfWeek = utcDate.getUTCDay();
  
  // Simple DST check: March-November (rough approximation)
  // More precise: second Sunday of March to first Sunday of November
  let isDST = false;
  if (month > 2 && month < 10) {
    // April through September are definitely DST
    isDST = true;
  } else if (month === 2) {
    // March: after second Sunday
    // Simplified: after day 7
    isDST = day > 7;
  } else if (month === 10) {
    // November: before first Sunday
    // Simplified: before day 7
    isDST = day < 7;
  }
  
  const offsetHours = isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5
  
  // Return a date adjusted for ET offset
  // We'll work in UTC and adjust the hours for display/calculation
  const etDate = new Date(utcDate);
  etDate.setUTCHours(utcDate.getUTCHours() - offsetHours);
  
  return etDate;
}

/**
 * Parse a date string (YYYY-MM-DD) and return it as a Date object representing that date in ET timezone
 * This ensures dates passed as strings are interpreted as ET dates, not UTC
 * Creates the date at noon ET to avoid timezone boundary issues
 */
export function parseETDateString(dateStr: string): Date {
  // Parse as YYYY-MM-DD and create date at noon ET to avoid timezone shifts
  const [year, month, day] = dateStr.split('-').map(Number);
  // Create date at noon ET by creating it at UTC midnight of the date, then converting to ET
  // Since we want noon ET, we create it at 17:00 UTC (which is noon EST) or 16:00 UTC (noon EDT)
  // Use EST (UTC-5) as worst case to avoid boundary issues
  const offsetHours = 5; // EST offset (worst case, DST would be 4)
  const utcDate = new Date(Date.UTC(year, month - 1, day, 12 + offsetHours, 0, 0));
  return utcDate;
}

/**
 * Get the current date in ET timezone as YYYY-MM-DD string
 */
export function getETDateString(date: Date): string {
  const etDate = toET(date);
  const year = etDate.getUTCFullYear();
  const month = String(etDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(etDate.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Check if we're before market open (pre-market)
 */
export function isPreMarket(now: Date): boolean {
  if (!isTradingDay(now)) {
    return true;
  }
  
  const etTime = toET(now);
  const hours = etTime.getUTCHours();
  const minutes = etTime.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  const marketOpen = 9 * 60 + 30; // 9:30 AM
  
  return timeInMinutes < marketOpen;
}

/**
 * Check if we're after market close (post-market)
 */
export function isPostMarket(now: Date): boolean {
  if (!isTradingDay(now)) {
    return true;
  }
  
  const etTime = toET(now);
  const hours = etTime.getUTCHours();
  const minutes = etTime.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  const marketClose = 15 * 60 + 50; // 3:50 PM
  
  return timeInMinutes >= marketClose;
}
