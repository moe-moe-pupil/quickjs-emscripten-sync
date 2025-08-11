import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call } from "../vmutil";

import marshalProperties from "./properties";
import { Arena } from "..";

export default function marshalObject(
  ctx: QuickJSContext,
  target: unknown,
  marshal: (target: unknown) => QuickJSHandle,
  preMarshal: (target: unknown, handle: QuickJSHandle) => QuickJSHandle | undefined,
  arena?: Arena,
): QuickJSHandle | undefined {
  if (typeof target !== "object" || target === null) return;

  const raw = Array.isArray(target) ? ctx.newArray() : ctx.newObject();
  const handle = preMarshal(target, raw) ?? raw;

  // prototype
  const prototype = Object.getPrototypeOf(target);
  const prototypeHandle =
    prototype && prototype !== Object.prototype && prototype !== Array.prototype
      ? marshal(prototype)
      : undefined;
  if (prototypeHandle) {
    call(ctx, "Object.setPrototypeOf", undefined, handle, prototypeHandle).dispose();
  }

  if (arena?._afterExposed) {
    setTimeout(() => {
      if (raw.alive) {
        raw.dispose();
      }
      if (handle.alive) {
        handle.dispose();
      }
      if (prototypeHandle && prototypeHandle.alive) {
        prototypeHandle.dispose();
      }
    }, 1000);
  }
  // console.log("target", (target as any)._category);
  let finalObj: any = target;

  if ((target as any)._category !== undefined && (target as any)._id !== undefined) {
    finalObj = { _id: (target as any)._id, id: () => (target as any)._id };
    // console.log('simplified', finalObj);
  }

  if (!arena?._afterExposed || (finalObj?._from === 'param')) {
    // console.log(finalObj)
    marshalProperties(ctx, finalObj, raw, marshal);
  }
  return handle;
}
