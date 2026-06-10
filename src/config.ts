import * as vscode from 'vscode';

export type AiProvider = 'auto' | 'vscode-lm' | 'external' | 'heuristic';
export type ExternalProvider = 'anthropic' | 'openai' | 'gemini';
export type SubtaskSource = 'agent-todo' | 'ai' | 'both' | 'off';
/** Nhóm cây 2 cấp: 'project-day' = Dự án → Ngày; 'day-project' = Ngày → Dự án. */
export type GroupBy = 'project-day' | 'day-project';
export type Scope = 'global' | 'workspace';

export interface TaskMindConfig {
  autoCaptureEnabled: boolean;
  idleGapMinutes: number;
  pollIntervalSeconds: number;
  backfillDays: number;
  aiProvider: AiProvider;
  externalProvider: ExternalProvider;
  aiModel: string;
  autoClassify: boolean;
  autoDeleteFailedTasks: boolean;
  subtaskSource: SubtaskSource;
  groupBy: GroupBy;
  reportTime: string;
  reportAutoGenerate: boolean;
  language: string;
  scope: Scope;
}

const SECTION = 'taskMind';

export function readConfig(): TaskMindConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    autoCaptureEnabled: c.get<boolean>('autoCapture.enabled', true),
    idleGapMinutes: c.get<number>('capture.idleGapMinutes', 20),
    pollIntervalSeconds: c.get<number>('capture.pollIntervalSeconds', 3),
    backfillDays: c.get<number>('capture.backfillDays', 1),
    aiProvider: c.get<AiProvider>('ai.provider', 'auto'),
    externalProvider: c.get<ExternalProvider>('ai.externalProvider', 'anthropic'),
    aiModel: c.get<string>('ai.model', ''),
    autoClassify: c.get<boolean>('hierarchy.autoClassify', true),
    autoDeleteFailedTasks: c.get<boolean>('autoDeleteFailedTasks', true),
    subtaskSource: c.get<SubtaskSource>('hierarchy.subtaskSource', 'both'),
    // Map giá trị cũ: 'day' → 'day-project'; 'project'/'epic'/khác → 'project-day'.
    groupBy: ['day', 'day-project'].includes(c.get<string>('tree.groupBy', 'project-day')) ? 'day-project' : 'project-day',
    reportTime: c.get<string>('report.time', '18:00'),
    reportAutoGenerate: c.get<boolean>('report.autoGenerate', true),
    language: c.get<string>('language', 'vi'),
    scope: c.get<Scope>('scope', 'global'),
  };
}

export async function updateConfig<T>(key: string, value: T, target = vscode.ConfigurationTarget.Global): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

export function onConfigChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      listener();
    }
  });
}
