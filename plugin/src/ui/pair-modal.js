import { Modal, Setting } from 'obsidian';

/**
 * Device pairing: the user types a one-time code minted on the Mac
 * (`agent-os pair`). The code is exchanged for a credential that stays on this
 * device and can be revoked from the Mac at any time.
 */
export class PairDeviceModal extends Modal {
  /**
   * @param {import('obsidian').App} app
   * @param {{ onPair: (code: string) => Promise<{ device?: { name?: string } }>, onDone?: () => void }} deps
   */
  constructor(app, deps) {
    super(app);
    this.deps = deps;
    this.code = '';
    this.busy = false;
    this.error = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('aos-pair-modal');
    contentEl.createEl('h2', { text: '配对这台设备' });
    contentEl.createEl('p', {
      cls: 'aos-pair-hint',
      text: '在 Mac 上运行 `agent-os pair` 生成一次性配对码，然后填在这里。配对码只能用一次，5 分钟内有效。',
    });

    new Setting(contentEl)
      .setName('配对码')
      .setDesc('例如 P2845W4J')
      .addText((text) => {
        text.inputEl.addClass('aos-pair-input');
        text.inputEl.autocapitalize = 'characters';
        text.setPlaceholder('XXXXXXXX').onChange((value) => {
          this.code = value;
        });
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });
        setTimeout(() => text.inputEl.focus(), 30);
      });

    this.statusEl = contentEl.createDiv({ cls: 'aos-pair-status' });
    if (this.error) this.statusEl.setText(this.error);

    const actions = contentEl.createDiv({ cls: 'aos-pair-actions' });
    this.submitBtn = actions.createEl('button', {
      cls: 'mod-cta',
      text: '配对',
      attr: { type: 'button' },
    });
    this.submitBtn.onclick = () => this.submit();
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.onclick = () => this.close();
  }

  async submit() {
    if (this.busy) return;
    const code = String(this.code || '').trim().toUpperCase();
    if (!code) {
      this.setStatus('请先填写配对码', true);
      return;
    }
    this.busy = true;
    this.submitBtn.disabled = true;
    this.setStatus('正在配对…', false);
    try {
      const result = await this.deps.onPair(code);
      this.setStatus(`配对成功${result?.device?.name ? `：${result.device.name}` : ''}`, false);
      this.deps.onDone?.();
      setTimeout(() => this.close(), 600);
    } catch (error) {
      this.error = error?.message || '配对失败';
      this.setStatus(this.error, true);
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }

  setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.setText(text || '');
    this.statusEl.toggleClass('is-error', !!isError);
  }

  onClose() {
    this.contentEl.empty();
  }
}
