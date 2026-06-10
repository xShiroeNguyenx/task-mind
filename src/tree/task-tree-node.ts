import * as vscode from 'vscode';
import { DisplayStatus, Task } from '../types';

// Nhóm cây 2 cấp. Một node project/day mang thêm key của chiều KIA khi nó là cấp 2:
//  - project có dateKey  → project nằm DƯỚI một ngày (mode day-project) → con là task.
//  - project KHÔNG dateKey → project cấp 1 (mode project-day) → con là các ngày.
//  - day có projectKey   → day nằm DƯỚI một dự án (mode project-day) → con là task.
//  - day KHÔNG projectKey → day cấp 1 (mode day-project) → con là các dự án.
export type TreeNode =
  | { kind: 'project'; projectKey: string; dateKey?: string }
  | { kind: 'epic'; epicId: string } // epicId === '' nghĩa là nhóm "Khác" (backend, không còn dùng để nhóm)
  | { kind: 'day'; dateKey: string; projectKey?: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'subtask'; subtaskId: string };

const STALE_MS = 24 * 3600 * 1000;

/** Trạng thái hiển thị: stale = in_progress quá ~24h không lượt mới. */
export function displayStatus(task: Task, now: Date = new Date()): DisplayStatus {
  if (task.status === 'in_progress' && now.getTime() - new Date(task.updatedAt).getTime() > STALE_MS) {
    return 'stale';
  }
  return task.status;
}

export function statusIcon(status: DisplayStatus): vscode.ThemeIcon {
  switch (status) {
    case 'done':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'abandoned':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    case 'stale':
      return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
    case 'in_progress':
    default:
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
  }
}
