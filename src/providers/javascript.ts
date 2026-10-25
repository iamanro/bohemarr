import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

/** Player transforms run in a bounded WASM heap without Node, filesystem or network bindings. */
export async function evaluatePlayerScript(source: string): Promise<unknown> {
  const quickjs = await getQuickJS();
  return quickjs.evalCode(source, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 1000),
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 512 * 1024,
  });
}
