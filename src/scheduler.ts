import { log } from './log';

/** Hẹn giờ bắn báo cáo ngày vào HH:MM giờ địa phương; tự lên lịch lại sau mỗi lần. */
export class ReportScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly getTime: () => string,
    private readonly isEnabled: () => boolean,
    private readonly onFire: () => void,
  ) {}

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  reschedule(): void {
    this.stop();
    if (!this.isEnabled()) {
      return;
    }
    const ms = this.msUntilNext(this.getTime());
    this.timer = setTimeout(() => {
      try {
        this.onFire();
      } finally {
        this.reschedule();
      }
    }, ms);
    log(`Báo cáo ngày sẽ chạy sau ~${Math.round(ms / 60000)} phút.`);
  }

  private msUntilNext(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    const hour = m ? Math.min(23, Number(m[1])) : 18;
    const minute = m ? Math.min(59, Number(m[2])) : 0;
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
  }
}
