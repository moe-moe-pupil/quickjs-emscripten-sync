const { parentPort } = require('worker_threads');

class CleanupWorker {
  constructor() {
    this.isProcessing = false;
    this.throttleMs = 0;
    this.lastCleanupTime = 0;
    
    this.setupMessageHandler();
  }

  setupMessageHandler() {
    parentPort.on('message', (message) => {
      switch (message.type) {
        case 'triggerProcessing':
          this.triggerProcessing();
          break;
        case 'setThrottle':
          this.throttleMs = message.ms;
          break;
        case 'flush':
          this.flushCleanup();
          break;
        case 'clear':
          this.isProcessing = false;
          break;
      }
    });
  }

  triggerProcessing() {
    if (!this.isProcessing) {
      this.startProcessing();
    }
  }

  startProcessing() {
    if (this.isProcessing) {
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
    
    // Tell main thread to process a small batch
    parentPort.postMessage({
      type: 'processBatch'
    });
    
    // Continue with small intervals to keep processing smooth
    setTimeout(() => {
      this.isProcessing = false;
      // Check if more processing is needed by telling main thread
      parentPort.postMessage({
        type: 'checkContinue'
      });
    }, 2); // Very small delay for non-blocking
  }

  flushCleanup() {
    // Tell main thread to flush all
    parentPort.postMessage({
      type: 'flushAll'
    });
    this.isProcessing = false;
  }
}

// Start the worker
new CleanupWorker(); 