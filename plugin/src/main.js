/**
 * Obsidian Agent OS Obsidian plugin entry (desktop).
 * Pure logic is unit-testable without Obsidian runtime.
 */
import { renderAgentMessage, formatSkillMenu, composeWithRefs } from './renderer.js';
import { handleConfirmAccept, handleConfirmReject, filterPluginSafeWrites } from './confirm-actions.js';
import { parseFences } from './protocol-bridge.js';

const DEFAULT_SETTINGS = {
  gatewayUrl: 'ws://127.0.0.1:18789',
  quiet: false,
  skills: [],
};

/**
 * Core controller — Obsidian wires this via main-obsidian.js bundle entry if needed.
 */
export class MeSoulController {
  constructor(settings) {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  listSkills() {
    return formatSkillMenu(this.settings.skills || []);
  }

  setQuiet(quiet) {
    this.settings.quiet = !!quiet;
  }

  /**
   * @param {string} userText
   * @param {{ path: string, excerpt?: string }[]} [refs]
   * @param {{ mockReply?: string }} [testOpts]
   */
  async handleUserMessage(userText, refs = [], testOpts = {}) {
    const composed = composeWithRefs(userText, refs);
    let agentText;
    if (testOpts.mockReply != null) {
      agentText = testOpts.mockReply;
    } else if (this.ask) {
      agentText = await this.ask(composed);
    } else {
      return { ok: false, error: 'OpenClaw 未连接', html: '', blocks: [] };
    }
    const rendered = renderAgentMessage(agentText, { quiet: this.settings.quiet });
    return { ok: true, agentText, composed, ...rendered };
  }

  approveConfirm(pendingMarkdown) {
    return handleConfirmAccept(pendingMarkdown);
  }

  rejectConfirm(pendingMarkdown) {
    return handleConfirmReject(pendingMarkdown);
  }

  filterWrites(paths) {
    return filterPluginSafeWrites(paths);
  }
}

export default MeSoulController;

export {
  renderAgentMessage,
  handleConfirmAccept,
  handleConfirmReject,
  filterPluginSafeWrites,
  composeWithRefs,
  formatSkillMenu,
  parseFences,
  DEFAULT_SETTINGS,
};
