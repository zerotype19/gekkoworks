import type { Env } from '../env';
import type { CandidateMetrics } from '../types';
import { scoreCandidate } from '../core/scoring';
import { computeCandidateMetrics } from '../engine/proposals';

interface DebugScoringRequestBody {
  candidate: any; // RawCandidate shape from proposals engine
  rv_30d?: number;
  iv_30d?: number;
  minCreditFraction?: number;
}

export async function handleDebugScoring(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const bodyText = await request.text();
    const body = (bodyText ? JSON.parse(bodyText) : {}) as DebugScoringRequestBody;

    const { candidate, rv_30d = 0.15, iv_30d = 0.20, minCreditFraction = 0.20 } =
      body;

    if (!candidate) {
      return new Response(
        JSON.stringify(
          { ok: false, error: 'Missing candidate in request body' },
          null,
          2
        ),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      // Best-effort defaults so simple JSON payloads work:
      // 1) Width from strikes (assume bull put: short_strike - long_strike)
      if (
        candidate.width == null &&
        candidate.short_put?.strike != null &&
        candidate.long_put?.strike != null
      ) {
        candidate.width =
          Number(candidate.short_put.strike) - Number(candidate.long_put.strike);
      }

      // 2) Credit from bid/ask (short bid - long ask)
      if (
        candidate.credit == null &&
        candidate.short_put?.bid != null &&
        candidate.long_put?.ask != null
      ) {
        candidate.credit =
          Number(candidate.short_put.bid) - Number(candidate.long_put.ask);
      }

      const metrics: CandidateMetrics = computeCandidateMetrics(
        candidate,
        rv_30d,
        iv_30d
      );
      const result = scoreCandidate(metrics, { minCreditFraction });

      return new Response(
        JSON.stringify({ ok: true, metrics, result }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify(
          {
            ok: false,
            error: err?.message ?? String(err),
          },
          null,
          2
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (error: any) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: error?.message ?? String(error),
        },
        null,
        2
      ),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}


