export type WorkerDispatchMode = 'inline' | 'background';

/** Host deployment switch; absence is the compatibility-preserving inline path. */
export function workerDispatchModeOf(env: Record<string, string | undefined>): WorkerDispatchMode {
  const raw = env['FSHINE_WORKER_DISPATCH_MODE']?.trim() ?? '';
  if (raw === '' || raw === 'inline') return 'inline';
  if (raw === 'background') return 'background';
  throw new Error(`FSHINE_WORKER_DISPATCH_MODE must be inline or background (got ${raw})`);
}
