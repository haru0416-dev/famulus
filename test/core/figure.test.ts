/**
 * 図の作成の検査。描画ライブラリは実物(ローカル・ネットワーク不要)。
 * 見るのは「spec から決定的に画像が出ること」と「spec の誤りが読める文で返ること」。
 * 見た目の質はここでは判定しない — それは実運用と Haru の目が担う。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { FigureError, renderCard, renderChart, renderDiagram } from "../../src/core/figure.ts"

const isPng = (bytes: Uint8Array): boolean =>
  bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71

test("chart — ECharts option の JSON から SVG と PNG が出る", async () => {
  const fig = await renderChart(
    JSON.stringify({
      xAxis: { type: "category", data: ["月", "火", "水"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: [3, 7, 5] }],
    }),
    400,
    300,
  )
  assert.ok(fig.svg.includes("<svg"))
  assert.ok(isPng(fig.png))
})

test("chart — 壊れた JSON は読める文で拒否する", async () => {
  await assert.rejects(() => renderChart("{壊れてる"), FigureError)
  await assert.rejects(() => renderChart('["配列"]'), FigureError)
})

test("diagram — dot から PNG が出て、構文エラーは graphviz の文言で返る", async () => {
  const fig = await renderDiagram('digraph { 受信 -> 記述 -> "返信に載る" }')
  assert.ok(fig.svg.includes("<svg"))
  assert.ok(isPng(fig.png))
  await assert.rejects(() => renderDiagram("digraph { 閉じてない"), FigureError)
})

test("card — 中身だけ渡してカード PNG が出る", async () => {
  const png = await renderCard({ title: "週報", lines: ["dossier 8件", "新規率 64%"], footer: "famulus" })
  assert.ok(isPng(png))
})
