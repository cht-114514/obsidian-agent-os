/**
 * Re-export pure protocol for plugin + tests (shipped path).
 * Uses relative import to workspace package source so tests run without bundling.
 */
export {
  parseFences,
  serializeFences,
  approvePendingMarkdown,
  rejectPendingMarkdown,
  applyPendingMarkdown,
  parsePendingMarkdown,
  checkWritePolicy,
  parseCaresMarkdown,
  canSendCare,
  selectCareItems,
} from '../../packages/protocol/src/index.js';
