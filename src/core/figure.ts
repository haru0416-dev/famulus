/**
 * 図の作成。モデルは宣言 spec(ECharts option の JSON / graphviz の dot / カードの中身)だけを
 * 書き、描画はここが決定的に行う — SVG をモデルに直書きさせない(座標計算で破綻する)。
 *
 * チャートと図解は SVG を経由して resvg で PNG 化。カードは takumi の一段構成。
 * spec の誤りは読める文で返す — 呼んだモデルが直せる形にする。
 */
import { existsSync } from "node:fs"

/** 日本語の出るフォント。先に見つかったものを使う。無ければ文字が出ないまま描く(形は出る)。 */
const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
  "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

export const fontPath = (): string | undefined => FONT_CANDIDATES.find((p) => existsSync(p))

/**
 * 図のテーマ。出力先が Discord(暗い面)なので dark 面の値で1つに決める。
 * 系列7色は CVD 分離・明度帯・面とのコントラストを検証器で通した組(順序固定・循環させない)。
 * 文字は文字色だけを着る — 系列色を文字に使わない。
 */
const T = {
  surface: "#1a1a19",
  text: "#ffffff",
  text2: "#c3c2b7",
  muted: "#85847c",
  grid: "#2e2e2c",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
} as const

const axisTheme = {
  axisLine: { lineStyle: { color: T.grid } },
  axisTick: { lineStyle: { color: T.grid } },
  axisLabel: { color: T.text2 },
  splitLine: { lineStyle: { color: T.grid } },
  nameTextStyle: { color: T.text2 },
}

/** ECharts のテーマ。線2px・棒の先端 4px 丸・目盛りと格子は退く。 */
const ECHARTS_THEME = {
  color: [...T.series],
  backgroundColor: T.surface,
  textStyle: { color: T.text2 },
  title: { textStyle: { color: T.text, fontSize: 18 }, subtextStyle: { color: T.muted } },
  legend: { textStyle: { color: T.text2 } },
  categoryAxis: axisTheme,
  valueAxis: axisTheme,
  timeAxis: axisTheme,
  logAxis: axisTheme,
  line: { lineStyle: { width: 2 }, symbolSize: 7 },
  bar: { itemStyle: { borderRadius: [4, 4, 0, 0] } },
  tooltip: { show: false },
}

export interface Figure {
  readonly svg: string
  readonly png: Uint8Array
}

export class FigureError extends Error {}

const toPng = async (svg: string): Promise<Uint8Array> => {
  const { Resvg } = await import("@resvg/resvg-js")
  const font = fontPath()
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      ...(font ? { fontFiles: [font], defaultFontFamily: "IPAPGothic" } : {}),
    },
  })
  return new Uint8Array(resvg.render().asPng())
}

/**
 * ECharts option(JSON 文字列)からチャートを描く。SSR は DOM 不要。
 * animation は必ず切る — SSR の SVG は既定で CSS アニメを含み、静止画にならない。
 */
export const renderChart = async (optionJson: string, width = 800, height = 480): Promise<Figure> => {
  let option: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(optionJson)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("option はオブジェクト")
    option = parsed as Record<string, unknown>
  } catch (e) {
    throw new FigureError(`option_json が JSON として読めない: ${e instanceof Error ? e.message : String(e)}`)
  }
  const echarts = await import("echarts")
  echarts.registerTheme("famulus", ECHARTS_THEME)
  const chart = echarts.init(null, "famulus", { renderer: "svg", ssr: true, width, height })
  try {
    // 余白の既定。title と legend が重ならない高さを空ける。option 側の指定が勝つ。
    const legend = option.legend
    const spaced = {
      grid: { top: 84, left: 56, right: 28, bottom: 44, containLabel: true },
      ...option,
      ...(typeof legend === "object" && legend !== null && !("top" in legend)
        ? { legend: { ...legend, top: 40 } }
        : {}),
    }
    chart.setOption({ ...spaced, animation: false })
    const svg = chart.renderToSVGString()
    return { svg, png: await toPng(svg) }
  } catch (e) {
    throw new FigureError(`ECharts が描けなかった: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    chart.dispose()
  }
}

/** graphviz の dot から図解を描く。dot の構文エラーは graphviz の文言のまま返す。 */
export const renderDiagram = async (dot: string): Promise<Figure> => {
  const { Graphviz } = await import("@hpcc-js/wasm-graphviz")
  const graphviz = await Graphviz.load()
  let svg: string
  try {
    svg = graphviz.dot(dot, "svg")
  } catch (e) {
    throw new FigureError(`dot が描けなかった: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { svg, png: await toPng(svg) }
}

export interface CardSpec {
  readonly title: string
  readonly lines: readonly string[]
  readonly footer?: string
}

/** 統計カード。レイアウトはここで固定 — モデルが書くのは中身だけ。 */
export const renderCard = async (spec: CardSpec, width = 800): Promise<Uint8Array> => {
  const { Renderer } = await import("@takumi-rs/core")
  const { container, text } = await import("@takumi-rs/helpers")
  const renderer = new Renderer()
  const font = fontPath()
  if (font) {
    const { readFileSync } = await import("node:fs")
    await renderer.registerFont({ data: readFileSync(font) })
  }
  const height = 150 + spec.lines.length * 40 + (spec.footer ? 44 : 0)
  const node = container({
    style: {
      width,
      height,
      backgroundColor: T.surface,
      color: T.text,
      display: "flex",
      flexDirection: "row",
    },
    children: [
      // 左の帯1本だけが色を着る。文字は文字色(スキルの規律: 系列色を文字に使わない)。
      container({ style: { width: 8, height, flexShrink: 0, backgroundColor: T.series[0] } }),
      container({
        style: {
          width: width - 8,
          height,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 44,
          gap: 12,
        },
        children: [
          text(spec.title, { fontSize: 34, color: T.text }),
          ...spec.lines.map((line) => text(line, { fontSize: 21, color: T.text2 })),
          ...(spec.footer ? [text(spec.footer, { fontSize: 16, color: T.muted })] : []),
        ],
      }),
    ],
  })
  const png = await renderer.render(node, { width, height, format: "png" })
  return new Uint8Array(png)
}
