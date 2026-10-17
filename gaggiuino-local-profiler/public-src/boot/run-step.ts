// #1615: one boot step = one independent piece of start-up wiring. A step
// that throws (e.g. a markup change dropped an element it looks up with `!`)
// is logged and skipped instead of aborting every step after it, which is
// what the single DOMContentLoaded handler used to do.
export function runStep(name: string, step: () => void): void {
  try {
    step();
  } catch (e) {
    console.error(`[GLP] boot step "${name}" failed:`, e);
  }
}

// #1615: the data boot chain as tasks with explicit dependencies, instead of
// one promise chain where any rejection silently skipped everything after it.
// `requires`: prerequisites that must succeed; if one failed or was skipped,
// this task is skipped too (and logged), since it would only run on missing
// state. `after`: ordering only; the task waits for these to finish but runs
// whatever their outcome. Tasks start in declaration order once their
// dependencies have settled, so independent branches still run in parallel
// and in the same order as before. A task may only depend on tasks declared
// before it.
export interface BootTask {
  name: string;
  requires?: readonly string[];
  after?: readonly string[];
  run: () => unknown;
}

export type BootOutcome = 'ok' | 'failed' | 'skipped';

export async function runBootTasks(tasks: readonly BootTask[]): Promise<Map<string, BootOutcome>> {
  const pending = new Map<string, Promise<BootOutcome>>();
  const settle = (name: string, of: string): Promise<BootOutcome> => {
    const p = pending.get(name);
    if (!p) throw new Error(`boot task "${of}" depends on "${name}", which is not declared before it`);
    return p;
  };
  for (const task of tasks) {
    const required = task.requires ?? [];
    const deps = [...required, ...(task.after ?? [])].map(name => settle(name, task.name));
    pending.set(task.name, (async (): Promise<BootOutcome> => {
      // A task without dependencies starts synchronously, like the first
      // call of the old chain did. Otherwise one await over all of them, so
      // tasks waiting on the same dependency resume in declaration order.
      if (deps.length) {
        const outcomes = await Promise.all(deps);
        const missing = required.find((_name, i) => outcomes[i] !== 'ok');
        if (missing !== undefined) {
          console.error(`[GLP] boot step "${task.name}" skipped: "${missing}" did not complete`);
          return 'skipped';
        }
      }
      try {
        await task.run();
        return 'ok';
      } catch (e) {
        console.error(`[GLP] boot step "${task.name}" failed:`, e);
        return 'failed';
      }
    })());
  }
  const names = [...pending.keys()];
  const outcomes = await Promise.all(pending.values());
  return new Map(names.map((name, i) => [name, outcomes[i] ?? 'failed']));
}
