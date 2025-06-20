import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { Arena } from "..";

// Function cache to avoid recreating the same function wrappers
const functionCache = new WeakMap<Function, QuickJSHandle>();

export default function marshalFunction(
  ctx: QuickJSContext,
  target: unknown,
  marshal: (target: unknown) => QuickJSHandle,
  unmarshal: (handle: QuickJSHandle) => unknown,
  _preMarshal: (target: unknown, handle: QuickJSHandle) => QuickJSHandle | undefined,
  _preApply?: (target: Function, thisArg: unknown, args: unknown[]) => any,
  arena?: Arena,
): QuickJSHandle | undefined {
  if (typeof target !== "function") return;

  // Check cache first to avoid recreating function wrappers
  if (functionCache.has(target)) {
    const cachedHandle = functionCache.get(target);
    if (cachedHandle && cachedHandle.alive) {
      return cachedHandle;
    } else {
      functionCache.delete(target);
    }
  }

  if ((ctx as any).fnNextId >= 1 << 10) {
    (ctx as any).fnNextId = -(1 << 10);
  }

  // console.log("marshalFunction", target.name, arena?._afterExposed);
  // Direct function wrapping - minimal overhead
  const raw = ctx.newFunction(target.name, function (...argHandles) {
    try {
      // Optimize argument conversion - only unmarshal if needed
      const that = this === ctx.global ? undefined : unmarshal(this);
      const args = argHandles.map(unmarshal);

      // Call the host function directly
      const result = target.apply(that, args);

      // Marshal result back to VM
      const handle = marshal(result);
      
      // Optimize cleanup for afterExposed mode
      if (arena?._afterExposed) {
        // Use requestIdleCallback for non-critical cleanup
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => {
            if (handle.alive) {
              handle.dispose();
            }
          });
        } else {
          // Fallback to setTimeout with longer delay
          setTimeout(() => {
            if (handle.alive) {
              handle.dispose();
            }
          }, 100);
        }
      }
      return handle;
    } catch (error) {
      // Handle errors more efficiently
      console.error('Function execution error:', error);
      return ctx.undefined;
    }
  });

  // Make function constructable if needed (class support)
  // const constructableFunction = raw.consume(handle2 =>
  //   call(
  //     ctx,
  //     `Cls => {
  //       const fn = function(...args) { return Cls.apply(this, args); };
  //       fn.name = Cls.name;
  //       fn.length = Cls.length;
  //       return fn;
  //     }`,
  //     undefined,
  //     handle2,
  //   ),
  // );

  // Cache the function wrapper
  functionCache.set(target, raw);

  return raw;
}
