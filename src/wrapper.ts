import type { QuickJSHandle, QuickJSContext } from "quickjs-emscripten";

import { isObject } from "./util";
import { call, isHandleObject, mayConsumeAll } from "./vmutil";

export type SyncMode = "both" | "vm" | "host";

export type Wrapped<T> = T & { __qes_wrapped: never };

export function wrap<T = any>(
  ctx: QuickJSContext,
  target: T,
  proxyKeySymbol: symbol,
  proxyKeySymbolHandle: QuickJSHandle,
  marshal: (target: any) => [QuickJSHandle, boolean],
  syncMode?: (target: T) => SyncMode | undefined,
  wrappable?: (target: unknown) => boolean,
  syncEnabled = true,
): Wrapped<T> | undefined {
  // promise and date cannot be wrapped
  if (
    !isObject(target) ||
    target instanceof Promise ||
    (wrappable && !wrappable(target))
  ) {
    return undefined;
  }

  if (isWrapped(target, proxyKeySymbol)) {
    return target;
  }

  if (!syncEnabled) {
    return target as Wrapped<T>;
  }

  // Directly return the target without wrapping it in a proxy.
  // Since the wrapping is bypassed, we return the target as it is.
  return target as Wrapped<T>; // In this case, this line has minimal effect but aligns with the original function's typing.
}

export function wrapHandle(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  proxyKeySymbol: symbol,
  proxyKeySymbolHandle: QuickJSHandle,
  unmarshal: (handle: QuickJSHandle) => any,
  syncMode?: (target: QuickJSHandle) => SyncMode | undefined,
  wrappable?: (target: QuickJSHandle, ctx: QuickJSContext) => boolean,
  syncEnabled = true,
): [Wrapped<QuickJSHandle> | undefined, boolean] {
  if (!isHandleObject(ctx, handle) || (wrappable && !wrappable(handle, ctx)))
    return [undefined, false];

  if (isHandleWrapped(ctx, handle, proxyKeySymbolHandle)) {
    return [handle, false];
  }

  if (!syncEnabled) {
    return [handle as Wrapped<QuickJSHandle>, false];
  }

  // Since wrapping is bypassed, we return the original handle directly,
  // indicating no wrapping has been applied.
  return [handle, false] as [Wrapped<QuickJSHandle> | undefined, boolean];

}

export function unwrap<T>(obj: T, key: string | symbol): T {
  return isObject(obj) ? ((obj as any)[key] as T) ?? obj : obj;
}

export function unwrapHandle(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: QuickJSHandle,
): [QuickJSHandle, boolean] {
  if (!isHandleWrapped(ctx, handle, key)) return [handle, false];
  return [ctx.getProp(handle, key), true];
}

export function isWrapped<T>(obj: T, key: string | symbol): obj is Wrapped<T> {
  return isObject(obj) && !!(obj as any)[key];
}

export function isHandleWrapped(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: QuickJSHandle,
): handle is Wrapped<QuickJSHandle> {
  return !!ctx.dump(
    call(
      ctx,
      // promise and date cannot be wrapped
      `(a, s) => (a instanceof Promise) || (typeof a === "object" && a !== null || typeof a === "function") && !!a[s]`,
      undefined,
      handle,
      key,
    ),
  );
}
