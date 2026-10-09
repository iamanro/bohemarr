import { spawn } from 'node:child_process';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

/** A process that ran and exited unsuccessfully, with what it wrote. */
export class ProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stdout: string, stderr: string) {
    super(`${command} exited with code ${exitCode ?? 'null'}: ${stderr.trim()}`);
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Runs an external process to completion, streaming stdout chunks to `onStdout` (used for
 * machine-readable progress parsing). Rejects with a `ProcessExitError` on non-zero exit,
 * and rejects with the abort reason (never resolves) if `signal` fires before the process exits.
 */
export async function runProcess(
  command: string, args: string[], signal: AbortSignal, onStdout?: (chunk: string) => void, env?: NodeJS.ProcessEnv,
): Promise<string> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderrTail = '';
  let settled = false;
  let killer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    child.kill('SIGTERM');
    killer = setNodeTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 3000);
    killer.unref();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    onStdout?.(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });
  child.on('error', (error: Error) => {
    settled = true;
    signal.removeEventListener('abort', onAbort);
    if (killer) clearNodeTimeout(killer);
    reject(new Error(`Failed to start ${command}: ${error.message}`));
  });
  child.on('close', (code: number | null) => {
    settled = true;
    signal.removeEventListener('abort', onAbort);
    if (killer) clearNodeTimeout(killer);
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    if (code !== 0) {
      reject(new ProcessExitError(command, code, stdout, stderrTail));
      return;
    }
    resolve(stdout);
  });
  return promise;
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // `timers/promises`' `setTimeout` rejects with a generic AbortError (the reason only
    // reachable via `.cause`) rather than the reason itself; callers rely on the reason directly.
    throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
  }
}
