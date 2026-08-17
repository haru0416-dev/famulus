/**
 * 図の作成。モデルは宣言 spec(ECharts option の JSON / graphviz の dot / カードの中身)だけを
 * 書き、描画はここが決定的に行う — SVG をモデルに直書きさせない(座標計算で破綻する)。
 *
 * チャートと図解は SVG を経由して resvg で PNG 化。カードは takumi の一段構成。
 * spec の誤りは読める文で返す — 呼んだモデルが直せる形にする。
 * 選定の経緯と実測は docs/image-line-survey-2026-08-17.md。
 */
import { existsSync } from "node:fs"

/** 日本語の出るフォント。先に見つかったものを使う。無ければ文字が出ないまま描く(形は出る)。 */
const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
  "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

export const fontPath = (): string | undefined => FONT_CANDIDATES.find((p) => existsSync(p))

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
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height })
  try {
    chart.setOption({ ...option, animation: false })
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
  const height = 140 + spec.lines.length * 40 + (spec.footer ? 48 : 0)
  const node = container({
    style: {
      width,
      height,
      backgroundColor: "#1a1a2e",
      color: "#ffffff",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      padding: 48,
      gap: 14,
    },
    children: [
      text(spec.title, { fontSize: 38 }),
      ...spec.lines.map((line) => text(line, { fontSize: 22, color: "#a0c0ff" })),
      ...(spec.footer ? [text(spec.footer, { fontSize: 18, color: "#8888aa" })] : []),
    ],
  })
  const png = await renderer.render(node, { width, height, format: "png" })
  return new Uint8Array(png)
}
