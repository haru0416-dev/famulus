/** ホストの時間帯で日付境界が変わらないよう固定する。個別の timezone 検査は Config を再設置して切り替える。 */
process.env.TZ = "Asia/Tokyo"
process.env.FAMULUS_TZ = "Asia/Tokyo"

// 実モデルは初回にネットワークから取得するので、ゲートが外へ出ないよう stub に固定する。
process.env.FAMULUS_EMBEDDING = "stub"
