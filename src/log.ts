import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(c: vscode.OutputChannel): void {
  channel = c;
}

function ts(): string {
  // new Date() chạy bình thường trong extension host (không phải workflow sandbox).
  return new Date().toISOString();
}

export function log(message: string): void {
  channel?.appendLine(`[${ts()}] ${message}`);
}

export function warn(message: string): void {
  channel?.appendLine(`[${ts()}] WARN ${message}`);
}

export function error(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
  channel?.appendLine(`[${ts()}] ERROR ${message}${detail ? ' — ' + detail : ''}`);
}
