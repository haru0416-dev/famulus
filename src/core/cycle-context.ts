import { AsyncLocalStorage } from "node:async_hooks"

const cycleContext = new AsyncLocalStorage<string>()

/** 対話入力など cycle の外で起きた仕事には付けない。 */
export const currentCycleId = (): string | undefined => cycleContext.getStore()

export const withCycleContext = <T>(id: string, body: () => T): T => cycleContext.run(id, body)
