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
