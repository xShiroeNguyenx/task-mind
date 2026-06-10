import * as vscode from 'vscode';
import { CaptureService } from './capture/capture-service';
import { readConfig, updateConfig } from './config';
import { ReportView } from './report/report-view';
import { TaskTreeProvider } from './tree/task-tree-provider';
import { TreeNode } from './tree/task-tree-node';
import { projectKeyFromCwd, projectNameFromCwd, relativeTime, todayKey } from './util';

interface CommandDeps {
  context: vscode.ExtensionContext;
  service: CaptureService;
  treeView: vscode.TreeView<TreeNode>;
  treeProvider: TaskTreeProvider;
  reportView: ReportView;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, service, treeView, reportView } = deps;

  const resolve = (node?: TreeNode): TreeNode | undefined => node ?? treeView.selection[0];

  const reg = (id: string, fn: (...args: any[]) => any) => vscode.commands.registerCommand(id, fn);

  const taskOf = (node?: TreeNode): string | undefined => {
    const n = resolve(node);
    return n && n.kind === 'task' ? n.taskId : undefined;
  };
  const epicOf = (node?: TreeNode): string | undefined => {
    const n = resolve(node);
    return n && n.kind === 'epic' ? n.epicId : undefined;
  };
  const subtaskOf = (node?: TreeNode): string | undefined => {
    const n = resolve(node);
    return n && n.kind === 'subtask' ? n.subtaskId : undefined;
  };

  const disposables: vscode.Disposable[] = [
    reg('taskMind.refresh', () => service.refresh()),

    reg('taskMind.toggleGrouping', async () => {
      const cfg = readConfig();
      await updateConfig('tree.groupBy', cfg.groupBy === 'project-day' ? 'day-project' : 'project-day');
    }),

    reg('taskMind.markDone', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (id) {
        await service.applyCorrection('set_status', { taskId: id, status: 'done' });
      }
    }),

    reg('taskMind.markUndone', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (id) {
        await service.applyCorrection('set_status', { taskId: id, status: 'in_progress' });
      }
    }),

    reg('taskMind.editTitle', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const task = service.getProjection().getTask(id);
      const title = await vscode.window.showInputBox({ prompt: 'Tiêu đề việc', value: task?.title });
      if (title) {
        await service.applyCorrection('retitle', { targetKind: 'task', id, title });
      }
    }),

    reg('taskMind.deleteTask', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const ok = await vscode.window.showWarningMessage('Xoá việc này?', { modal: true }, 'Xoá');
      if (ok === 'Xoá') {
        await service.applyCorrection('delete_task', { taskId: id });
      }
    }),

    reg('taskMind.mergeTasks', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const proj = service.getProjection();
      const others = proj.getTasks().filter((t) => t.id !== id);
      const pick = await vscode.window.showQuickPick(
        others.map((t) => ({ label: t.title, description: relativeTime(t.updatedAt), id: t.id })),
        { placeHolder: 'Gộp việc này VÀO việc nào?' },
      );
      if (pick) {
        await service.applyCorrection('merge', { sourceTaskId: id, targetTaskId: pick.id });
      }
    }),

    reg('taskMind.splitTask', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const task = service.getProjection().getTask(id);
      if (!task || task.turns.length < 2) {
        vscode.window.showInformationMessage('Việc này không đủ lượt để tách.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        task.turns.map((t, i) => ({ label: t.text.slice(0, 60), description: relativeTime(t.ts), uuid: t.lineUuid, idx: i })),
        { placeHolder: 'Chọn các lượt tách thành việc mới', canPickMany: true },
      );
      if (picks && picks.length) {
        await service.applyCorrection('split', {
          taskId: id,
          turnUuids: picks.map((p) => p.uuid),
          newTaskId: service.newId(),
        });
      }
    }),

    reg('taskMind.moveToEpic', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const task = service.getProjection().getTask(id);
      const epics = service.getProjection().getEpics();
      const items: Array<vscode.QuickPickItem & { epicId?: string; create?: boolean }> = epics.map((e) => ({
        label: e.title,
        epicId: e.id,
      }));
      items.push({ label: '$(add) Tạo Epic mới…', create: true });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Chuyển sang Epic nào?' });
      if (!pick) {
        return;
      }
      if (pick.create) {
        const title = await vscode.window.showInputBox({ prompt: 'Tên Epic mới' });
        if (!title || !task) {
          return;
        }
        const epicId = `epic-${service.newId()}`;
        await service.applyCorrection('move_task', { taskId: id, epicId, epicTitle: title });
      } else {
        await service.applyCorrection('move_task', { taskId: id, epicId: pick.epicId });
      }
    }),

    reg('taskMind.createEpic', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Tên Epic mới' });
      if (!title) {
        return;
      }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      await service.applyCorrection('create_epic', {
        epicId: `epic-${service.newId()}`,
        title,
        cwd,
        projectKey: cwd ? projectKeyFromCwd(cwd) : '',
      });
    }),

    reg('taskMind.renameEpic', async (node?: TreeNode) => {
      const id = epicOf(node);
      if (!id) {
        return;
      }
      const epic = service.getProjection().getEpic(id);
      const title = await vscode.window.showInputBox({ prompt: 'Tên Epic', value: epic?.title });
      if (title) {
        await service.applyCorrection('rename_epic', { epicId: id, title });
      }
    }),

    reg('taskMind.deleteEpic', async (node?: TreeNode) => {
      const id = epicOf(node);
      if (!id) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        'Xoá Epic này? (Các việc bên trong sẽ về nhóm "Khác")',
        { modal: true },
        'Xoá',
      );
      if (ok === 'Xoá') {
        await service.applyCorrection('delete_epic', { epicId: id });
      }
    }),

    reg('taskMind.promoteToEpic', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const task = service.getProjection().getTask(id);
      const title = await vscode.window.showInputBox({ prompt: 'Tên Epic', value: task?.title });
      if (title) {
        await service.applyCorrection('promote', { taskId: id, epicId: `epic-${service.newId()}`, title });
      }
    }),

    reg('taskMind.addSubtask', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const title = await vscode.window.showInputBox({ prompt: 'Nội dung subtask' });
      if (title) {
        await service.append([
          {
            type: 'subtask',
            eventId: service.newId(),
            ts: nowIso(),
            taskId: id,
            subtaskId: service.newId(),
            title,
            source: 'manual',
          },
        ]);
      }
    }),

    reg('taskMind.toggleSubtask', async (node?: TreeNode) => {
      const id = subtaskOf(node);
      if (!id) {
        return;
      }
      const st = service.getProjection().getSubtask(id);
      await service.applyCorrection('toggle_subtask', { subtaskId: id, done: st?.status !== 'done' });
    }),

    reg('taskMind.deleteSubtask', async (node?: TreeNode) => {
      const id = subtaskOf(node);
      if (id) {
        await service.applyCorrection('delete_subtask', { subtaskId: id });
      }
    }),

    reg('taskMind.openReport', () => reportView.show(todayKey())),
    reg('taskMind.exportReportMarkdown', () => reportView.export()),

    reg('taskMind.openTask', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const proj = service.getProjection();
      const task = proj.getTask(id);
      if (!task) {
        return;
      }
      const lines: string[] = [`# ${task.title}`, '', `**Trạng thái:** ${task.status}`];
      const projectName = projectNameFromCwd(task.cwd);
      if (projectName) {
        lines.push(`**Dự án:** ${projectName}`);
      }
      lines.push('', '## Tóm tắt', task.summary || '_(chưa tóm tắt)_');
      const subs = task.subtaskIds.map((s) => proj.getSubtask(s)).filter(Boolean);
      if (subs.length) {
        lines.push('', '## Subtask');
        for (const s of subs) {
          lines.push(`- [${s!.status === 'done' ? 'x' : ' '}] ${s!.title}`);
        }
      }
      lines.push('', `## History (${task.turns.length} lượt)`);
      for (const t of task.turns) {
        lines.push(`- ${t.text.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
      }
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
      await vscode.commands.executeCommand('markdown.showPreview');
    }),

    reg('taskMind.aiStatus', async () => {
      const s = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Task Mind: đang kiểm tra AI…' },
        () => service.aiStatus(),
      );
      if (s.ok) {
        vscode.window.showInformationMessage(
          `✅ AI hoạt động (${s.engine}). Ví dụ tiêu đề: "${s.sample}". Chạy "Dựng lại toàn bộ task" để áp cho task cũ.`,
        );
      } else {
        vscode.window.showWarningMessage(
          `⚠️ AI chưa chạy (engine=${s.engine}). Lý do: ${s.error ?? 'không rõ'}. Hãy đăng nhập Copilot hoặc nhập API key đúng provider.`,
          'Nhập API key',
          'Mở cài đặt',
        ).then((sel) => {
          if (sel === 'Nhập API key') {
            vscode.commands.executeCommand('taskMind.setApiKey');
          } else if (sel === 'Mở cài đặt') {
            vscode.commands.executeCommand('taskMind.openSettings');
          }
        });
      }
    }),

    reg('taskMind.retryTask', async (node?: TreeNode) => {
      const id = taskOf(node);
      if (!id) {
        return;
      }
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Task Mind: dựng lại task này…' },
        () => service.retryTask(id),
      );
      if (r.ok) {
        vscode.window.showInformationMessage(`Đã đặt lại tên task bằng ${r.engine}.`);
      } else {
        vscode.window
          .showWarningMessage(
            `Task này thiếu thông tin nên AI không đặt được tên (${r.engine}). Bạn có thể xoá nó.`,
            'Xoá task này',
          )
          .then((sel) => {
            if (sel) {
              vscode.commands.executeCommand('taskMind.deleteTask', node);
            }
          });
      }
    }),

    reg('taskMind.deleteFailedTasks', async () => {
      const n = await service.deleteFailedTasks();
      vscode.window.showInformationMessage(
        n > 0 ? `Đã xoá ${n} task không đặt được tên (⚠️).` : 'Không có task ⚠️ nào để xoá.',
      );
    }),

    reg('taskMind.reprocess', async () => {
      // Xác nhận trước — đây là thao tác PHÁ HUỶ. Cảnh báo cụ thể số việc sẽ bị cắt theo cửa sổ ngày.
      const impact = service.reprocessImpact();
      const baseDetail =
        'Dựng lại toàn bộ task từ lịch sử thô.\n\n' +
        '• Chỉnh sửa thủ công (đổi tên, gộp, tách, gán Epic) sẽ MẤT.\n' +
        '• Trạng thái ĐÃ CHECK (việc/subtask hoàn thành) sẽ được KHÔI PHỤC tự động theo nội dung (best-effort).';
      let keepAllHistory = false;
      if (impact.droppedTasks > 0) {
        const detail =
          baseDetail +
          `\n\n⚠️ Với backfillDays=${impact.backfillDays}, ${impact.droppedTasks} việc từ các ngày trước sẽ bị XOÁ VĨNH VIỄN ` +
          '(không khôi phục được check vì dữ liệu gốc bị cắt theo cửa sổ ngày). Chọn "Giữ toàn bộ lịch sử" để tránh.';
        const choice = await vscode.window.showWarningMessage(
          'Dựng lại toàn bộ task?',
          { modal: true, detail },
          'Giữ toàn bộ lịch sử',
          `Chỉ ${impact.backfillDays} ngày gần nhất`,
        );
        if (!choice) {
          return;
        }
        keepAllHistory = choice === 'Giữ toàn bộ lịch sử';
      } else {
        const choice = await vscode.window.showWarningMessage(
          'Dựng lại toàn bộ task?',
          { modal: true, detail: baseDetail },
          'Dựng lại',
        );
        if (choice !== 'Dựng lại') {
          return;
        }
      }

      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Có — dùng AI (Copilot / API key)', useAi: true },
          { label: 'Không — chỉ heuristic', useAi: false },
        ],
        { placeHolder: 'Dựng lại toàn bộ task từ lịch sử. Dùng AI để gom nhóm & đặt tên?' },
      );
      if (!pick) {
        return;
      }
      if (pick.useAi) {
        const s = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Task Mind: kiểm tra AI…' },
          () => service.aiStatus(),
        );
        // Chỉ CHẶN khi thực sự không có model nào. Nếu model đã cấu hình (external/vscode-lm)
        // nhưng test vừa lỗi tạm thời (429/503) thì VẪN dựng — mỗi lượt có retry + fallback.
        if (s.engine === 'heuristic') {
          const go = await vscode.window.showWarningMessage(
            `Chưa có AI model (${s.error ?? 'không rõ'}). Dựng lại bây giờ tên task sẽ là prompt thô. Bật Copilot / nhập API key trước sẽ tốt hơn.`,
            { modal: true },
            'Vẫn dựng (heuristic)',
          );
          if (go !== 'Vẫn dựng (heuristic)') {
            return;
          }
        } else if (!s.ok) {
          vscode.window.showInformationMessage(
            `Model ${s.engine} đã cấu hình nhưng test vừa lỗi (${s.error ?? 'tạm thời'}). Vẫn thử dựng — có retry, lượt nào lỗi sẽ tự fallback heuristic.`,
          );
        }
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Task Mind: Dựng lại task', cancellable: false },
        async (progress) => {
          const res = await service.reprocess(pick.useAi, (msg) => progress.report({ message: msg }), { keepAllHistory });
          const engineLabel =
            res.engine === 'vscode-lm'
              ? 'Copilot (vscode-lm)'
              : res.engine === 'external'
                ? 'API key ngoài'
                : res.engine === 'heuristic'
                  ? 'heuristic (chưa có AI)'
                  : res.engine;
          let msg = `Đã dựng lại ${res.tasks} task (engine ${engineLabel}).`;
          if (res.aiTitles !== undefined) {
            msg += ` Tên: ${res.aiTitles} bằng AI`;
            if (res.failed) {
              msg += `, ${res.failed} task ⚠️ (lỗi gọi AI tạm thời — thử lại sau)`;
            }
            if (res.heuristic) {
              msg += `, ${res.heuristic} heuristic`;
            }
            if (res.autoDeleted) {
              msg += `, đã tự xoá ${res.autoDeleted} task thiếu thông tin`;
            }
            msg += '.';
          }
          if (res.restored || res.restoredSubtasks) {
            msg += ` Khôi phục ${res.restored ?? 0} việc đã hoàn thành`;
            if (res.restoredSubtasks) {
              msg += ` + ${res.restoredSubtasks} subtask`;
            }
            msg += '.';
          }
          if (res.droppedByCutoff) {
            msg += ` ⚠️ Đã xoá ${res.droppedByCutoff} việc ngoài cửa sổ ${impact.backfillDays} ngày.`;
          }
          if (res.failed && res.error) {
            vscode.window.showWarningMessage(`${msg} (Lỗi AI gần nhất: ${res.error})`);
          } else {
            vscode.window.showInformationMessage(msg);
          }
        },
      );
    }),

    reg('taskMind.setApiKey', async () => {
      const cfg = readConfig();
      const key = await vscode.window.showInputBox({
        prompt: `Nhập API key cho ${cfg.externalProvider}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(`taskMind.apiKey.${cfg.externalProvider}`, key);
        const s = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Task Mind: đang thử API key…' },
          () => service.aiStatus(),
        );
        if (s.ok) {
          vscode.window.showInformationMessage(`✅ Đã lưu & xác nhận API key (${s.engine}). Ví dụ tiêu đề: "${s.sample}".`);
        } else {
          vscode.window.showWarningMessage(
            `Đã lưu key nhưng AI chưa chạy (provider=${cfg.externalProvider}). Lý do: ${s.error ?? 'không rõ'}. Kiểm tra taskMind.ai.provider phải là "auto"/"external" và key hợp lệ.`,
          );
        }
      }
    }),

    reg('taskMind.openSettings', () =>
      // Mở panel cài đặt (webview) trong sidebar Task Mind.
      vscode.commands.executeCommand('taskMind.settingsView.focus'),
    ),

    reg('taskMind.openNativeSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:shiroenguyen.task-mind'),
    ),

    reg('taskMind.simulateTask', () => service.simulateTask()),
  ];

  return disposables;
}
