import { QuickJSContext } from "quickjs-emscripten";
import { Arena } from ".";

export interface GameEngineArenaOptions {
  aggressiveCleanup?: boolean;
  memoryMonitoring?: boolean;
  maxEntitiesBeforeCleanup?: number;
}

export function createGameEngineArena(ctx: QuickJSContext, options: GameEngineArenaOptions = {}) {
  // Create Arena with syncEnabled: true to prevent memory leaks
  const arena = new Arena(ctx, {
    isMarshalable: true,
    syncEnabled: true,  // Key fix - enables proper cleanup of entities
    cleanupThrottleMs: options.aggressiveCleanup ? 1 : 10,
  });

  // Add memory monitoring capabilities
  const originalEvalCode = arena.evalCode.bind(arena);
  let evaluationCount = 0;

  arena.evalCode = function(code: string) {
    const result = originalEvalCode(code);
    evaluationCount++;
    
    if (options.memoryMonitoring && evaluationCount % 25 === 0) {
      const memInfo = getMemoryInfo();
      console.log(`🔍 Evaluation ${evaluationCount}: ${memInfo.memoryUsedMB}MB used`);
    }
    
    return result;
  };

  // Helper function to get memory information
  function getMemoryInfo() {
    try {
      const handle = arena.context.runtime.computeMemoryUsage();
      const mem = arena.context.dump(handle);
      handle.dispose();
      
      return {
        memoryUsedMB: (mem.memory_used_size as number / 1024 / 1024).toFixed(3),
        pendingCleanup: 0, // ephemeralMode handles cleanup automatically
      };
    } catch (error) {
      return {
        memoryUsedMB: "unknown",
        pendingCleanup: 0,
      };
    }
  }

  // Add getMemoryInfo method to arena
  (arena as any).getMemoryInfo = getMemoryInfo;

  return arena;
}

export function wrapEntityFunctions(action: any, _arena: any) {
  // With ephemeralMode, we don't need special wrapping since cleanup is automatic
  // Just return the original action object
  return action;
} 