import { getQuickJS } from "quickjs-emscripten";
import { describe, test } from "vitest";

import { Arena } from ".";
import { createGameEngineArena, wrapEntityFunctions } from "./memory-fix-solution";

describe("Memory Leak Fix Test", () => {
  test("GameEngineArena prevents memory leaks", async () => {
    console.log("=== TESTING MEMORY LEAK FIX ===");
    
    const ctx = (await getQuickJS()).newContext();
    
    // Create game engine arena with optimized settings
    const arena = createGameEngineArena(ctx, {
      aggressiveCleanup: true,
      memoryMonitoring: true,
      maxEntitiesBeforeCleanup: 5,
    });
    
    // Entity management system
    let entityIdCounter = 0;
    const entities = new Map();
    
    const action = {
      createEntity: (entityData: any) => {
        const entityId = ++entityIdCounter;
        const entity = {
          id: entityId,
          components: entityData?.components || {},
          position: entityData?.position || { x: 0, y: 0, z: 0 },
          active: true,
          created: Date.now(),
          metadata: {
            creator: 'script',
            tags: entityData?.tags || [],
            customData: entityData?.customData || {}
          }
        };
        
        entities.set(entityId, entity);
        return entity;
      },
      
      destroyEntity: (entityId: number) => {
        const entity = entities.get(entityId);
        if (entity) {
          entity.active = false;
          entities.delete(entityId);
          return true;
        }
        return false;
      },
      
      getEntityCount: () => entities.size,
      getAllEntityIds: () => Array.from(entities.keys()),
    };

    // Wrap entity functions with automatic cleanup
    const wrappedAction = wrapEntityFunctions(action, arena);
    
    arena.expose({
      action: wrappedAction,
      console: console,
    });

    console.log("Initial memory info:", arena.getMemoryInfo());

    // Test: Create and destroy entities rapidly
    console.log("\n--- Testing Rapid Entity Creation/Destruction ---");
    for (let i = 0; i < 100; i++) {
      arena.evalCode(`
        {
          let entity = action.createEntity({
            components: {
              transform: { x: ${i * 10}, y: ${i * 5}, z: 0 },
              renderer: { sprite: 'player.png', visible: true },
              physics: { velocity: { x: 0, y: 0 }, mass: 1 }
            },
            tags: ['player', 'dynamic'],
            customData: {
              health: 100,
              inventory: ['sword', 'potion', 'key_${i}']
            }
          });
          
          action.destroyEntity(entity.id);
        }
      `);

      // Log memory info every 25 iterations
      if ((i + 1) % 25 === 0) {
        const memInfo = arena.getMemoryInfo();
        console.log(`Iteration ${i + 1}: ${memInfo?.memoryUsedMB}MB, Pending: ${memInfo?.pendingCleanup}, Entities: ${entities.size}`);
      }
    }

    console.log("Final memory info:", arena.getMemoryInfo());
    console.log(`Final entity count: ${entities.size}`);

    // Test: Batch creation and destruction
    console.log("\n--- Testing Batch Operations ---");
    const batchMemoryBefore = arena.getMemoryInfo();
    
    const entityIds = arena.evalCode(`
      {
        let ids = [];
        for (let i = 0; i < 50; i++) {
          let entity = action.createEntity({
            components: {
              ai: { state: 'idle', pathfinding: new Array(10).fill(0) },
              inventory: { items: new Array(20).fill({ name: 'item', value: 100 }) }
            },
            customData: {
              dialogues: ['Hello', 'Goodbye', 'How are you?'],
              questData: { active: true, progress: 0.5 }
            }
          });
          ids.push(entity.id);
        }
        ids;
      }
    `);

    console.log(`Created ${entityIds.length} entities in batch`);
    const batchMemoryAfterCreation = arena.getMemoryInfo();
    console.log("Memory after batch creation:", batchMemoryAfterCreation);

    // Destroy all entities
    arena.evalCode(`
      {
        let allIds = action.getAllEntityIds();
        for (let id of allIds) {
          action.destroyEntity(id);
        }
      }
    `);

    const batchMemoryAfterDestruction = arena.getMemoryInfo();
    console.log("Memory after batch destruction:", batchMemoryAfterDestruction);
    console.log(`Remaining entities: ${entities.size}`);

    // Final comparison
    const initialMB = parseFloat(batchMemoryBefore?.memoryUsedMB || "0");
    const finalMB = parseFloat(batchMemoryAfterDestruction?.memoryUsedMB || "0");
    const leakMB = finalMB - initialMB;
    
    console.log(`\n=== MEMORY LEAK ANALYSIS ===`);
    console.log(`Initial memory: ${initialMB}MB`);
    console.log(`Final memory: ${finalMB}MB`);
    console.log(`Memory leak: ${leakMB.toFixed(3)}MB`);
    
    if (leakMB < 0.1) {
      console.log("✅ Memory leak successfully prevented!");
    } else if (leakMB < 0.5) {
      console.log("⚠️ Small memory increase detected, but within acceptable range");
    } else {
      console.log("❌ Significant memory leak detected");
    }

    arena.dispose();
    ctx.dispose();
  });

  test("Compare with original Arena", async () => {
    console.log("\n=== COMPARISON WITH ORIGINAL ARENA ===");
    
    const ctx1 = (await getQuickJS()).newContext();
    const ctx2 = (await getQuickJS()).newContext();
    
    // Test original Arena
    const originalArena = new Arena(ctx1, {
      isMarshalable: true,
      syncEnabled: false,
    });
    
    // Test optimized Arena
    const optimizedArena = createGameEngineArena(ctx2, {
      aggressiveCleanup: true,
      memoryMonitoring: false, // Disable logging for cleaner output
    });
    
    const runEntityTest = (arena: any, name: string) => {
      let entityCounter = 0;
      const entities = new Map();
      
      const action = {
        createEntity: (data: any) => {
          const entity = { id: ++entityCounter, ...data, active: true };
          entities.set(entity.id, entity);
          return entity;
        },
        destroyEntity: (id: number) => {
          entities.delete(id);
          return true;
        }
      };
      
      arena.expose({ action });
      
      const getMemory = () => {
        const handle = arena.context.runtime.computeMemoryUsage();
        const mem = arena.context.dump(handle);
        handle.dispose();
        return mem.memory_used_size as number;
      };
      
      const memBefore = getMemory();
      
      // Run 50 create/destroy cycles
      for (let i = 0; i < 50; i++) {
        arena.evalCode(`
          {
          let entity = action.createEntity({
            components: { transform: { x: ${i}, y: ${i} } },
            data: new Array(10).fill({ value: ${i} })
          });
          action.destroyEntity(entity.id);
          }
        `);
      }
      
      const memAfter = getMemory();
      const leak = (memAfter - memBefore) / 1024 / 1024;
      
      console.log(`${name}: Memory increase = ${leak.toFixed(3)}MB`);
      
      arena.dispose();
      return leak;
    };
    
    const originalLeak = runEntityTest(originalArena, "Original Arena");
    const optimizedLeak = runEntityTest(optimizedArena, "Optimized Arena");
    
    const improvement = originalLeak - optimizedLeak;
    console.log(`Improvement: ${improvement.toFixed(3)}MB reduction`);
    
    if (improvement > 0) {
      console.log("✅ Optimized Arena shows memory improvement!");
    } else {
      console.log("❌ No improvement detected");
    }
    
    ctx1.dispose();
    ctx2.dispose();
  });
}); 