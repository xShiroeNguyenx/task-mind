import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CaptureEvent } from '../types';
import { warn } from '../log';

/**
 * Event log append-only, lưu thành JSONL chia theo tháng trong globalStorage.
 * Đây là nguồn sự thật duy nhất; mọi Epic/Task/Subtask được tính lại từ đây.
 */
export class EventLog {
  private readonly rootDir: string;
  private readonly eventsDir: string;
  private events: CaptureEvent[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.eventsDir = path.join(rootDir, 'events');
  }

  get dir(): string {
    return this.rootDir;
  }

  newEventId(): string {
    return randomUUID();
  }

  async load(): Promise<CaptureEvent[]> {
    if (this.loaded) {
      return this.events;
    }
    await fs.promises.mkdir(this.eventsDir, { recursive: true });
    const all: CaptureEvent[] = [];
    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(this.eventsDir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const full = path.join(this.eventsDir, file);
      let content = '';
      try {
        content = await fs.promises.readFile(full, 'utf8');
      } catch (e) {
        warn(`Không đọc được ${full}: ${String(e)}`);
        continue;
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          all.push(JSON.parse(trimmed) as CaptureEvent);
        } catch {
          // bỏ qua dòng hỏng
        }
      }
    }
    all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.eventId < b.eventId ? -1 : 1));
    this.events = all;
    this.loaded = true;
    return this.events;
  }

  getAll(): CaptureEvent[] {
    return this.events;
  }

  /** Thêm một event: ghi xuống file (queue tuần tự) và cập nhật cache. */
  async append(event: CaptureEvent): Promise<void> {
    this.events.push(event);
    const shard = this.shardFor(event.ts);
    const line = JSON.stringify(event) + '\n';
    this.writeChain = this.writeChain.then(async () => {
      await fs.promises.mkdir(this.eventsDir, { recursive: true });
      await fs.promises.appendFile(shard, line, 'utf8');
    });
    return this.writeChain;
  }

  async appendMany(events: CaptureEvent[]): Promise<void> {
    for (const ev of events) {
      await this.append(ev);
    }
  }

  /** Đợi mọi thao tác ghi hoàn tất (dùng khi test / shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Thay toàn bộ log bằng `events` MỘT CÁCH AN TOÀN: backup các shard cũ sang thư mục
   * .bak trước, ghi mới; nếu lỗi thì khôi phục. Dùng cho thao tác "dựng lại".
   */
  async replaceAll(events: CaptureEvent[]): Promise<void> {
    await this.flush();
    await fs.promises.mkdir(this.eventsDir, { recursive: true });
    let oldFiles: string[] = [];
    try {
      oldFiles = (await fs.promises.readdir(this.eventsDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      oldFiles = [];
    }
    const backupDir = `${this.eventsDir}.bak-${Date.now()}`;
    if (oldFiles.length) {
      await fs.promises.mkdir(backupDir, { recursive: true });
      for (const f of oldFiles) {
        await fs.promises.rename(path.join(this.eventsDir, f), path.join(backupDir, f));
      }
    }
    this.events = [];
    this.loaded = true;
    this.writeChain = Promise.resolve();
    try {
      await this.appendMany(events);
      await this.flush();
      warn(`Đã dựng lại event log (${events.length} event). Backup: ${oldFiles.length ? backupDir : '(không có)'}`);
    } catch (e) {
      // khôi phục từ backup
      if (oldFiles.length) {
        for (const f of oldFiles) {
          try {
            await fs.promises.rename(path.join(backupDir, f), path.join(this.eventsDir, f));
          } catch {
            /* ignore */
          }
        }
      }
      this.loaded = false;
      await this.load();
      throw e;
    }
  }

  private shardFor(ts: string): string {
    // ts dạng ISO: yyyy-mm-...  → lấy "yyyy-mm"
    const ym = /^(\d{4})-(\d{2})/.exec(ts);
    const name = ym ? `${ym[1]}-${ym[2]}` : 'unknown';
    return path.join(this.eventsDir, `${name}.jsonl`);
  }
}
