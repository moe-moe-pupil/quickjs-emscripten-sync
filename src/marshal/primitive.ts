import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";
import type { Arena } from "..";

// import { call } from "../vmutil";

export default function marshalPrimitive(
  ctx: QuickJSContext,
  target: unknown,
  arena?: Arena,
): QuickJSHandle | undefined {
  let res: QuickJSHandle | undefined;
  switch (typeof target) {
    case "undefined":
      res = ctx.undefined;
      break;
    case "number":
      res = ctx.newNumber(target);
      break;
    case "string":
      res = ctx.newString(target);
      break;
    case "boolean":
      res = target ? ctx.true : ctx.false;
      break;
    case "object":
      res = target === null ? ctx.null : undefined;
      break;

    // BigInt is not supported by quickjs-emscripten
    // case "bigint":
    //   return call(
    //     ctx,
    //     `s => BigInt(s)`,
    //     undefined,
    //     ctx.newString(target.toString())
    //   );
  }
  if(arena?._afterExposed) {
    setTimeout(() => {
      if(res && res.alive) {
        res.dispose();
      }
    }, 1000);
  }
  return res;
}
