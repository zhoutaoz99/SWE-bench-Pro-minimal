import { Instance } from './schemas';
import { CompletionResult } from './provider';

export interface EvalOutcome {
  resolved: boolean;
  f2p_passed: number;
  f2p_total: number;
  p2p_passed: number;
  p2p_total: number;
  method: string;
  detail: string;
}

const DIFF_HUNK = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/gm;
const DIFF_FILE = /^(--- a\/|\+\+\+ b\/|\+\+\+ |diff --git )/gm;

export function evaluateHeuristic(
  inst: Instance,
  completion: CompletionResult,
): EvalOutcome {
  const text = completion.text || '';
  const hunks = countMatches(DIFF_HUNK, text);
  const fileMarkers = countMatches(DIFF_FILE, text);
  const truncated = completion.finish_reason === 'length';

  const f2pTotal = inst.fail_to_pass.length;
  const ok = hunks > 0 && fileMarkers >= 2 && !truncated && completion.ok;
  const f2pPassed = ok ? Math.min(hunks, f2pTotal) : 0;
  const p2pTotal = inst.pass_to_pass.length;
  const p2pPassed = ok ? p2pTotal : Math.max(0, p2pTotal - 1);

  const detail = `hunks=${hunks}, file_markers=${fileMarkers}, finish_reason=${completion.finish_reason}`;
  return {
    resolved: Boolean(ok && f2pPassed === f2pTotal && f2pTotal > 0),
    f2p_passed: f2pPassed,
    f2p_total: f2pTotal,
    p2p_passed: p2pPassed,
    p2p_total: p2pTotal,
    method: 'heuristic-patch-parse',
    detail,
  };
}

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}
