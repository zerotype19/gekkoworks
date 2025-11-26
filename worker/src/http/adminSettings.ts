import type { Env } from '../env';
import { getSetting, setSetting, getAllSettings } from '../db/queries';

/**
 * Admin endpoint to get all system settings
 */
export async function handleAdminGetSettings(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const settings = await getAllSettings(env);
    
    // Organize settings by category
    const organized: Record<string, Record<string, string>> = {
      trading: {},
      scoring: {},
      risk: {},
      exitRules: {},
      other: {},
    };
    
    for (const setting of settings) {
      const key = setting.key;
      if (key.startsWith('TRADING_MODE') || key.startsWith('AUTO_MODE')) {
        organized.trading[key] = setting.value;
      } else if (key.startsWith('MIN_SCORE')) {
        organized.scoring[key] = setting.value;
      } else if (key.startsWith('MAX_') || key.startsWith('ACCOUNT_')) {
        organized.risk[key] = setting.value;
      } else if (key.startsWith('CLOSE_RULE_')) {
        organized.exitRules[key] = setting.value;
      } else {
        organized.other[key] = setting.value;
      }
    }
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        settings: organized,
        all: Object.fromEntries(settings.map(s => [s.key, s.value])),
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Admin endpoint to update a system setting
 */
export async function handleAdminUpdateSetting(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as { key: string; value: string };
    const { key, value } = body;
    
    if (!key || value === undefined) {
      return new Response(
        JSON.stringify({
          error: 'Missing key or value',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    await setSetting(env, key, value);
    
    // Return updated value
    const updated = await getSetting(env, key);
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        key,
        value: updated,
        success: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

