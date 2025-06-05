import type {
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSContext,
  SuccessOrFail,
  VmCallResult,
} from "quickjs-emscripten";

import { wrapContext, QuickJSContextEx } from "./contextex";
import { defaultRegisteredObjects } from "./default";
import marshal from "./marshal";
import unmarshal from "./unmarshal";
import { complexity, isES2015Class, isObject, walkObject } from "./util";
import VMMap from "./vmmap";
import { call, eq, isHandleObject, json, consumeAll, mayConsume, handleFrom } from "./vmutil";
import { wrap, wrapHandle, unwrap, unwrapHandle, Wrapped } from "./wrapper";

export {
  VMMap,
  defaultRegisteredObjects,
  marshal,
  unmarshal,
  complexity,
  isES2015Class,
  isObject,
  walkObject,
  call,
  eq,
  isHandleObject,
  json,
  consumeAll,
};

export type Options = {
  /** A callback that returns a boolean value that determines whether an object is marshalled or not. If false, no marshaling will be done and undefined will be passed to the QuickJS VM, otherwise marshaling will be done. By default, all objects will be marshalled. */
  isMarshalable?: boolean | "json" | ((target: any) => boolean | "json");
  /** Pre-registered pairs of objects that will be considered the same between the host and the QuickJS VM. This will be used automatically during the conversion. By default, it will be registered automatically with `defaultRegisteredObjects`.
   *
   * Instead of a string, you can also pass a QuickJSHandle directly. In that case, however, you have to dispose of them manually when destroying the VM.
   */
  registeredObjects?: Iterable<[any, QuickJSHandle | string]>;
  /** Register functions to convert an object to a QuickJS handle. */
  customMarshaller?: Iterable<(target: unknown, ctx: QuickJSContext) => QuickJSHandle | undefined>;
  /** Register functions to convert a QuickJS handle to an object. */
  customUnmarshaller?: Iterable<(target: QuickJSHandle, ctx: QuickJSContext) => any>;
  /** A callback that returns a boolean value that determines whether an object is wrappable by proxies. If returns false, note that the object cannot be synchronized between the host and the QuickJS even if arena.sync is used. */
  isWrappable?: (target: any) => boolean;
  /** A callback that returns a boolean value that determines whether an QuickJS handle is wrappable by proxies. If returns false, note that the handle cannot be synchronized between the host and the QuickJS even if arena.sync is used. */
  isHandleWrappable?: (handle: QuickJSHandle, ctx: QuickJSContext) => boolean;
  /** Compatibility with quickjs-emscripten prior to v0.15. Inject code for compatibility into context at Arena class initialization time. */
  compat?: boolean;
  /** Experimental: use QuickJSContextEx, which wraps existing QuickJSContext. */
  experimentalContextEx?: boolean;
  /** Globally enable syncing mode. Default is true. If returns false, note that the handle cannot be synchronized between the host and the QuickJS even if arena.sync is used.  */
  syncEnabled?: boolean;
  /** Ephemeral mode: automatically cleanup handles after each evaluation. Useful for scripts that create many temporary objects. */
  ephemeralMode?: boolean;
  /** Lazy cleanup: defer cleanup to idle time to minimize impact on main thread. */
  lazyCleanup?: boolean;
  /** Defer all cleanup: accumulate handles and only cleanup when manually triggered or memory pressure detected. */
  deferAllCleanup?: boolean;
  /** Throttle cleanup: minimum milliseconds between cleanup cycles. 0 = no throttling. */
  cleanupThrottleMs?: number;
  /** Use worker thread for cleanup processing. Completely eliminates blocking on main thread. */
  useWorkerCleanup?: boolean;
  /** Delay in milliseconds before handles are eligible for cleanup after being created. Useful for entities that need time to be used. Default: 0 */
  cleanupDelayMs?: number;
};

/**
 * The Arena class manages all generated handles at once by quickjs-emscripten and automatically converts objects between the host and the QuickJS VM.
 */
export class Arena {
  context: QuickJSContextEx;
  _map: VMMap;
  _registeredMap: VMMap;
  _registeredMapDispose: Set<any> = new Set();
  _sync: Set<any> = new Set();
  _temporalSync: Set<any> = new Set();
  _symbol = Symbol();
  _symbolHandle: QuickJSHandle;
  _options?: Options;
  // private _afterExposedData: Record<string, any> = {};
  private _afterExposed = false;
  private _pendingCleanup: Set<[any, any]> = new Set();
  private _cleanupScheduled = false;
  private _isProcessingCleanup = false;
  private _cleanupDisabled = false;
  private _cleanupThrottleMs = 0;
  private _lastCleanupTime = 0;
  private _cleanupWorker?: any; // Worker instance
  private _cleanupIdCounter = 0;
  private _delayedCleanup: Map<any, number> = new Map(); // target -> timestamp when created

  /** Constructs a new Arena instance. It requires a quickjs-emscripten context initialized with `quickjs.newContext()`. */
  constructor(ctx: QuickJSContext, options?: Options) {
    if (options?.compat && !("runtime" in ctx)) {
      (ctx as any).runtime = {
        hasPendingJob: () => (ctx as any).hasPendingJob(),
        executePendingJobs: (maxJobsToExecute?: number | void) =>
          (ctx as any).executePendingJobs(maxJobsToExecute),
      };
    }

    this.context = options?.experimentalContextEx ? wrapContext(ctx) : ctx;
    this._options = options;
    this._cleanupThrottleMs = options?.cleanupThrottleMs ?? 0;
    this._symbolHandle = ctx.unwrapResult(ctx.evalCode(`Symbol()`));
    this._map = new VMMap(ctx);
    this._registeredMap = new VMMap(ctx);
    this.registerAll(options?.registeredObjects ?? defaultRegisteredObjects);
    
    // Initialize worker thread if enabled
    if (options?.useWorkerCleanup) {
      this._initWorkerCleanup();
    }
  }

  /**
   * Initialize worker thread for cleanup
   */
  private _initWorkerCleanup() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Worker } = require('worker_threads');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      
      const workerPath = path.resolve(__dirname, 'cleanup-worker.js');
      this._cleanupWorker = new Worker(workerPath);
      
      // Handle messages from worker
      this._cleanupWorker.on('message', (message: any) => {
        switch (message.type) {
          case 'processBatch':
            this._processWorkerBatch();
            break;
          case 'checkContinue':
            this._checkContinueProcessing();
            break;
          case 'flushAll':
            this._processAllPending();
            break;
        }
      });
      
      // Handle worker errors
      this._cleanupWorker.on('error', (error: any) => {
        console.error('Cleanup worker error:', error);
        // Fallback to single-threaded cleanup
        this._cleanupWorker = undefined;
      });
      
    } catch (error) {
      console.warn('Failed to initialize cleanup worker, falling back to single-threaded:', error);
      this._cleanupWorker = undefined;
    }
  }

  /**
   * Process a small batch when triggered by worker
   */
  private _processWorkerBatch() {
    const BATCH_SIZE = 5;
    const batch = Array.from(this._pendingCleanup).slice(0, BATCH_SIZE);
    
    for (const [t, wrappedT] of batch) {
      try {
        const unwrappedT = this._unwrap(t);
        if (this._sync.has(unwrappedT)) {
          this._sync.delete(unwrappedT);
          this._map.fastDelete(wrappedT, false);
          this.unregister(t, false);
        }
        this._pendingCleanup.delete([t, wrappedT]);
      } catch (error) {
        console.warn('Cleanup item failed:', error);
      }
    }
  }

  /**
   * Check if more processing is needed and trigger worker if so
   */
  private _checkContinueProcessing() {
    if (this._pendingCleanup.size > 0) {
      this._cleanupWorker?.postMessage({ type: 'triggerProcessing' });
    }
  }

  /**
   * Process all pending cleanup items immediately
   */
  private _processAllPending() {
    const toCleanup = Array.from(this._pendingCleanup);
    this._pendingCleanup.clear();
    
    for (const [t, wrappedT] of toCleanup) {
      try {
        const unwrappedT = this._unwrap(t);
        if (this._sync.has(unwrappedT)) {
          this._sync.delete(unwrappedT);
          this._map.fastDelete(wrappedT, false);
          this.unregister(t, false);
        }
      } catch (error) {
        console.warn('Cleanup item failed:', error);
      }
    }
  }

  /**
   * Dispose of the arena and managed handles. This method won't dispose the VM itself, so the VM has to be disposed of manually.
   */
  dispose() {
    // Terminate worker if it exists
    if (this._cleanupWorker) {
      this._cleanupWorker.terminate();
      this._cleanupWorker = undefined;
    }
    
    // Clear delayed cleanup tracking
    this._delayedCleanup.clear();
    
    // Force synchronous cleanup before disposing
    this._disposeSync();
    this._map.dispose();
    this._registeredMap.dispose();
    this._symbolHandle.dispose();
    this.context.disposeEx?.();
  }

  /**
   * Async dispose that waits for all cleanup to complete
   */
  async disposeAsync() {
    await this.flushCleanup();
    this._map.dispose();
    this._registeredMap.dispose();
    this._symbolHandle.dispose();
    this.context.disposeEx?.();
  }

  /**
   * Synchronous cleanup for dispose method
   */
  private _disposeSync() {
    // Force immediate synchronous cleanup for dispose
    const toCleanup = Array.from(this._pendingCleanup);
    this._pendingCleanup.clear();
    this._isProcessingCleanup = false;
    this._cleanupScheduled = false;

    for (const [t, wrappedT] of toCleanup) {
      const unwrappedT = this._unwrap(t);
      if (this._sync.has(unwrappedT)) {
        this._sync.delete(unwrappedT);
        this.unregister(t, true);
        this._map.delete(wrappedT, true);
      }
    }
  }

  /**
   * Evaluate JS code in the VM and get the result as an object on the host side. It also converts and re-throws error objects when an error is thrown during evaluation.
   */
  evalCode<T = any>(code: string): T {
    const handle = this.context.evalCode(code);
    const result = this._unwrapResultAndUnmarshal(handle);
    
    // Auto-cleanup in ephemeral mode (non-blocking)
    if (this._options?.ephemeralMode) {
      this.flushCleanup(); // Don't await - let it run in background
    }
    
    return result;
  }

  /**
   * Async version of evalCode that waits for cleanup to complete.
   * Use this when you need to ensure all handles are cleaned up before continuing.
   */
  async evalCodeAsync<T = any>(code: string): Promise<T> {
    const handle = this.context.evalCode(code);
    const result = this._unwrapResultAndUnmarshal(handle);
    
    // Auto-cleanup in ephemeral mode (blocking)
    if (this._options?.ephemeralMode) {
      await this.flushCleanup();
    }
    
    return result;
  }

  /**
   * Almost same as `vm.executePendingJobs()`, but it converts and re-throws error objects when an error is thrown during evaluation.
   */
  executePendingJobs(maxJobsToExecute?: number): number {
    const result = this.context.runtime.executePendingJobs(maxJobsToExecute);
    if ("value" in result) {
      return result.value;
    }
    throw this._unwrapIfNotSynced(result.error.consume(this._unmarshal));
  }

  removeSync(t: any, wrappedT: any) {
    // console.log('clear');
    this.unregister(t, true);
    this._map.delete(wrappedT, true);
    // this._map.delete(unwrappedT, false);
    // h.dispose();
    this._sync.delete(t);
  }

  /**
   * Truly non-blocking cleanup method using micro-chunks and timing controls
   */
  private _processPendingCleanup() {
    if (this._pendingCleanup.size === 0 || this._isProcessingCleanup) {
      this._cleanupScheduled = false;
      return;
    }

    this._isProcessingCleanup = true;
    this._cleanupScheduled = false;

    // Convert to array for micro-chunked processing
    const toCleanup = Array.from(this._pendingCleanup);
    this._pendingCleanup.clear();

    // Use very small chunks and time-based yielding
    const MICRO_CHUNK_SIZE = 5; // Process only 5 items at a time
    const MAX_PROCESSING_TIME = 2; // Max 2ms per chunk
    let currentIndex = 0;

    const processMicroChunk = () => {
      const startTime = performance.now();
      
      while (currentIndex < toCleanup.length) {
        const endIndex = Math.min(currentIndex + MICRO_CHUNK_SIZE, toCleanup.length);
        const microChunk = toCleanup.slice(currentIndex, endIndex);

        // Process this micro-chunk synchronously
        for (const [t, wrappedT] of microChunk) {
          const unwrappedT = this._unwrap(t);
          if (this._sync.has(unwrappedT)) {
            this._sync.delete(unwrappedT);
            // Always use fastDelete for auto-cleanup to prevent blocking
            this._map.fastDelete(wrappedT, false);
            this.unregister(t, false);
          }
        }

        currentIndex = endIndex;

        // Check if we've spent too much time processing
        const elapsedTime = performance.now() - startTime;
        if (elapsedTime >= MAX_PROCESSING_TIME) {
          break; // Yield control back to event loop
        }
      }

      // Continue processing if there are more items
      if (currentIndex < toCleanup.length) {
        // Use setImmediate for next micro-chunk
        setImmediate(processMicroChunk);
      } else {
        // Cleanup is complete
        this._isProcessingCleanup = false;
      }
    };

    // Start with setImmediate to yield immediately
    setImmediate(processMicroChunk);
  }

  /**
   * Schedule a handle for cleanup without blocking the current operation
   */
  private _scheduleCleanup(t: any, wrappedT: any) {
    const cleanupDelayMs = this._options?.cleanupDelayMs ?? 0;
    
    // Record when this handle was created for delayed cleanup
    if (cleanupDelayMs > 0) {
      this._delayedCleanup.set(t, Date.now());
    }
    
    // If there's a delay, schedule cleanup for later
    if (cleanupDelayMs > 0) {
      setTimeout(() => {
        this._executeCleanup(t, wrappedT);
      }, cleanupDelayMs);
      return;
    }
    
    // No delay - execute cleanup immediately
    this._executeCleanup(t, wrappedT);
  }

  /**
   * Execute the actual cleanup scheduling (after any delay)
   */
  private _executeCleanup(t: any, wrappedT: any) {
    // Remove from delayed cleanup tracking
    this._delayedCleanup.delete(t);
    
    // For worker mode: just add to local queue and trigger worker processing
    if (this._cleanupWorker) {
      this._pendingCleanup.add([t, wrappedT]);
      // Tell worker to process (without sending the actual objects)
      this._cleanupWorker.postMessage({
        type: 'triggerProcessing'
      });
      return;
    }
    
    // Fallback to single-threaded cleanup
    this._pendingCleanup.add([t, wrappedT]);
    
    // Auto-adjust cleanup throttling based on load
    this._autoAdjustCleanup();
    
    // Don't schedule any cleanup if deferAllCleanup is enabled or cleanup is disabled
    if (this._options?.deferAllCleanup || this._cleanupDisabled) {
      return;
    }
    
    if (!this._cleanupScheduled && !this._isProcessingCleanup) {
      // Check throttling
      const now = Date.now();
      const timeSinceLastCleanup = now - this._lastCleanupTime;
      
      if (this._cleanupThrottleMs > 0 && timeSinceLastCleanup < this._cleanupThrottleMs) {
        // Throttled - schedule for later
        const delay = this._cleanupThrottleMs - timeSinceLastCleanup;
        setTimeout(() => {
          if (!this._cleanupScheduled && !this._isProcessingCleanup) {
            this._scheduleCleanupNow();
          }
        }, delay);
        return;
      }
      
      this._scheduleCleanupNow();
    }
  }

  private _scheduleCleanupNow() {
    this._cleanupScheduled = true;
    this._lastCleanupTime = Date.now();
    
    if (this._options?.lazyCleanup) {
      // In lazy mode, defer cleanup to when the event loop is truly idle
      setTimeout(() => this._processPendingCleanup(), 100);
    } else {
      // Use setImmediate for better Node.js event loop integration
      setImmediate(() => this._processPendingCleanup());
    }
  }
  /**
   * Expose objects as global objects in the VM.
   *
   * By default, exposed objects are not synchronized between the host and the VM.
   * If you want to sync an objects, first wrap the object with sync method, and then expose the wrapped object.
   */
  expose(obj: { [k: string]: any }) {
    for (const [key, value] of Object.entries(obj)) {
      mayConsume(this._marshal(value), handle => {
        this.context.setProp(this.context.global, key, handle);
      });
    }
    this._afterExposed = true;
  }

  /**
   * Enables sync for the object between the host and the VM and returns objects wrapped with proxies.
   *
   * The return value is necessary in order to reflect changes to the object from the host to the VM. Please note that setting a value in the field or deleting a field in the original object will not synchronize it.
   */
  sync<T>(target: T): T {
    const wrapped = this._wrap(target);
    if (typeof wrapped === "undefined") return target;
    walkObject(wrapped, v => {
      const u = this._unwrap(v);
      this._sync.add(u);
    });
    return wrapped;
  }

  /**
   * Register a pair of objects that will be considered the same between the host and the QuickJS VM.
   *
   * Instead of a string, you can also pass a QuickJSHandle directly. In that case, however, when  you have to dispose them manually when destroying the VM.
   */
  register(target: any, handleOrCode: QuickJSHandle | string) {
    if (this._registeredMap.has(target)) return;
    const handle =
      typeof handleOrCode === "string"
        ? this._unwrapResult(this.context.evalCode(handleOrCode))
        : handleOrCode;
    if (eq(this.context, handle, this.context.undefined)) return;
    if (typeof handleOrCode === "string") {
      this._registeredMapDispose.add(target);
    }
    this._registeredMap.set(target, handle);
  }

  /**
   * Execute `register` methods for each pair.
   */
  registerAll(map: Iterable<[any, QuickJSHandle | string]>) {
    for (const [k, v] of map) {
      this.register(k, v);
    }
  }

  /**
   * Unregister a pair of objects that were registered with `registeredObjects` option and `register` method.
   */
  unregister(target: any, dispose?: boolean) {
    this._registeredMap.delete(target, this._registeredMapDispose.has(target) || dispose);
    this._registeredMapDispose.delete(target);
  }

  /**
   * Execute `unregister` methods for each target.
   */
  unregisterAll(targets: Iterable<any>, dispose?: boolean) {
    for (const t of targets) {
      this.unregister(t, dispose);
    }
  }

  startSync(target: any) {
    if (!isObject(target)) return;
    const u = this._unwrap(target);
    this._sync.add(u);
  }

  endSync(target: any) {
    this._sync.delete(this._unwrap(target));
  }

  /**
   * Temporarily disable all cleanup operations. Useful during high-traffic periods.
   */
  disableCleanup() {
    this._cleanupDisabled = true;
  }

  /**
   * Re-enable cleanup operations.
   */
  enableCleanup() {
    this._cleanupDisabled = false;
  }

  /**
   * Get the number of pending cleanup items.
   */
  getPendingCleanupCount(): number {
    if (this._cleanupWorker) {
      // For worker mode, we'll need to make this async or estimate
      return 0; // Worker handles the queue
    }
    return this._pendingCleanup.size;
  }

  /**
   * Get the number of handles waiting for delayed cleanup.
   */
  getDelayedCleanupCount(): number {
    return this._delayedCleanup.size;
  }

  /**
   * Cancel delayed cleanup for a specific target (useful if entity is still being used).
   */
  cancelDelayedCleanup(target: any): boolean {
    return this._delayedCleanup.delete(target);
  }

  /**
   * Set cleanup throttling dynamically based on server load
   */
  setCleanupThrottle(ms: number) {
    this._cleanupThrottleMs = ms;
    if (this._cleanupWorker) {
      this._cleanupWorker.postMessage({
        type: 'setThrottle',
        ms
      });
    }
  }

  /**
   * Auto-adjust cleanup based on pending count
   */
  private _autoAdjustCleanup() {
    const pendingCount = this._pendingCleanup.size;
    
    if (pendingCount > 1000) {
      // High load - throttle more aggressively
      this._cleanupThrottleMs = 100;
    } else if (pendingCount > 500) {
      // Medium load - moderate throttling
      this._cleanupThrottleMs = 50;
    } else if (pendingCount > 100) {
      // Low load - light throttling
      this._cleanupThrottleMs = 10;
    } else {
      // Very low load - no throttling
      this._cleanupThrottleMs = this._options?.cleanupThrottleMs ?? 0;
    }
  }

  /**
   * Aggressively clear all pending cleanup without disposing handles.
   * Use this to prevent memory accumulation when you don't care about proper disposal.
   * WARNING: This may cause memory leaks in QuickJS, use only when necessary.
   */
  clearPendingCleanup() {
    this._pendingCleanup.clear();
    this._isProcessingCleanup = false;
    this._cleanupScheduled = false;
  }

  /**
   * Fast cleanup that only removes sync references without proper disposal.
   * Much faster but may leave some handles alive in QuickJS.
   */
  fastCleanup() {
    const toCleanup = Array.from(this._pendingCleanup);
    this._pendingCleanup.clear();
    this._isProcessingCleanup = false;
    this._cleanupScheduled = false;

    // Use the fast delete method from VMMap
    for (const [t, wrappedT] of toCleanup) {
      const unwrappedT = this._unwrap(t);
      this._sync.delete(unwrappedT);
      // Use fastDelete to avoid expensive QuickJS calls
      this._map.fastDelete(wrappedT, false); // Don't dispose handles for speed
      this.unregister(t, false); // Don't dispose registered handles
    }
  }

  /**
   * Force process all pending handle cleanups immediately.
   * Useful for manual memory management in performance-critical sections.
   * Returns a Promise that resolves when cleanup is complete.
   */
  flushCleanup(): Promise<void> {
    if (this._cleanupWorker) {
      this._cleanupWorker.postMessage({ type: 'flush' });
      return Promise.resolve(); // Worker handles flushing asynchronously
    }

    return new Promise((resolve) => {
      if (this._pendingCleanup.size === 0) {
        resolve();
        return;
      }

      // Wait for any ongoing cleanup to finish
      const waitForCleanup = () => {
        if (!this._isProcessingCleanup) {
          this._processPendingCleanup();
          // Wait for cleanup to complete
          const checkComplete = () => {
            if (!this._isProcessingCleanup && this._pendingCleanup.size === 0) {
              resolve();
            } else {
              setImmediate(checkComplete);
            }
          };
          setImmediate(checkComplete);
        } else {
          setImmediate(waitForCleanup);
        }
      };
      
      waitForCleanup();
    });
  }

  _unwrapResult<T>(result: SuccessOrFail<T, QuickJSHandle>): T {
    if ("value" in result) {
      return result.value;
    }
    throw this._unwrapIfNotSynced(result.error.consume(this._unmarshal));
  }

  _unwrapResultAndUnmarshal(result: VmCallResult<QuickJSHandle> | undefined): any {
    if (!result) return;
    return this._unwrapIfNotSynced(this._unwrapResult(result).consume(this._unmarshal));
  }

  _isMarshalable = (t: unknown): boolean | "json" => {
    const im = this._options?.isMarshalable;
    return (typeof im === "function" ? im(this._unwrap(t)) : im) ?? "json";
  };

  _marshalFind = (t: unknown) => {
    const unwrappedT = this._unwrap(t);
    const handle =
      this._registeredMap.get(t) ??
      (unwrappedT !== t ? this._registeredMap.get(unwrappedT) : undefined) ??
      this._map.get(t) ??
      (unwrappedT !== t ? this._map.get(unwrappedT) : undefined);
    return handle;
  };

  _marshalPre = (
    t: unknown,
    h: QuickJSHandle | QuickJSDeferredPromise,
    mode: true | "json" | undefined,
  ): Wrapped<QuickJSHandle> | undefined => {
    if (mode === "json") return;
    // console.log('_marshalPre', this._options?.syncEnabled);
    return this._register(t, handleFrom(h), this._map, this._options?.syncEnabled)?.[1];
  };

  _marshalPreApply = (target: Function, that: unknown, args: unknown[]): void => {
    const unwrapped = isObject(that) ? this._unwrap(that) : undefined;
    // override sync mode of this object while calling the function
    if (unwrapped) this._temporalSync.add(unwrapped);
    try {
      return target.apply(that, args);
    } finally {
      // restore sync mode
      if (unwrapped) this._temporalSync.delete(unwrapped);
    }
  };

  _marshal = (target: any): [QuickJSHandle, boolean] => {
    const registered = this._registeredMap.get(target);
    if (registered) {
      return [registered, false];
    }
    const syncEnabled = this._options?.syncEnabled ?? true;

    const handle = marshal(this._wrap(target) ?? target, {
      ctx: this.context,
      unmarshal: this._unmarshal,
      isMarshalable: this._isMarshalable,
      find: this._marshalFind,
      pre: this._marshalPre,
      preApply: this._marshalPreApply,
      custom: this._options?.customMarshaller,
    });

    return [handle, !syncEnabled || !this._map.hasHandle(handle)];
  };

  _preUnmarshal = (t: any, h: QuickJSHandle): Wrapped<any> => {
    return this._register(t, h, undefined, this._options?.syncEnabled ?? true)?.[0];
  };

  _unmarshalFind = (h: QuickJSHandle): unknown => {
    return this._registeredMap.getByHandle(h) ?? this._map.getByHandle(h);
  };

  _unmarshal = (handle: QuickJSHandle): any => {
    // console.log("unmarshal!!!");
    const registered = this._registeredMap.getByHandle(handle);
    if (typeof registered !== "undefined") {
      // console.log("registered!!!");
      return registered;
    }

    // console.log("unregistered!!!");
    const [wrappedHandle] = this._wrapHandle(handle);
    return unmarshal(wrappedHandle ?? handle, {
      ctx: this.context,
      marshal: this._marshal,
      find: this._unmarshalFind,
      pre: this._preUnmarshal,
      custom: this._options?.customUnmarshaller,
    });
  };

  _register(
    t: any,
    h: QuickJSHandle,
    map: VMMap = this._map,
    sync?: boolean,
  ): [Wrapped<any>, Wrapped<QuickJSHandle>] | undefined {
    if (this._registeredMap.has(t) || this._registeredMap.hasHandle(h)) {
      return;
    }

    let wrappedT = this._wrap(t);
    const [wrappedH] = this._wrapHandle(h);
    const isPromise = t instanceof Promise;
    if (!wrappedH || (!wrappedT && !isPromise)) return; // t or h is not an object
    if (isPromise) wrappedT = t;

    const unwrappedT = this._unwrap(t);
    const [unwrappedH, unwrapped] = this._unwrapHandle(h);

    const res = map.set(wrappedT, wrappedH, unwrappedT, unwrappedH);
    if (!res) {
      // already registered
      if (unwrapped) unwrappedH.dispose();
      throw new Error("already registered");
    } else if (sync) {
      this._sync.add(unwrappedT);
      
      // If after exposed, schedule handle for cleanup after syncing once
      if (this._afterExposed) {
        this._scheduleCleanup(t, wrappedT);
      }
    }

    return [wrappedT, wrappedH];
  }

  _syncMode = (obj: any): "both" | undefined => {
    const obj2 = this._unwrap(obj);
    return this._sync.has(obj2) || this._temporalSync.has(obj2) ? "both" : undefined;
  };

  _wrap<T>(target: T): Wrapped<T> | undefined {
    return wrap(
      this.context,
      target,
      this._symbol,
      this._symbolHandle,
      this._marshal,
      this._syncMode,
      this._options?.isWrappable,
      this._options?.syncEnabled ?? true,
    );
  }

  _unwrap<T>(target: T): T {
    return unwrap(target, this._symbol);
  }

  _unwrapIfNotSynced = <T>(target: T): T => {
    const unwrapped = this._unwrap(target);
    return unwrapped instanceof Promise || !this._sync.has(unwrapped) ? unwrapped : target;
  };

  _wrapHandle(handle: QuickJSHandle): [Wrapped<QuickJSHandle> | undefined, boolean] {
    return wrapHandle(
      this.context,
      handle,
      this._symbol,
      this._symbolHandle,
      this._unmarshal,
      this._syncMode,
      this._options?.isHandleWrappable,
      this._options?.syncEnabled ?? true,
    );
  }

  _unwrapHandle(target: QuickJSHandle): [QuickJSHandle, boolean] {
    return unwrapHandle(this.context, target, this._symbolHandle);
  }
}
