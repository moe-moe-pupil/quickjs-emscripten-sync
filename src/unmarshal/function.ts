import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call, mayConsumeAll } from "../vmutil";

import unmarshalProperties from "./properties";
import { Arena } from "..";

export default function unmarshalFunction(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  /** marshal returns handle and boolean indicates that the handle should be disposed after use */
  marshal: (value: unknown) => [QuickJSHandle, boolean],
  unmarshal: (handle: QuickJSHandle) => [unknown, boolean],
  preUnmarshal: <T>(target: T, handle: QuickJSHandle) => T | undefined,
  arena?: Arena,
): Function | undefined {
  if (ctx.typeof(handle) !== "function") return;

  const raw = function (this: any, ...args: any[]) {
    return mayConsumeAll(
      [marshal(this), ...args.map(a => marshal(a))],
      (thisHandle, ...argHandles) => {
        if (new.target) {
          const [instance] = unmarshal(
            call(ctx, `(Cls, ...args) => new Cls(...args)`, thisHandle, handle, ...argHandles),
          );
          if(!arena?._afterExposed) {
            Object.defineProperties(this, Object.getOwnPropertyDescriptors(instance));
          }
          return this;
        }

        const resultHandle = ctx.unwrapResult(ctx.callFunction(handle, thisHandle, ...argHandles));

        const [result, alreadyExists] = unmarshal(resultHandle);
        if (alreadyExists) resultHandle.dispose();

        return result;
      },
    );
  };

  const func = preUnmarshal(raw, handle) ?? raw;
  if (arena?._afterExposed) {
    setTimeout(() => {
      arena._map.dispose();
    }, 1000);
  }
  unmarshalProperties(ctx, handle, raw, unmarshal, arena);

  return func;
}
