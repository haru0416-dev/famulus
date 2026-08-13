/**
 * 検査を走らせる前に1回だけ通す(`bunfig.toml` の `[test] preload`)。時間帯を固定する。
 *
 * `bun test` は既定で `TZ=UTC` を立てる。`node --test` は立てない。
 * `src/core/time.ts` は読み込み時に `TZ` を1回だけ決めるので、
 * 走らせる側が違うと日付の切れ目が 9 時間ずれ、`attention.test.ts` の
 * 「18:00 は 17 時を過ぎている」が偽になる(bun で 1件落ちた)。
 *
 * ここで固定しておけば、どのホストのどの走らせ方でも同じ日付境界になる。
 * 検査ファイル側で `OPEN_ZERO_TZ` を差してから動的 import している所はそのままでよい —
 * 同じ値なので競合しない。
 */
process.env.TZ = "Asia/Tokyo"
process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
