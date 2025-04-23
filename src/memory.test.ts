import { getQuickJS } from "quickjs-emscripten";
import { describe, test } from "vitest";

import { Arena } from ".";

describe("memory", () => {
  test("memory leak", async () => {
    const ctx = (await getQuickJS()).newContext();
    var taro: any = {
      num: 1,
      id: 'taro',
      nestedDate:[{ date: new Date() }],
    };
    let func: any = {
      addNum: () => {
        taro.num++;
      },
      getNum: () => {
        return taro.num;
      },
      thisEntity: () => {
        return { test: '' };
      },
      setNewDate: () => {
        taro.nestedDate = [{ date: new Date() }];
      },
      getNewDate: () => {
        return taro.nestedDate;
      }
    };
    const arena = new Arena(ctx, {
      isMarshalable: true,
      syncEnabled: false,
    });


    const getMemory = () => {
      const handle = ctx.runtime.computeMemoryUsage();
      const mem = ctx.dump(handle);
      handle.dispose();
      // console.log(ctx.runtime.dumpMemoryUsage());
      return mem;
    };

    arena.expose({
      func: func,
      console,
    });

    const memoryBefore = getMemory().memory_used_size as number;
    for (let i = 0; i < 100; i++) {

      arena.evalCode(`
        {
          let thisEntity = func.thisEntity();
          let func2 = function() {
            func.addNum();
            func.getNum();
            func.setNewDate();
            console.log(func.getNewDate());
          }
          if(thisEntity) {
            func2.bind(thisEntity)();
          } else {
            func2.bind({})();
          }
        }
        `);
    }
    const memoryAfter = getMemory().memory_used_size as number;
    console.log("Allocation increased %d", (memoryAfter - memoryBefore) / 1024 / 1024);

    // expect((memoryAfter - memoryBefore) / 1024).toBe(0);
    console.log(arena)
    arena.dispose();
    ctx.dispose();
  });
});
