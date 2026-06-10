import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CaptureEvent } from '../types';
import { parseTranscriptLine } from './line-parser';
import { error, log, warn } from '../log';

interface Cursor {
  size: number;
  offset: number;
}

/**
 * Theo dõi cây ~/.claude/projects/<...>/*.jsonl bằng polling + tail-read tăng dần.
 * Dùng polling (không phải FileSystemWatcher) vì transcript nằm ngoài workspace —
 * trên Windows native watcher cho path ngoài workspace không đáng tin.
 */
export class TranscriptWatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly cursors = new Map<string, Cursor>();
  private readonly cursorFile: string;
  private readonly projectsRoot: string;
  private ticking = false;

  constructor(
    storageDir: string,
    private readonly onEvents: (events: CaptureEvent[]) => Promise<void>,
    private readonly newId: () => string,
    projectsRoot?: string,
    private readonly onInitialDone?: () => void,
  ) {
    this.cursorFile = path.join(storageDir, 'cursors.json');
    this.projectsRoot = projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  }

  async start(pollSeconds: number): Promise<void> {
    await this.loadCursors();
    // Lần quét đầu (backfill) chạy NỀN, không chặn caller; báo xong qua onInitialDone.
    void (async () => {
      await this.tick();
      this.onInitialDone?.();
    })();
    this.timer = setInterval(() => void this.tick(), Math.max(1, pollSeconds) * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.saveCursors();
  }

  private async loadCursors(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.cursorFile, 'utf8');
      const obj = JSON.parse(raw) as Record<string, Cursor>;
      for (const [k, v] of Object.entries(obj)) {
        this.cursors.set(k, v);
      }
    } catch {
      // chưa có file cursor — bình thường
    }
  }

  private async saveCursors(): Promise<void> {
    try {
      const obj: Record<string, Cursor> = {};
      for (const [k, v] of this.cursors.entries()) {
        obj[k] = v;
      }
      await fs.promises.mkdir(path.dirname(this.cursorFile), { recursive: true });
      await fs.promises.writeFile(this.cursorFile, JSON.stringify(obj), 'utf8');
    } catch (e) {
      warn(`Không lưu được cursors: ${String(e)}`);
    }
  }

  private async listTranscripts(): Promise<string[]> {
    const files: string[] = [];
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.promises.readdir(this.projectsRoot);
    } catch {
      return files;
    }
    for (const d of projectDirs) {
      const dir = path.join(this.projectsRoot, d);
      let entries: string[] = [];
      try {
        const stat = await fs.promises.stat(dir);
        if (!stat.isDirectory()) {
          continue;
        }
        entries = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) {
          files.push(path.join(dir, f));
        }
      }
    }
    return files;
  }

  /** Quét một vòng: đọc phần mới của mỗi file, parse, emit. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const files = await this.listTranscripts();
      let changed = false;
      const collected: CaptureEvent[] = [];
      for (const file of files) {
        let size = 0;
        try {
          size = (await fs.promises.stat(file)).size;
        } catch {
          continue;
        }
        const cursor = this.cursors.get(file) ?? { size: 0, offset: 0 };
        if (size === cursor.size && size === cursor.offset) {
          continue; // không đổi
        }
        if (size < cursor.offset) {
          cursor.offset = 0; // file bị cắt/ghi đè
        }
        const events = await this.readNew(file, cursor, size);
        if (events.length) {
          collected.push(...events);
        }
        this.cursors.set(file, cursor);
        changed = true;
      }
      if (collected.length) {
        await this.onEvents(collected);
      }
      if (changed) {
        await this.saveCursors();
      }
    } catch (e) {
      error('TranscriptWatcher tick lỗi', e);
    } finally {
      this.ticking = false;
    }
  }

  private async readNew(file: string, cursor: Cursor, size: number): Promise<CaptureEvent[]> {
    const length = size - cursor.offset;
    if (length <= 0) {
      cursor.size = size;
      return [];
    }
    let handle: fs.promises.FileHandle | undefined;
    const events: CaptureEvent[] = [];
    try {
      handle = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, cursor.offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) {
        // chưa có dòng hoàn chỉnh; chờ tick sau
        cursor.size = size;
        return [];
      }
      const processable = buf.subarray(0, lastNl + 1);
      const newOffset = cursor.offset + processable.length;
      for (const line of processable.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        events.push(...parseTranscriptLine(obj, this.newId));
      }
      cursor.offset = newOffset;
      cursor.size = size;
    } catch (e) {
      warn(`Đọc ${file} lỗi: ${String(e)}`);
    } finally {
      await handle?.close();
    }
    if (events.length) {
      log(`Bắt được ${events.length} event từ ${path.basename(file)}`);
    }
    return events;
  }
}
