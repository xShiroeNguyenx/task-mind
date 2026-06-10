/** Client AI tối giản: nhận system+user, trả text (hoặc undefined nếu không khả dụng). */
export interface AiClient {
  readonly name: string;
  /** Lý do lỗi gần nhất (để chẩn đoán). */
  lastError?: string;
  isAvailable(): Promise<boolean>;
  complete(system: string, user: string): Promise<string | undefined>;
}
