import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call } from "../vmutil";
import { Arena } from "..";

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

  // console.log("marshalFunction", target.name, arena?._afterExposed);
  // Direct function wrapping - minimal overhead
  const raw = ctx.newFunction(target.name, function (...argHandles) {
    // Direct argument conversion without intermediate processing
    const that = unmarshal(this);
    const args = argHandles.map(a => {
      if (arena?._afterExposed) {
        setTimeout(() => {
          if (a.alive) {
            // console.log("dispose args handle");
            a.dispose();
          }
          if (this.alive) {
            this.dispose();
          }
        }, 1000);
      }
      return unmarshal(a);
    });

    // Call the host function directly
    const result = target.apply(that, args);

    // Marshal result back to VM
    const handle = marshal(result);
    if (arena?._afterExposed) {
      setTimeout(() => {
        if (handle.alive) {
          // console.log("dis pose return handle");
          handle.dispose();
        }
        if (raw.alive) {
          // console.log("dispose raw");
          raw.dispose();
        }
      }, 1000);
    }
    return handle;
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

  return raw;
}
