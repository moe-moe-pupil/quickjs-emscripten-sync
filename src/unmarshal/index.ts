import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import unmarshalCustom, { defaultCustom } from "./custom";
import unmarshalFunction from "./function";
import unmarshalObject from "./object";
import unmarshalPrimitive from "./primitive";
import unmarshalPromise from "./promise";
import { Arena } from "..";

export type Options = {
  ctx: QuickJSContext;
  /** marshal returns handle and boolean indicates that the handle should be disposed after use */
  marshal: (target: unknown) => [QuickJSHandle, boolean];
  find: (handle: QuickJSHandle) => unknown | undefined;
  pre: <T = unknown>(target: T, handle: QuickJSHandle) => T | undefined;
  custom?: Iterable<(obj: QuickJSHandle, ctx: QuickJSContext) => any>;
  arena?: Arena;
};

export function unmarshal(handle: QuickJSHandle, options: Options): any {
  if(options.arena?._afterExposed) {
    return;
  }
  const [result] = unmarshalInner(handle, options);
  return result;
}

function unmarshalInner(handle: QuickJSHandle, options: Options, arena?: Arena): [any, boolean] {
  const { ctx, marshal, find, pre } = options;

  {
    const [target, ok] = unmarshalPrimitive(ctx, handle);
    if (ok) return [target, false];
  }

  {
    const target = find(handle);
    if (target) {
      return [target, true];
    }
  }

  const unmarshal2 = (h: QuickJSHandle) => unmarshalInner(h, options, arena);

  const result =
    unmarshalCustom(ctx, handle, pre, [...defaultCustom, ...(options.custom ?? [])]) ??
    unmarshalPromise(ctx, handle, marshal, pre) ??
    unmarshalFunction(ctx, handle, marshal, unmarshal2, pre, arena) ??
    unmarshalObject(ctx, handle, unmarshal2, pre, arena);

  return [result, false];
}

export default unmarshal;
