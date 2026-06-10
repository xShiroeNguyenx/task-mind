import { BaseCaptureService } from './capture-service';

/**
 * Dịch vụ giả lập: dùng cho Phase 2/3 và lệnh dev. Nếu log trống thì gieo vài việc
 * mẫu để UI có dữ liệu hiển thị ngay.
 */
export class MockCaptureService extends BaseCaptureService {
  protected async onStart(): Promise<void> {
    if (this.log.getAll().length === 0) {
      await this.simulateTask();
      await this.simulateTask();
      await this.simulateTask();
    }
  }
}
