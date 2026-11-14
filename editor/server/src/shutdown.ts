/** One step of the shutdown: a name for the log, and what to close. */
export interface ShutdownStep {
  name: string;
  close(): Promise<unknown> | unknown;
  /** Overrides the default bound for this step (the HTTP drain legitimately waits longer than a close). */
  maxMs?: number;
}

/** Resolves `"timeout"` after `ms` instead of waiting on a close that never returns. */
function bounded(step: ShutdownStep, ms: number): Promise<"closed" | "timeout" | Error> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    Promise.resolve()
      .then(() => step.close())
      .then(
        () => resolve("closed"),
        (error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => clearTimeout(timer));
  });
}

/** Closes `steps` in order, each bounded: a hung or failing step is reported and abandoned, the rest still run. Returns the exit code (0 only if all closed). */
export async function runShutdown(steps: ShutdownStep[], opts: { stepMs: number; log?: (message: string) => void }): Promise<number> {
  const log = opts.log ?? ((message: string) => console.error(message));
  let code = 0;
  for (const step of steps) {
    const ms = step.maxMs ?? opts.stepMs;
    const outcome = await bounded(step, ms);
    if (outcome === "closed") continue;
    code = 1;
    log(outcome === "timeout" ? `Shutdown: "${step.name}" did not close within ${ms} ms, abandoned.` : `Shutdown: "${step.name}" failed: ${outcome.message}`);
  }
  return code;
}
