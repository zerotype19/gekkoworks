import type { Env } from '../env';
import { getRecentProposals, getRecentSystemLogs } from '../db/queries';
import { getStrategyThresholds } from '../core/config';

/**
 * Debug endpoint to show the last 20 scored proposals and why they passed/failed
 * 
 * Returns:
 * - Last 20 proposals from database (these passed all filters)
 * - Recent proposal summaries from system logs showing rejection reasons
 */
export async function handleDebugProposals(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    // Get recent proposals (these are the ones that passed)
    const proposals = await getRecentProposals(env, limit);

    // Get recent system logs for proposal summaries and individual candidate scores
    const systemLogs = await getRecentSystemLogs(env, 500); // Get more logs to find individual scores
    
    // Extract proposal summaries
    const proposalSummaries = systemLogs
      .filter(log => log.message === '[proposals] summary' && log.details)
      .slice(0, 50) // Last 50 proposal cycles
      .map(log => {
        try {
          return JSON.parse(log.details || '{}');
        } catch {
          return null;
        }
      })
      .filter((s): s is any => s !== null);
    
    // Extract individual candidate score results (if logged)
    const candidateScoreResults = systemLogs
      .filter(log => log.message === '[strategy] candidate_score_result')
      .map(log => {
        try {
          // The details might be in the message or details field
          const logText = log.details || log.message || '';
          // Try to extract JSON from the log
          const jsonMatch = logText.match(/\{.*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter((s): s is any => s !== null && s.rawScore != null)
      .slice(0, 50); // Last 50 individual scores

    // Get current strategy thresholds for context
    const thresholds = await getStrategyThresholds(env);
    
    // Aggregate score distribution from all summaries
    const aggregatedHistogram = {
      '0.00-0.50': 0,
      '0.50-0.65': 0,
      '0.65-0.70': 0,
      '0.70-0.85': 0,
      '0.85-1.00': 0,
    };
    
    let totalScoredCandidates = 0;
    let candidates65Plus = 0;
    
    for (const summary of proposalSummaries) {
      const hist = summary.scoreHistogram || {};
      aggregatedHistogram['0.00-0.50'] += hist['0.00-0.50'] || 0;
      aggregatedHistogram['0.50-0.65'] += hist['0.50-0.65'] || 0;
      aggregatedHistogram['0.65-0.70'] += hist['0.65-0.70'] || 0;
      aggregatedHistogram['0.70-0.85'] += hist['0.70-0.85'] || 0;
      aggregatedHistogram['0.85-1.00'] += hist['0.85-1.00'] || 0;
      totalScoredCandidates += summary.scoredCount || 0;
      // Count candidates in 0.65+ buckets
      candidates65Plus += (hist['0.65-0.70'] || 0) + (hist['0.70-0.85'] || 0) + (hist['0.85-1.00'] || 0);
    }
    
    // Also count from individual score results if available
    const individualScores = candidateScoreResults.map(c => c.rawScore).filter((s): s is number => typeof s === 'number');
    const individual65Plus = individualScores.filter(s => s >= 0.65).length;

    // Format proposals with failure analysis
    const formattedProposals = proposals.map(p => {
      // These proposals passed, so they didn't fail
      // But we can show what thresholds they met
      return {
        id: p.id,
        symbol: p.symbol,
        expiration: p.expiration,
        short_strike: p.short_strike,
        long_strike: p.long_strike,
        width: p.width,
        credit_target: p.credit_target,
        score: p.score,
        status: p.status,
        created_at: p.created_at,
        // Component scores
        ivr_score: p.ivr_score,
        vertical_skew_score: p.vertical_skew_score,
        term_structure_score: p.term_structure_score,
        delta_fitness_score: p.delta_fitness_score,
        ev_score: p.ev_score,
        // Why it passed
        passed: true,
        passed_reason: 'MET_ALL_THRESHOLDS',
        min_score_required: thresholds.minScore,
        min_credit_required: p.width * thresholds.minCreditFraction,
        score_above_threshold: p.score >= thresholds.minScore,
        credit_above_threshold: p.credit_target >= (p.width * thresholds.minCreditFraction),
      };
    });

    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        current_thresholds: {
          min_score: thresholds.minScore,
          min_credit_fraction: thresholds.minCreditFraction,
          min_credit_for_width_5: 5 * thresholds.minCreditFraction,
          dte_min: thresholds.minDte,
          dte_max: thresholds.maxDte,
          delta_min: thresholds.minDelta,
          delta_max: thresholds.maxDelta,
        },
        proposals: formattedProposals,
        score_distribution: {
          aggregated_from_summaries: {
            total_scored_candidates: totalScoredCandidates,
            histogram: aggregatedHistogram,
            candidates_65_plus: candidates65Plus,
            candidates_65_plus_percent: totalScoredCandidates > 0 
              ? ((candidates65Plus / totalScoredCandidates) * 100).toFixed(2) + '%'
              : '0%',
          },
          from_individual_scores: individualScores.length > 0 ? {
            total_individual_scores: individualScores.length,
            scores_65_plus: individual65Plus,
            scores_65_plus_percent: ((individual65Plus / individualScores.length) * 100).toFixed(2) + '%',
            min_score: Math.min(...individualScores),
            max_score: Math.max(...individualScores),
            avg_score: (individualScores.reduce((a, b) => a + b, 0) / individualScores.length).toFixed(4),
          } : null,
        },
        recent_summaries: proposalSummaries.slice(0, 20).map((summary, idx) => ({
          index: idx + 1,
          timestamp: systemLogs.find(log => log.message === '[proposals] summary')?.created_at,
          symbols_checked: summary.symbols || [],
          candidate_count: summary.candidateCount || 0,
          scored_count: summary.scoredCount || 0,
          passing_count: summary.passingCount || 0,
          best_score: summary.bestScore,
          min_score_threshold: summary.minScoreThreshold,
          required_credit: summary.requiredCredit,
          filter_rejections: summary.filterRejections || {},
          scoring_rejections: summary.scoringRejections || {},
          score_histogram: summary.scoreHistogram || {},
          reason: summary.reason,
        })),
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

