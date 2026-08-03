'use strict';

function extractWholeFileBytes(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes)) {
    throw new TypeError('sourceBytes must be a Buffer');
  }
  if (sourceBytes.length === 0) {
    throw new Error('whole-file selection must contain at least one byte');
  }
  return Buffer.from(sourceBytes);
}

module.exports = {
  extractWholeFileBytes,
};
