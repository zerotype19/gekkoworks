import type { Env } from '../env';
import { deleteSetting } from '../db/queries';
import { getTradingMode } from '../core/config';

export async function handleDebugRemoveSymbolWhitelist(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const tradingMode = await getTradingMode(env);
    if (tradingMode !== 'SANDBOX_PAPER') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'This endpoint is only available in SANDBOX_PAPER mode.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await deleteSetting(env, 'PROPOSAL_UNDERLYING_WHITELIST');

    return new Response(
      JSON.stringify({
        success: true,
        message: 'PROPOSAL_UNDERLYING_WHITELIST setting removed. All eligible symbols will now be checked.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

