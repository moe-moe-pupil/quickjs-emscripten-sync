const { parentPort } = require('worker_threads');

class CleanupWorker {
  constructor() {
    this.pendingCleanup = new Map(); // id -> [target, wrappedTarget]
    this.isProcessing = false;
    this.throttleMs = 0;
    this.lastCleanupTime = 0;
    this.counter = 0;
    
    // Auto-adjustment settings
    this.microChunkSize = 5;
    this.maxProcessingTime = 2;
    
    this.setupMessageHandler();
  }

  setupMessageHandler() {
    parentPort.on('message', (message) => {
      switch (message.type) {
        case 'schedule':
          this.scheduleCleanup(message.id, message.target, message.wrappedTarget);
          break;
        case 'setThrottle':
          this.throttleMs = message.ms;
          break;
        case 'flush':
          this.flushCleanup();
          break;
        case 'clear':
          this.clearAll();
          break;
        case 'getCount':
          parentPort.postMessage({
            type: 'count',
            count: this.pendingCleanup.size
          });
          break;
      }
    });
  }

  scheduleCleanup(id, target, wrappedTarget) {
    this.pendingCleanup.set(id, [target, wrappedTarget]);
    this.autoAdjustCleanup();
    
    if (!this.isProcessing) {
      this.startProcessing();
    }
  }

  autoAdjustCleanup() {
    const pendingCount = this.pendingCleanup.size;
    
    if (pendingCount > 1000) {
      this.throttleMs = 100;
      this.microChunkSize = 3;
    } else if (pendingCount > 500) {
      this.throttleMs = 50;
      this.microChunkSize = 4;
    } else if (pendingCount > 100) {
      this.throttleMs = 10;
      this.microChunkSize = 5;
    } else {
      this.throttleMs = 0;
      this.microChunkSize = 8;
    }
  }

  startProcessing() {
    if (this.isProcessing || this.pendingCleanup.size === 0) {
      return;
    }

    // Check throttling
    const now = Date.now();
    const timeSinceLastCleanup = now - this.lastCleanupTime;
    
    if (this.throttleMs > 0 && timeSinceLastCleanup < this.throttleMs) {
      const delay = this.throttleMs - timeSinceLastCleanup;
      setTimeout(() => this.startProcessing(), delay);
      return;
    }

    this.isProcessing = true;
    this.lastCleanupTime = now;
    setImmediate(() => this.processBatch());
  }

  processBatch() {
    if (this.pendingCleanup.size === 0) {
      this.isProcessing = false;
      return;
    }

    const startTime = performance.now();
    const batch = [];
    const entries = Array.from(this.pendingCleanup.entries());
    let processed = 0;

    // Create a batch of items to send to main thread
    for (const [id, [target, wrappedTarget]] of entries) {
      if (processed >= this.microChunkSize) {
        break;
      }

      batch.push({ id, target, wrappedTarget });
      this.pendingCleanup.delete(id);
      processed++;

      // Time-based yielding
      const elapsedTime = performance.now() - startTime;
      if (elapsedTime >= this.maxProcessingTime) {
        break;
      }
    }

    // Send batch to main thread for actual cleanup
    if (batch.length > 0) {
      parentPort.postMessage({
        type: 'cleanupBatch',
        batch: batch
      });
    }

    // Continue processing if there are more items
    if (this.pendingCleanup.size > 0) {
      setImmediate(() => this.processBatch());
    } else {
      this.isProcessing = false;
    }
  }

  flushCleanup() {
    // Send all remaining items immediately
    const batch = Array.from(this.pendingCleanup.entries()).map(([id, [target, wrappedTarget]]) => ({
      id, target, wrappedTarget
    }));
    
    if (batch.length > 0) {
      this.pendingCleanup.clear();
      parentPort.postMessage({
        type: 'cleanupBatch',
        batch: batch,
        flush: true
      });
    }
    
    this.isProcessing = false;
  }

  clearAll() {
    this.pendingCleanup.clear();
    this.isProcessing = false;
  }
}

// Start the worker
new CleanupWorker(); 