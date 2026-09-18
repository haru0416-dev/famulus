/** モデルには宣言 spec だけを書かせる。SVG を直書きさせると座標計算で破綻する。 */
import { existsSync } from "node:fs"

/** 無ければ文字が出ないまま描く。 */
const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
  "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

export const fontPath = (): string | undefined => FONT_CANDIDATES.find((p) => existsSync(p))

/**
 * 出力先の Discord は暗い背景なので dark の値だけを持つ。系列7色は色覚差とコントラストを検証した組なので
 * 順序を変えず循環させない。系列色を文字に使わない。
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

/** SSR の SVG は既定で CSS アニメを含み静止画にならないので animation を必ず切る。 */
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
    // title と legend が重ならない既定の余白。option 側の指定が優先する。
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

/** レイアウトはここで固定し、モデルには中身だけを書かせる。 */
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
