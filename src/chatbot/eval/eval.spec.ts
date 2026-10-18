import { EVAL_CASES } from './eval-dataset.js';
import { formatEvalReport, runEvaluation } from './eval-runner.js';

describe('Anti-Hallucination Evaluation Harness', () => {
  it('runs 20-25 test cases across all 5 categories with 100% pass rate', async () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    expect(EVAL_CASES.length).toBeLessThanOrEqual(25);

    const report = await runEvaluation({ mode: 'offline' });
    if (report.failedCases > 0) {
      throw new Error(`Evaluation failed:\n${formatEvalReport(report)}`);
    }

    expect(report.totalCases).toBe(EVAL_CASES.length);
    expect(report.failedCases).toBe(0);
    expect(report.passRate).toBe(100);

    for (const cat of report.byCategory) {
      expect(cat.total).toBeGreaterThan(0);
      expect(cat.passRate).toBe(100);
    }
  });
});
