/**
 * SAS v1 Broker Events HTTP Handler
 * 
 * Read-only endpoint to fetch recent broker activity and system logs.
 */

import type { Env } from '../env';
import { getRecentBrokerEvents, getRecentSystemLogs } from '../db/queries';

export async function handleBrokerEventsRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '100', 10) || 100, 1), 500);

  const events = await getRecentBrokerEvents(env, limit);
  const systemLogs = await getRecentSystemLogs(env, limit);

  return new Response(JSON.stringify({ events, systemLogs }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

