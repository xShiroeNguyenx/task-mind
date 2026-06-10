import * as vscode from 'vscode';
import { CaptureService } from '../capture/capture-service';
import { readConfig } from '../config';
import { Projection } from '../store/projection';
import { Task } from '../types';
import { dayGroupLabel, localDateKey, projectKeyFromCwd, projectNameFromCwd, relativeTime } from '../util';
import { displayStatus, statusIcon, TreeNode } from './task-tree-node';

const OTHER_EPIC = ''; // epicId rỗng = nhóm "Khác"

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly service: CaptureService) {
    service.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private projection(): Projection {
    return this.service.getProjection();
  }

  private currentProjectKey(): string | undefined {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd ? projectKeyFromCwd(cwd) : undefined;
  }

  private visibleTasks(): Task[] {
    const cfg = readConfig();
    let tasks = this.projection().getTasks();
    if (cfg.scope === 'workspace') {
      const pk = this.currentProjectKey();
      if (pk) {
        tasks = tasks.filter((t) => t.projectKey === pk);
      }
    }
    return tasks;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node.projectKey, node.dateKey);
      case 'epic':
        return this.epicItem(node.epicId);
      case 'day':
        return this.dayItem(node.dateKey, node.projectKey);
      case 'task':
        return this.taskItem(node.taskId);
      case 'subtask':
        return this.subtaskItem(node.subtaskId);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.rootNodes();
    }
    if (node.kind === 'project') {
      // project cấp 2 (có dateKey) → task của (dự án ∧ ngày); cấp 1 → các ngày con của dự án.
      if (node.dateKey !== undefined) {
        return this.tasksOf(node.projectKey, node.dateKey).map((t) => ({ kind: 'task', taskId: t.id } as TreeNode));
      }
      return this.daysOfProject(node.projectKey).map(
        (dateKey) => ({ kind: 'day', dateKey, projectKey: node.projectKey } as TreeNode),
      );
    }
    if (node.kind === 'day') {
      // day cấp 2 (có projectKey) → task của (ngày ∧ dự án); cấp 1 → các dự án con của ngày.
      if (node.projectKey !== undefined) {
        return this.tasksOf(node.projectKey, node.dateKey).map((t) => ({ kind: 'task', taskId: t.id } as TreeNode));
      }
      return this.projectsOfDay(node.dateKey).map(
        (projectKey) => ({ kind: 'project', projectKey, dateKey: node.dateKey } as TreeNode),
      );
    }
    if (node.kind === 'epic') {
      return this.tasksOfEpic(node.epicId).map((t) => ({ kind: 'task', taskId: t.id } as TreeNode));
    }
    if (node.kind === 'task') {
      const task = this.projection().getTask(node.taskId);
      return (task?.subtaskIds ?? []).map((id) => ({ kind: 'subtask', subtaskId: id } as TreeNode));
    }
    return [];
  }

  private rootNodes(): TreeNode[] {
    const cfg = readConfig();
    if (cfg.groupBy === 'day-project') {
      // cấp 1 = ngày (mới nhất lên đầu).
      const days = new Set<string>();
      for (const t of this.visibleTasks()) {
        days.add(localDateKey(t.updatedAt));
      }
      return Array.from(days)
        .sort((a, b) => (a < b ? 1 : -1))
        .map((dateKey) => ({ kind: 'day', dateKey } as TreeNode));
    }
    // project-day: cấp 1 = dự án (dự án có việc mới nhất lên đầu).
    const latestPerProject = new Map<string, string>(); // projectKey -> updatedAt mới nhất
    for (const t of this.visibleTasks()) {
      const cur = latestPerProject.get(t.projectKey);
      if (!cur || t.updatedAt > cur) {
        latestPerProject.set(t.projectKey, t.updatedAt);
      }
    }
    return Array.from(latestPerProject.entries())
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .map(([projectKey]) => ({ kind: 'project', projectKey } as TreeNode));
  }

  /** Các ngày (mới nhất trước) có việc trong một dự án. */
  private daysOfProject(projectKey: string): string[] {
    const days = new Set<string>();
    for (const t of this.visibleTasks()) {
      if (t.projectKey === projectKey) {
        days.add(localDateKey(t.updatedAt));
      }
    }
    return Array.from(days).sort((a, b) => (a < b ? 1 : -1));
  }

  /** Các dự án (việc mới nhất trước) có việc trong một ngày. */
  private projectsOfDay(dateKey: string): string[] {
    const latest = new Map<string, string>(); // projectKey -> updatedAt mới nhất trong ngày
    for (const t of this.visibleTasks()) {
      if (localDateKey(t.updatedAt) !== dateKey) {
        continue;
      }
      const cur = latest.get(t.projectKey);
      if (!cur || t.updatedAt > cur) {
        latest.set(t.projectKey, t.updatedAt);
      }
    }
    return Array.from(latest.entries())
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .map(([projectKey]) => projectKey);
  }

  /** Việc thuộc cả dự án ∧ ngày (mới nhất trước). */
  private tasksOf(projectKey: string, dateKey: string): Task[] {
    return this.visibleTasks()
      .filter((t) => t.projectKey === projectKey && localDateKey(t.updatedAt) === dateKey)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private tasksOfEpic(epicId: string): Task[] {
    const tasks = this.visibleTasks();
    if (epicId === OTHER_EPIC) {
      return tasks.filter((t) => !t.epicId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    }
    return tasks
      .filter((t) => t.epicId === epicId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private tasksOfDay(dateKey: string): Task[] {
    return this.visibleTasks()
      .filter((t) => localDateKey(t.updatedAt) === dateKey)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private tasksOfProject(projectKey: string): Task[] {
    return this.visibleTasks()
      .filter((t) => t.projectKey === projectKey)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  // --- TreeItems ---

  private projectItem(projectKey: string, dateKey?: string): vscode.TreeItem {
    // dateKey set → project là cấp 2 (dưới một ngày): chỉ đếm việc trong ngày đó.
    const tasks = dateKey === undefined ? this.tasksOfProject(projectKey) : this.tasksOf(projectKey, dateKey);
    // Lấy cwd đại diện (của việc mới nhất) để hiện tên dự án ngắn gọn + tooltip đường dẫn.
    const cwd = tasks[0]?.cwd ?? projectKey;
    const name = projectNameFromCwd(cwd) || 'Khác';
    const done = tasks.filter((t) => t.status === 'done').length;
    // Cả 2 cấp đều mở sẵn để thấy task ngay (VS Code nhớ trạng thái thu/mở thủ công theo id sau đó).
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = 'project';
    item.description = `${tasks.length} việc · ${done} xong`;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.tooltip = new vscode.MarkdownString(`**${name}**\n\n\`${cwd}\``);
    item.id = dateKey === undefined ? `project:${projectKey}` : `day:${dateKey}/project:${projectKey}`;
    return item;
  }

  private epicItem(epicId: string): vscode.TreeItem {
    const proj = this.projection();
    const epic = epicId === OTHER_EPIC ? undefined : proj.getEpic(epicId);
    const title = epic?.title ?? 'Khác';
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = epicId === OTHER_EPIC ? 'epicOther' : 'epic';
    item.iconPath = new vscode.ThemeIcon('milestone');
    if (epic) {
      const { done, total } = proj.epicProgress(epic.id);
      item.description = `${done}/${total} xong`;
      if (epic.summary) {
        item.tooltip = new vscode.MarkdownString(`**${title}**\n\n${epic.summary}`);
      }
    } else {
      item.description = `${this.tasksOfEpic(OTHER_EPIC).length} việc`;
    }
    item.id = `epic:${epicId}`;
    return item;
  }

  private dayItem(dateKey: string, projectKey?: string): vscode.TreeItem {
    // projectKey set → day là cấp 2 (dưới một dự án): chỉ đếm việc của dự án đó trong ngày.
    const tasks = projectKey === undefined ? this.tasksOfDay(dateKey) : this.tasksOf(projectKey, dateKey);
    const done = tasks.filter((t) => t.status === 'done').length;
    const item = new vscode.TreeItem(dayGroupLabel(dateKey), vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = 'dayGroup';
    item.description = `${tasks.length} việc · ${done} xong`;
    item.iconPath = new vscode.ThemeIcon('calendar');
    item.id = projectKey === undefined ? `day:${dateKey}` : `project:${projectKey}/day:${dateKey}`;
    return item;
  }

  private taskItem(taskId: string): vscode.TreeItem {
    const proj = this.projection();
    const task = proj.getTask(taskId);
    if (!task) {
      return new vscode.TreeItem('(đã xoá)');
    }
    const hasSub = task.subtaskIds.length > 0;
    const item = new vscode.TreeItem(
      task.title || 'Việc không tên',
      hasSub ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const ds = displayStatus(task);
    item.contextValue = task.summaryFailed ? 'taskFailed' : 'task';
    item.iconPath = task.summaryFailed
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'))
      : statusIcon(ds);
    item.checkboxState =
      task.status === 'done'
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

    const bits: string[] = [relativeTime(task.updatedAt)];
    if (task.summaryFailed) {
      bits.push('thiếu thông tin — chuột phải để xoá');
    }
    if (ds === 'stale') {
      bits.push('có vẻ xong?');
    }
    item.description = bits.join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${task.title}**\n\n`);
    if (task.summary) {
      md.appendMarkdown(`${task.summary}\n\n`);
    }
    md.appendMarkdown(`- Lượt (history): ${task.turns.length}\n`);
    md.appendMarkdown(`- Cập nhật: ${relativeTime(task.updatedAt)}\n`);
    md.appendMarkdown(`- Dự án: \`${task.cwd}\`\n`);
    item.tooltip = md;
    item.id = `task:${taskId}`;
    item.command = {
      command: 'taskMind.openTask',
      title: 'Mở chi tiết',
      arguments: [{ kind: 'task', taskId } as TreeNode],
    };
    return item;
  }

  private subtaskItem(subtaskId: string): vscode.TreeItem {
    const st = this.projection().getSubtask(subtaskId);
    if (!st) {
      return new vscode.TreeItem('(đã xoá)');
    }
    const item = new vscode.TreeItem(st.title, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'subtask';
    item.checkboxState =
      st.status === 'done'
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    item.iconPath = new vscode.ThemeIcon(st.status === 'done' ? 'pass-filled' : 'circle-large-outline');
    item.id = `subtask:${subtaskId}`;
    return item;
  }

  /** Xử lý tick checkbox cho task & subtask. */
  async handleCheckboxChange(items: ReadonlyArray<[TreeNode, vscode.TreeItemCheckboxState]>): Promise<void> {
    for (const [node, state] of items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'task') {
        await this.service.applyCorrection('set_status', {
          taskId: node.taskId,
          status: checked ? 'done' : 'in_progress',
        });
      } else if (node.kind === 'subtask') {
        await this.service.applyCorrection('toggle_subtask', {
          subtaskId: node.subtaskId,
          done: checked,
        });
      }
    }
  }
}
