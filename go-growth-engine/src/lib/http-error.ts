// Uç noktanın belirli bir durum koduyla dönmesi gereken hatalar (ör. 429, 503).
// publicMessage dışarıya gider; ayrıntı yalnız loga yazılır.
export class HttpError extends Error {
  constructor(
    public status: number,
    public publicMessage: string,
    detail?: string
  ) {
    super(detail ?? publicMessage);
  }
}
