// Polyfill global File cho Node 18 (vsce mới yêu cầu undici cần global File của Node 20+).
const { Blob } = require('buffer');
if (typeof globalThis.File === 'undefined') {
  class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = options.lastModified ?? Date.now();
    }
    get [Symbol.toStringTag]() {
      return 'File';
    }
  }
  globalThis.File = File;
}
