import * as vscode from 'vscode';
import { AiClient } from './ai-client';
import { warn } from '../../log';

/** Dùng VS Code Language Model API (Copilot…). Không cần API key, cần cấp quyền 1 lần. */
export class VsCodeLmClient implements AiClient {
  readonly name = 'vscode-lm';
  lastError?: string;

  constructor(private readonly modelHint: string = '') {}

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    const lm = (vscode as any).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') {
      return undefined;
    }
    try {
      let models: vscode.LanguageModelChat[] = await lm.selectChatModels(
        this.modelHint ? { family: this.modelHint } : { vendor: 'copilot' },
      );
      if (!models.length) {
        models = await lm.selectChatModels();
      }
      return models[0];
    } catch (e) {
      warn(`vscode.lm selectChatModels lỗi: ${String(e)}`);
      return undefined;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.pickModel()) !== undefined;
  }

  async complete(system: string, user: string): Promise<string | undefined> {
    this.lastError = undefined; // xoá lỗi cũ: !lastError sau gọi = AI đã trả lời bình thường
    const model = await this.pickModel();
    if (!model) {
      this.lastError = 'vscode.lm: không chọn được model (Copilot chưa sẵn sàng?).';
      warn(this.lastError);
      return undefined;
    }
    try {
      const LM = vscode.LanguageModelChatMessage;
      const messages = [LM.User(`${system}\n\n${user}`)];
      const resp = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
      let out = '';
      for await (const chunk of resp.text) {
        out += chunk;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        this.lastError = 'vscode.lm trả rỗng.';
        return undefined;
      }
      return trimmed;
    } catch (e) {
      this.lastError = `vscode.lm sendRequest lỗi: ${String(e)}`;
      warn(this.lastError);
      return undefined;
    }
  }
}
