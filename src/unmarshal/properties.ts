import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call } from "../vmutil";
import { Arena } from "..";

export default function unmarshalProperties(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  target: object | Function,
  unmarshal: (handle: QuickJSHandle) => [unknown, boolean],
  arena?: Arena,
) {
  if (arena?._afterExposed) {
    setTimeout(() => {
      if (handle.alive) {
        handle.dispose();
      }
    }, 0);
  }
  ctx
    .newFunction("", (key, value) => {
      const [keyName] = unmarshal(key);
      if (typeof keyName !== "string" && typeof keyName !== "number" && typeof keyName !== "symbol")
        return;
      const desc = (
        [
          ["value", arena?._afterExposed ? true : true],
          ["get", arena?._afterExposed ? true : true],
          ["set", arena?._afterExposed ? true : true],
          ["configurable", arena?._afterExposed ? true : true],
          ["enumerable", arena?._afterExposed ? true : true],
          ["writable", arena?._afterExposed ? true : true],
        ] as const
      ).reduce<PropertyDescriptor>((desc, [key, unmarshable]) => {
        const h = ctx.getProp(value, key);
        const ty = ctx.typeof(h);

        if (ty === "undefined") return desc;
        if (!unmarshable && ty === "boolean") {
          desc[key] = ctx.dump(ctx.getProp(value, key));
          return desc;
        }

        const [v, alreadyExists] = unmarshal(h);
        if (alreadyExists) {
          h.dispose();
        }
        desc[key] = v;

        return desc;
      }, {});
      Object.defineProperty(target, keyName, desc);
    })
    .consume(fn => {
      call(
        ctx,
        `(o, fn) => {
        const descs = Object.getOwnPropertyDescriptors(o);
        Object.entries(descs).forEach(([k, v]) => fn(k, v));
        Object.getOwnPropertySymbols(descs).forEach(k => fn(k, descs[k]));
      }`,
        undefined,
        handle,
        fn,
      ).dispose();
    });
}
