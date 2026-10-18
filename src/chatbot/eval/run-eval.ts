import { formatEvalReport, runEvaluation } from './eval-runner.js';

async function main(): Promise<void> {
  const isLive = process.argv.includes('--live');
  const report = await runEvaluation({ mode: isLive ? 'live' : 'offline' });
  process.stdout.write(`${formatEvalReport(report)}\n`);
  if (report.failedCases > 0) {
    process.exitCode = 1;
  }
}

void main().catch((err: Error) => {
  process.stderr.write(`Evaluation harness failed: ${err.stack ?? err.message}\n`);
  process.exitCode = 1;
});
