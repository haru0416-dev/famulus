/**
 * 各検査ファイルを走らせる前に通す(`vitest.config.ts` の `setupFiles`)。時間帯を固定する。
 *
 * 実行環境の既定値に任せると、走らせるホストによって日付境界が変わる。
 * `src/core/time.ts` は設置済みConfigの `OPEN_ZERO_TZ` を使うので、走らせる側が違うと
 * 日付の切れ目が 9 時間ずれ、`attention.test.ts` の
 * 「18:00 は 17 時を過ぎている」が偽になる(bun で 1件落ちた)。
 *
 * ここで固定しておけば、どのホストのどの走らせ方でも同じ日付境界になる。
 * 個別のtimezone検査はConfigを再設置して切り替える。
 */
process.env.TZ = "Asia/Tokyo"
process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
