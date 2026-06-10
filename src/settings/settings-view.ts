import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { CaptureService } from '../capture/capture-service';
import { onConfigChange } from '../config';

const SECTION = 'taskMind';

type FieldType = 'boolean' | 'number' | 'enum' | 'string';

interface Field {
  key: string; // khoá tương đối trong section taskMind
  type: FieldType;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  options?: Array<[string, string]>; // [value, label] cho enum
}

interface Group {
  title: string;
  fields: Field[];
}

/** Describes every setting to render the form — mirrors "configuration" in package.json. */
const GROUPS: Group[] = [
  {
    title: 'Auto capture',
    fields: [
      { key: 'autoCapture.enabled', type: 'boolean', label: 'Auto-record work delegated to AI' },
      { key: 'capture.idleGapMinutes', type: 'number', label: 'Idle gap to merge tasks (minutes)', min: 1, max: 240, hint: 'Beyond this gap is treated as a new task.' },
      { key: 'capture.pollIntervalSeconds', type: 'number', label: 'Transcript poll interval (seconds)', min: 1, max: 60 },
      { key: 'capture.backfillDays', type: 'number', label: 'Backfill (recent days)', min: 0, max: 90, hint: '1 = today only · 0 = no limit.' },
    ],
  },
  {
    title: 'AI',
    fields: [
      {
        key: 'ai.provider', type: 'enum', label: 'AI engine',
        options: [['auto', 'Auto'], ['vscode-lm', 'VS Code LM (Copilot)'], ['external', 'External API key'], ['heuristic', 'Heuristic (offline)']],
      },
      {
        key: 'ai.externalProvider', type: 'enum', label: 'External API provider',
        options: [['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (GPT)'], ['gemini', 'Google Gemini']],
      },
      { key: 'ai.model', type: 'string', label: 'Model', hint: 'Leave empty = provider default.' },
      { key: 'hierarchy.autoClassify', type: 'boolean', label: 'AI auto-assigns tasks to an Epic (backend)' },
      { key: 'autoDeleteFailedTasks', type: 'boolean', label: 'Auto-delete insufficient-info tasks' },
      {
        key: 'hierarchy.subtaskSource', type: 'enum', label: 'Subtask source',
        options: [['agent-todo', "Agent's TodoWrite"], ['ai', 'AI decomposition'], ['both', 'Both'], ['off', 'Off']],
      },
    ],
  },
  {
    title: 'Display',
    fields: [
      { key: 'tree.groupBy', type: 'enum', label: 'Tree grouping', options: [['project-day', 'Project → Day'], ['day-project', 'Day → Project']] },
      { key: 'scope', type: 'enum', label: 'Scope', options: [['global', 'All projects'], ['workspace', 'Current project only']] },
      { key: 'language', type: 'enum', label: 'Language', options: [['vi', 'Tiếng Việt'], ['en', 'English']] },
    ],
  },
  {
    title: 'Report',
    fields: [
      { key: 'report.time', type: 'string', label: 'Report time (HH:MM)', hint: '24h format, e.g. 18:00.' },
      { key: 'report.autoGenerate', type: 'boolean', label: 'Auto-generate report' },
    ],
  },
];

const TIME_RE = /^\d{1,2}:\d{2}$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Panel cài đặt dạng WebviewView nhúng trong sidebar Task Mind. */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'taskMind.settingsView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: CaptureService,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg), undefined, this.disposables);

    // Khi setting đổi từ nơi khác (Settings gốc, lệnh khác) → đồng bộ lại form.
    this.disposables.push(onConfigChange(() => void this.postState()));

    webviewView.onDidDispose(() => {
      for (const d of this.disposables.splice(0)) {
        d.dispose();
      }
      this.view = undefined;
    });

    void this.render();
  }

  // --- đọc cấu hình hiện tại ---

  private currentConfig(): Record<string, unknown> {
    const c = vscode.workspace.getConfiguration(SECTION);
    const out: Record<string, unknown> = {};
    for (const g of GROUPS) {
      for (const f of g.fields) {
        out[f.key] = c.get(f.key);
      }
    }
    return out;
  }

  private externalProvider(): string {
    return vscode.workspace.getConfiguration(SECTION).get<string>('ai.externalProvider', 'anthropic');
  }

  private async hasApiKey(): Promise<boolean> {
    const key = await this.context.secrets.get(`taskMind.apiKey.${this.externalProvider()}`);
    return !!key;
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage({
      type: 'state',
      config: this.currentConfig(),
      provider: this.externalProvider(),
      hasApiKey: await this.hasApiKey(),
    });
  }

  // --- xử lý message từ webview ---

  private async onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        await this.postState();
        break;

      case 'update':
        await this.applyUpdate(msg.key, msg.value);
        break;

      case 'saveApiKey': {
        const provider = this.externalProvider();
        const value = typeof msg.value === 'string' ? msg.value.trim() : '';
        if (!value) {
          return;
        }
        await this.context.secrets.store(`taskMind.apiKey.${provider}`, value);
        await this.postState();
        await this.runAiCheck();
        break;
      }

      case 'clearApiKey':
        await this.context.secrets.delete(`taskMind.apiKey.${this.externalProvider()}`);
        await this.postState();
        break;

      case 'checkAi':
        await this.runAiCheck();
        break;

      case 'reprocess':
        await vscode.commands.executeCommand('taskMind.reprocess');
        break;

      case 'openNative':
        await vscode.commands.executeCommand('taskMind.openNativeSettings');
        break;
    }
  }

  /** Ghi setting với kiểm tra hợp lệ (programmatic update KHÔNG được package.json validate). */
  private async applyUpdate(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== 'string') {
      return;
    }
    const field = GROUPS.flatMap((g) => g.fields).find((f) => f.key === key);
    if (!field) {
      return;
    }
    let v = value;
    if (field.type === 'number') {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isNaN(n)) {
        return;
      }
      if (field.min !== undefined && n < field.min) {
        return;
      }
      if (field.max !== undefined && n > field.max) {
        return;
      }
      v = n;
    } else if (field.type === 'boolean') {
      v = !!v;
    } else if (key === 'report.time') {
      if (typeof v !== 'string' || !TIME_RE.test(v)) {
        return;
      }
    }
    await vscode.workspace.getConfiguration(SECTION).update(key, v, vscode.ConfigurationTarget.Global);
    // onConfigChange sẽ tự postState lại.
  }

  private async runAiCheck(): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage({ type: 'aiChecking' });
    const s = await this.service.aiStatus();
    await this.view.webview.postMessage({ type: 'ai', ...s });
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.html(this.view.webview);
    await this.postState();
  }

  private renderField(f: Field, value: unknown): string {
    const id = `f_${f.key.replace(/\W/g, '_')}`;
    const hint = f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : '';
    if (f.type === 'boolean') {
      const checked = value === true ? 'checked' : '';
      return `<div class="row toggle">
        <label for="${id}">${escapeHtml(f.label)}</label>
        <input type="checkbox" id="${id}" data-key="${escapeHtml(f.key)}" data-type="boolean" ${checked}>
        ${hint}
      </div>`;
    }
    if (f.type === 'enum') {
      const opts = (f.options ?? [])
        .map(([val, lab]) => `<option value="${escapeHtml(val)}" ${val === value ? 'selected' : ''}>${escapeHtml(lab)}</option>`)
        .join('');
      return `<div class="row">
        <label for="${id}">${escapeHtml(f.label)}</label>
        <select id="${id}" data-key="${escapeHtml(f.key)}" data-type="enum">${opts}</select>
        ${hint}
      </div>`;
    }
    if (f.type === 'number') {
      const attrs = `${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}`;
      return `<div class="row">
        <label for="${id}">${escapeHtml(f.label)}</label>
        <input type="number" id="${id}" data-key="${escapeHtml(f.key)}" data-type="number" ${attrs} value="${escapeHtml(String(value ?? ''))}">
        ${hint}
      </div>`;
    }
    // string
    return `<div class="row">
      <label for="${id}">${escapeHtml(f.label)}</label>
      <input type="text" id="${id}" data-key="${escapeHtml(f.key)}" data-type="string" value="${escapeHtml(String(value ?? ''))}">
      ${hint}
    </div>`;
  }

  private html(webview: vscode.Webview): string {
    const cfg = this.currentConfig();
    const nonce = randomUUID().replace(/-/g, '');
    const cspSource = webview.cspSource;

    const groupsHtml = GROUPS.map(
      (g) => `<section>
        <h3>${escapeHtml(g.title)}</h3>
        ${g.fields.map((f) => this.renderField(f, cfg[f.key])).join('')}
      </section>`,
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); padding: 4px 2px 24px; }
  h3 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  section:first-child h3 { margin-top: 4px; }
  .row { margin: 8px 0; }
  .row > label { display: block; margin-bottom: 3px; }
  .row.toggle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .row.toggle > label { margin: 0; order: 2; flex: 1; }
  .row.toggle > input { order: 1; }
  .row.toggle .hint { order: 3; flex-basis: 100%; }
  input[type="text"], input[type="number"], input[type="password"], select {
    width: 100%; box-sizing: border-box; padding: 4px 6px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input[type="checkbox"] { width: 16px; height: 16px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .apikey-row { display: flex; gap: 6px; }
  .apikey-row input { flex: 1; }
  .status { margin-top: 6px; font-size: .9em; min-height: 1.2em; }
  .status.ok { color: var(--vscode-charts-green, var(--vscode-foreground)); }
  .status.err { color: var(--vscode-errorForeground); }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
</style>
</head>
<body>
  ${groupsHtml}

  <section>
    <h3>API key</h3>
    <div class="hint" id="apikeyStatus">Current provider: <code id="apikeyProvider">—</code></div>
    <div class="apikey-row" style="margin-top:6px">
      <input type="password" id="apikeyInput" placeholder="Paste API key…" autocomplete="off">
      <button id="apikeySave">Save & check</button>
    </div>
    <div class="actions">
      <button class="secondary" id="apikeyClear">Clear key</button>
    </div>
  </section>

  <section>
    <h3>Tools</h3>
    <div class="actions">
      <button id="checkAi">Check AI</button>
      <button class="secondary" id="reprocess">Rebuild all tasks</button>
    </div>
    <div class="status" id="aiStatus"></div>
    <div class="hint" style="margin-top:10px">
      <a class="link" id="openNative">Open native VS Code settings ↗</a>
    </div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function post(m) { vscode.postMessage(m); }

    function onChange(el) {
      const key = el.dataset.key;
      const type = el.dataset.type;
      let value;
      if (type === 'boolean') {
        value = el.checked;
      } else if (type === 'number') {
        value = parseFloat(el.value);
        if (Number.isNaN(value)) { return; }
      } else {
        value = el.value;
      }
      post({ type: 'update', key, value });
    }

    document.querySelectorAll('[data-key]').forEach((el) => {
      // 'change' (không phải 'input') để không spam update theo từng phím gõ.
      el.addEventListener('change', () => onChange(el));
    });

    document.getElementById('apikeySave').addEventListener('click', () => {
      const inp = document.getElementById('apikeyInput');
      post({ type: 'saveApiKey', value: inp.value });
      inp.value = '';
    });
    document.getElementById('apikeyClear').addEventListener('click', () => post({ type: 'clearApiKey' }));
    document.getElementById('checkAi').addEventListener('click', () => post({ type: 'checkAi' }));
    document.getElementById('reprocess').addEventListener('click', () => post({ type: 'reprocess' }));
    document.getElementById('openNative').addEventListener('click', () => post({ type: 'openNative' }));

    function applyState(s) {
      const cfg = s.config || {};
      // Gán trực tiếp value/checked — KHÔNG dispatch event để tránh vòng lặp update↔state.
      for (const key in cfg) {
        const el = document.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
        if (!el) { continue; }
        if (el.type === 'checkbox') { el.checked = cfg[key] === true; }
        else { el.value = cfg[key] == null ? '' : cfg[key]; }
      }
      const st = document.getElementById('apikeyStatus');
      st.innerHTML = 'Current provider: <code>' + (s.provider || '—') + '</code> — '
        + (s.hasApiKey ? '✅ key saved' : '⚠️ no key');
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m) { return; }
      if (m.type === 'state') { applyState(m); }
      else if (m.type === 'aiChecking') {
        const d = document.getElementById('aiStatus');
        d.className = 'status'; d.textContent = '⏳ Checking AI…';
      } else if (m.type === 'ai') {
        const d = document.getElementById('aiStatus');
        if (m.ok) {
          d.className = 'status ok';
          d.textContent = '✅ AI working (' + m.engine + ')' + (m.sample ? ' — e.g. "' + m.sample + '"' : '');
        } else {
          d.className = 'status err';
          d.textContent = '⚠️ AI not running (' + m.engine + ')' + (m.error ? ' — ' + m.error : '');
        }
      }
    });

    post({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
