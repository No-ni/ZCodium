/** 与当前e2e-reporting-summary的skip合同一致；旧无status的空错误记录只按兼容分支标记。 */
export function classifyResult(result) {
  const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
  if (status === 'skipped' || status === 'pending' || result.skipped === true) return { outcome: 'skipped', classificationSource: 'explicit-skip-status-or-flag' };
  if (!result.passed && !status && !result.error && !result.errorStack && (!result.errorCategory || result.errorCategory === 'unknown')) return { outcome: 'skipped', classificationSource: 'current-reporter-legacy-empty-error-compatibility' };
  return { outcome: result.passed ? 'passed' : 'failed', classificationSource: 'passed-boolean-without-skip' };
}

if (process.argv.includes('--static-check')) {
  const probes = [
    [{ passed: false, status: 'pending' }, 'skipped'],
    [{ passed: false, status: 'skipped' }, 'skipped'],
    [{ passed: false, skipped: true }, 'skipped'],
    [{ passed: false, errorCategory: 'unknown' }, 'skipped'],
    [{ passed: false, status: 'failed' }, 'failed'],
    [{ passed: false, error: 'assertion failed' }, 'failed'],
    [{ passed: true }, 'passed'],
  ];
  if (probes.some(([result, expected]) => classifyResult(result).outcome !== expected)) throw new Error('E2E result classification guard failed');
  console.log(JSON.stringify({ evidenceKind: 'Pure in-memory QA result classification guards; no UI, hook, build, FS or product test', checks: probes.length, passed: probes.length }));
}
