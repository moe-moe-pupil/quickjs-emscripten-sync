import type {
  Disposable,
  QuickJSContext,
  QuickJSHandle,
  QuickJSDeferredPromise,
} from "quickjs-emscripten";

export function fn(
  ctx: QuickJSContext,
  code: string,
): ((thisArg: QuickJSHandle | undefined, ...args: QuickJSHandle[]) => QuickJSHandle) & Disposable {
  const handle = ctx.unwrapResult(ctx.evalCode(code));
  const f = (thisArg: QuickJSHandle | undefined, ...args: QuickJSHandle[]): any => {
    return ctx.unwrapResult(ctx.callFunction(handle, thisArg ?? ctx.undefined, ...args));
  };
  f.dispose = () => handle.dispose();
  f.alive = true;
  Object.defineProperty(f, "alive", {
    get: () => handle.alive,
  });
  return f;
}

export function call(
  ctx: QuickJSContext,
  code: string,
  thisArg?: QuickJSHandle,
  ...args: QuickJSHandle[]
): QuickJSHandle {
  const f = fn(ctx, code);
  try {
    return f(thisArg, ...args);
  } finally {
    f.dispose();
  }
}

export function eq(ctx: QuickJSContext, a: QuickJSHandle, b: QuickJSHandle): boolean {
  return ctx.dump(call(ctx, "Object.is", undefined, a, b));
}

export function instanceOf(ctx: QuickJSContext, a: QuickJSHandle, b: QuickJSHandle): boolean {
  return ctx.dump(call(ctx, "(a, b) => a instanceof b", undefined, a, b));
}

export function isHandleObject(ctx: QuickJSContext, h: QuickJSHandle): boolean {
  return ctx.dump(
    call(ctx, `a => typeof a === "object" && a !== null || typeof a === "function"`, undefined, h),
  );
}

export function json(ctx: QuickJSContext, target: any, circularHandling: 'replace' | 'ignore' | 'error' = 'replace'): QuickJSHandle {
  let json: string;
  try {
    json = JSON.stringify(target, createCircularReplacer(circularHandling));
  } catch (error) {
    if (circularHandling === 'error') {
      throw error; // Re-throw to preserve original behavior if requested
    }
    // If JSON.stringify still fails, return a safe fallback
    json = JSON.stringify({
      __error: "CircularReference",
      __type: typeof target,
      __constructor: target?.constructor?.name || "Unknown"
    });
  }
  if (!json) return ctx.undefined;
  return call(ctx, `JSON.parse`, undefined, ctx.newString(json));
}

/**
 * Creates a replacer function that handles circular references
 */
function createCircularReplacer(handling: 'replace' | 'ignore' | 'error' = 'replace') {
  const seen = new WeakSet();
  return (key: string, value: any) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        // Circular reference found
        switch (handling) {
          case 'ignore':
            return undefined; // Remove circular references
          case 'error':
            throw new Error(`Converting circular structure to JSON at key: ${key}`);
          case 'replace':
          default:
            return {
              __circular: true,
              __type: typeof value,
              __constructor: value.constructor?.name || "Object",
              __keys: Object.keys(value).slice(0, 5) // Show first 5 keys for debugging
            };
        }
      }
      seen.add(value);
    }
    return value;
  };
}

export function consumeAll<T extends QuickJSHandle[], K>(handles: T, cb: (handles: T) => K): K {
  try {
    return cb(handles);
  } finally {
    for (const h of handles) {
      if (h.alive) h.dispose();
    }
  }
}

export function mayConsume<T>(
  [handle, shouldBeDisposed]: [QuickJSHandle, boolean],
  fn: (h: QuickJSHandle) => T,
) {
  try {
    return fn(handle);
  } finally {
    if (shouldBeDisposed) {
      handle.dispose();
    }
  }
}

export function mayConsumeAll<T, H extends QuickJSHandle[]>(
  handles: { [P in keyof H]: [QuickJSHandle, boolean] },
  fn: (...args: H) => T,
) {
  try {
    return fn(...(handles.map(h => h[0]) as H));
  } finally {
    for (const [handle, shouldBeDisposed] of handles) {
      if (shouldBeDisposed) {
        handle.dispose();
      }
    }
  }
}

function isQuickJSDeferredPromise(d: Disposable): d is QuickJSDeferredPromise {
  return "handle" in d;
}

export function handleFrom(d: QuickJSDeferredPromise | QuickJSHandle): QuickJSHandle {
  return isQuickJSDeferredPromise(d) ? d.handle : d;
}
