import { AsyncLocalStorage } from "node:async_hooks"

const cycleContext = new AsyncLocalStorage<string>()

/** 自動処理の実行ID。対話入力など、この回の外で起きた仕事には付けない。 */
export const currentCycleId = (): string | undefined => cycleContext.getStore()

/** body が非同期なら、Promise が終わるまで派生した呼び出しにもIDを引き継ぐ。 */
export const withCycleContext = <T>(id: string, body: () => T): T => cycleContext.run(id, body)
