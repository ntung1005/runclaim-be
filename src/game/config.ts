// Phải khớp với runclaim_app/lib/core/config.dart của app.
export const GAME = {
  hexSizeMeters: 100,
  // Chiếm ô phải chạy băng qua ô: điểm xa nhất cách điểm vào ô
  // >= crossRatio x đường chéo (2 x hexSizeMeters): 70% x 200 m = 140 m.
  crossRatio: 0.7,
  maxRunSpeedMps: 7,
  maxAccuracyMeters: 30,
  minPointDistanceMeters: 3,
  suspiciousRatioToInvalidate: 0.3,
  maxSamples: 30_000,
  maxDurationHours: 24,
  // Vòng khép kín (đơn vị: mét / m² trên mặt phẳng Mercator).
  loopCloseMeters: 40,
  loopMinMeters: 300,
  loopMinAreaM2: 5_000,
  loopMaxAreaM2: 3_000_000,
  loopMaxCells: 3_000,
} as const;
