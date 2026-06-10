import { AiProvider, ExternalProvider } from '../config';
import { warn } from '../log';
import { AiClient } from './providers/ai-client';
import { ExternalApiClient } from './providers/external-api';
import { VsCodeLmClient } from './providers/vscode-lm';

export interface AiEngineOptions {
  provider: AiProvider;
  externalProvider: ExternalProvider;
  model: string;
  getApiKey: () => Promise<string | undefined>;
}

export interface SummaryResult {
  title: string;
  summary: string;
}
export interface JudgeResult {
  sameTask: boolean;
  confidence: number;
}
export interface ClassifyResult {
  epicId: string | null;
  epicTitle: string;
  confidence: number;
}

function extractJson(text: string): any | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }
  for (let end = text.length; end > start; end--) {
    const slice = text.slice(start, end);
    try {
      return JSON.parse(slice);
    } catch {
      // thử cắt ngắn hơn
    }
  }
  return undefined;
}

/**
 * Bộ não AI: chọn 1 client theo cấu hình; mọi method trả undefined nếu AI không khả
 * dụng/ lỗi → caller dùng heuristic. Cùng client phục vụ tóm tắt + judge + classify.
 */
export class AiEngine {
  private resolved = false;
  private _client: AiClient | undefined;

  constructor(private readonly opts: AiEngineOptions) {}

  private async client(): Promise<AiClient | undefined> {
    if (this.resolved) {
      return this._client;
    }
    this.resolved = true;
    const { provider, externalProvider, model, getApiKey } = this.opts;
    try {
      if (provider === 'heuristic') {
        this._client = undefined;
      } else if (provider === 'vscode-lm') {
        const c = new VsCodeLmClient(model);
        this._client = (await c.isAvailable()) ? c : undefined;
      } else if (provider === 'external') {
        const c = new ExternalApiClient(externalProvider, await getApiKey(), model);
        this._client = (await c.isAvailable()) ? c : undefined;
      } else {
        // auto: vscode-lm → external
        const lm = new VsCodeLmClient(model);
        if (await lm.isAvailable()) {
          this._client = lm;
        } else {
          const ext = new ExternalApiClient(externalProvider, await getApiKey(), model);
          this._client = (await ext.isAvailable()) ? ext : undefined;
        }
      }
    } catch (e) {
      warn(`AiEngine resolve lỗi: ${String(e)}`);
      this._client = undefined;
    }
    return this._client;
  }

  /** Buộc resolve lại (vd khi đổi cấu hình / vừa nhập key). */
  reset(): void {
    this.resolved = false;
    this._client = undefined;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.client()) !== undefined;
  }

  /** Tên engine đã resolve để báo cho người dùng ('vscode-lm' | 'external' | 'heuristic'). */
  async resolvedName(): Promise<string> {
    const c = await this.client();
    return c?.name ?? 'heuristic';
  }

  /** Lý do lỗi gần nhất của client đã resolve (để chẩn đoán). */
  lastError(): string | undefined {
    return this._client?.lastError;
  }

  /**
   * So khớp một prompt mới với danh sách task đang mở. Trả taskId khớp (cùng mục
   * tiêu/tính năng) hoặc null (việc mới). undefined nếu AI không khả dụng.
   */
  async matchTask(
    prompt: string,
    candidates: Array<{ id: string; title: string; summary: string }>,
  ): Promise<{ taskId: string | null; confidence: number } | undefined> {
    const c = await this.client();
    if (!c || candidates.length === 0) {
      return undefined;
    }
    const system =
      'Bạn quyết định một YÊU CẦU MỚI có thuộc về một task đang làm trong danh sách không ' +
      '(cùng mục tiêu/tính năng/feature, kể cả khi là sửa lỗi hay mở rộng nó), hay là một việc HOÀN TOÀN MỚI. ' +
      'Chỉ chọn taskId khi thực sự cùng một việc. Trả JSON {"taskId": "<id>"|null, "confidence": 0..1}.';
    const list = candidates
      .map((c2) => `- ${c2.id}: ${c2.title}${c2.summary ? ` — ${c2.summary}` : ''}`)
      .join('\n');
    const user = `Các task đang làm:\n${list}\n\nYêu cầu mới: ${prompt}`;
    const out = await c.complete(system, user);
    if (!out) {
      return undefined;
    }
    const json = extractJson(out);
    if (json && (typeof json.taskId === 'string' || json.taskId === null)) {
      return { taskId: json.taskId, confidence: Number(json.confidence ?? 0.5) };
    }
    return undefined;
  }

  async summarize(humanTurns: string[], assistant: string[], projectName?: string): Promise<SummaryResult | undefined> {
    const c = await this.client();
    if (!c) {
      return undefined;
    }
    const system =
      'Bạn đặt TIÊU ĐỀ và tóm tắt cho một task lập trình. ' +
      'QUY TẮC TIÊU ĐỀ (quan trọng): viết dạng "Động từ + đối tượng", NGẮN GỌN ≤ 8 từ, nêu đúng VIỆC CỐT LÕI; ' +
      'TUYỆT ĐỐI KHÔNG chép lại nguyên câu của người dùng, không lan man, không câu nệ chữ thừa. ' +
      'Nếu có tên dự án, thêm "cho <tên dự án>" ở cuối tiêu đề. ' +
      'Ví dụ: "Fix lỗi npx cho dự án X", "Tạo favicon cho demo Y", "Thêm đăng nhập Google cho Z". ' +
      'Trả JSON {"title": "...", "summary": "..."} bằng tiếng Việt (theo ngôn ngữ nội dung). summary ≤ 2 câu (mục tiêu & kết quả).';
    const projLine = projectName ? `Tên dự án: ${projectName}\n` : '';
    const user = `${projLine}Các yêu cầu của người dùng:\n${humanTurns.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nTrích phản hồi AI:\n${assistant.slice(0, 3).join('\n---\n')}`;
    const out = await c.complete(system, user);
    if (!out) {
      return undefined;
    }
    const json = extractJson(out);
    if (json && typeof json.title === 'string') {
      return { title: String(json.title).slice(0, 120), summary: String(json.summary ?? '') };
    }
    return undefined;
  }

  async judgeSameTask(openSummary: string, recentTurns: string[], newText: string): Promise<JudgeResult | undefined> {
    const c = await this.client();
    if (!c) {
      return undefined;
    }
    const system =
      'Bạn quyết định một yêu cầu mới có thuộc CÙNG một task đang làm hay là task MỚI. Trả JSON {"sameTask": true|false, "confidence": 0..1}.';
    const user = `Task đang làm: ${openSummary}\nVài lượt gần đây:\n${recentTurns.slice(-3).join('\n')}\n\nYêu cầu mới: ${newText}`;
    const out = await c.complete(system, user);
    if (!out) {
      return undefined;
    }
    const json = extractJson(out);
    if (json && typeof json.sameTask === 'boolean') {
      return { sameTask: json.sameTask, confidence: Number(json.confidence ?? 0.5) };
    }
    return undefined;
  }

  async classifyEpic(taskText: string, epics: Array<{ id: string; title: string }>): Promise<ClassifyResult | undefined> {
    const c = await this.client();
    if (!c) {
      return undefined;
    }
    const system =
      'Bạn gán một task vào một Epic (chủ đề lớn). Nếu khớp Epic có sẵn, trả epicId của nó; nếu không, đặt epicId=null và đề xuất epicTitle ngắn. Trả JSON {"epicId": string|null, "epicTitle": "...", "confidence": 0..1}.';
    const list = epics.map((e) => `- ${e.id}: ${e.title}`).join('\n') || '(chưa có Epic nào)';
    const user = `Epic hiện có:\n${list}\n\nTask: ${taskText}`;
    const out = await c.complete(system, user);
    if (!out) {
      return undefined;
    }
    const json = extractJson(out);
    if (json && typeof json.epicTitle === 'string') {
      return {
        epicId: typeof json.epicId === 'string' ? json.epicId : null,
        epicTitle: String(json.epicTitle).slice(0, 60),
        confidence: Number(json.confidence ?? 0.5),
      };
    }
    return undefined;
  }

  async decompose(taskText: string): Promise<string[] | undefined> {
    const c = await this.client();
    if (!c) {
      return undefined;
    }
    const system =
      'Bạn chẻ một task thành 3-6 bước nhỏ (subtask) ngắn gọn. Trả JSON mảng chuỗi, bằng ngôn ngữ của task.';
    const out = await c.complete(system, `Task: ${taskText}`);
    if (!out) {
      return undefined;
    }
    const json = extractJson(out);
    if (Array.isArray(json)) {
      return json.map((x) => String(x)).filter((s) => s.trim().length > 0).slice(0, 6);
    }
    return undefined;
  }
}
