import * as vscode from 'vscode';
import * as path from 'path';
import { initLogger, log } from './log';
import { TaskMindService } from './capture/task-mind-service';
import { CaptureService } from './capture/capture-service';
import { TaskTreeProvider } from './tree/task-tree-provider';
import { TreeNode } from './tree/task-tree-node';
import { ReportView } from './report/report-view';
import { SettingsViewProvider } from './settings/settings-view';
import { ReportScheduler } from './scheduler';
import { registerCommands } from './commands';
import { onConfigChange, readConfig } from './config';
import { buildDailyReport } from './report/report-builder';
import { todayKey } from './util';

let service: CaptureService | undefined;
let scheduler: ReportScheduler | undefined;
let reportView: ReportView | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Task Mind');
  context.subscriptions.push(channel);
  initLogger(channel);
  log('Task Mind kích hoạt.');

  const storageDir = path.join(context.globalStorageUri.fsPath, 'task-mind');
  const svc = new TaskMindService(storageDir, context);
  service = svc;
  await svc.start();

  const treeProvider = new TaskTreeProvider(svc);
  const treeView = vscode.window.createTreeView<TreeNode>('taskMind.tasksView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState((e) => treeProvider.handleCheckboxChange(e.items)),
  );

  reportView = new ReportView(svc);

  const settingsProvider = new SettingsViewProvider(context, svc);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settingsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  scheduler = new ReportScheduler(
    () => readConfig().reportTime,
    () => readConfig().reportAutoGenerate,
    () => {
      const report = buildDailyReport(svc.getProjection(), todayKey());
      void vscode.window
        .showInformationMessage(
          `Task Mind: hôm nay ${report.totals.completed} việc xong, ${report.totals.inProgress} đang làm.`,
          'Mở báo cáo',
        )
        .then((sel) => {
          if (sel) {
            reportView?.show(todayKey());
          }
        });
    },
  );
  scheduler.start();

  context.subscriptions.push(
    ...registerCommands({ context, service: svc, treeView, treeProvider, reportView }),
  );

  context.subscriptions.push(
    onConfigChange(() => {
      svc.reconfigure();
      treeProvider.refresh();
      scheduler?.reschedule();
    }),
  );
}

export function deactivate(): void {
  scheduler?.stop();
  reportView?.dispose();
  service?.dispose();
}
