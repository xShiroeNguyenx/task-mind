import { CaptureEvent } from '../types';
import { projectKeyFromCwd, truncate } from '../util';

/** Tiền tố của các dòng "user" do IDE/hệ thống tự chèn — không phải yêu cầu thật. */
const SYNTHETIC_PREFIXES = [
  '<ide_opened_file>',
  '<ide_selection>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local command caveat',
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'This session is being continued from a previous conversation',
  'API Error',
];

function isSynthetic(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_PREFIXES.some((p) => t.startsWith(p)) || /caveat:/i.test(t.slice(0, 40));
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  input?: any;
}

function extractTextParts(content: any): { text: string; hasToolResult: boolean } {
  if (typeof content === 'string') {
    return { text: content, hasToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasToolResult: false };
  }
  let text = '';
  let hasToolResult = false;
  for (const part of content as ContentPart[]) {
    if (part.type === 'tool_result') {
      hasToolResult = true;
    } else if (part.type === 'text' && typeof part.text === 'string') {
      text += (text ? '\n' : '') + part.text;
    }
  }
  return { text, hasToolResult };
}

function extractTodos(content: any): Array<{ content: string; status: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content as ContentPart[]) {
    if (part.type === 'tool_use' && part.name === 'TodoWrite' && part.input && Array.isArray(part.input.todos)) {
      return part.input.todos.map((t: any) => ({
        content: String(t.content ?? t.activeForm ?? ''),
        status: String(t.status ?? 'pending'),
      }));
    }
  }
  return undefined;
}

/**
 * Chuyển một dòng JSON của transcript thành 0..n CaptureEvent.
 * Lọc: bỏ subagent (isSidechain), tool_result, dòng tự chèn của IDE.
 */
export function parseTranscriptLine(obj: any, newId: () => string): CaptureEvent[] {
  if (!obj || typeof obj !== 'object') {
    return [];
  }
  const events: CaptureEvent[] = [];
  const ts: string = obj.timestamp || obj.ts || new Date().toISOString();
  const sessionId: string = obj.sessionId || obj.session_id || '';
  const cwd: string = obj.cwd || '';
  const lineUuid: string = obj.uuid || obj.lineUuid || newId();
  const promptId: string = obj.promptId || obj.prompt_id || lineUuid;

  // ai-title (tiêu đề phiên do Claude Code sinh)
  const aiTitle: string | undefined =
    obj.type === 'ai-title' ? obj.title || obj.aiTitle : obj.aiTitle;
  if (aiTitle && sessionId) {
    events.push({ type: 'session_meta', eventId: newId(), ts, sessionId, cwd, aiTitle });
  }

  if (obj.type === 'user' && obj.message) {
    if (obj.isSidechain) {
      return events;
    }
    const { text, hasToolResult } = extractTextParts(obj.message.content);
    if (hasToolResult || !text.trim() || isSynthetic(text)) {
      return events;
    }
    events.push({
      type: 'human_turn',
      eventId: newId(),
      ts,
      sessionId,
      promptId,
      lineUuid,
      cwd,
      projectKey: projectKeyFromCwd(cwd),
      text: text.trim(),
      gitBranch: obj.gitBranch,
      version: obj.version,
      entrypoint: obj.entrypoint,
    });
  } else if (obj.type === 'assistant' && obj.message) {
    const { text } = extractTextParts(obj.message.content);
    if (text.trim()) {
      events.push({
        type: 'assistant_text',
        eventId: newId(),
        ts,
        sessionId,
        promptId,
        lineUuid,
        cwd,
        textExcerpt: truncate(text, 500),
        model: obj.message.model || obj.model,
      });
    }
    const todos = extractTodos(obj.message.content);
    if (todos && todos.length && sessionId) {
      events.push({ type: 'agent_todo', eventId: newId(), ts, sessionId, cwd, todos });
    }
  }

  return events;
}
