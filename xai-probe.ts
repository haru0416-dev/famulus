// 実DB に書き込み、実クォータを使う。
import * as Effect from "effect/Effect"
import * as v from "valibot"
import { configureApp } from "./src/core/config.ts"
import { loadEnv } from "./src/core/env.ts"
import { Runner } from "./src/model/Runner.ts"
import { rs } from "./src/model/schema.ts"
import { run, runtime } from "./src/runtime.ts"
import { Db } from "./src/services/Db.ts"

loadEnv()
configureApp()
const rt = runtime()
try {
  const out = await run(
    Effect.flatMap(Runner, (r) =>
      r.run({
        role: "structurer",
        kind: "xai-e2e-probe",
        prompt: "次のJSONだけを返す: ok=true、note=「疎通」",
        schema: rs(v.object({ ok: v.boolean(), note: v.string() })),
      }),
    ),
  )
  console.log("text:", out.text.slice(0, 120))
  console.log("structured:", JSON.stringify(out.structured))
  console.log("model:", out.model)
  console.log("usage:", JSON.stringify(out.usage))
  const row = await run(
    Effect.flatMap(Db, (db) =>
      db.get("SELECT role, model, provenance FROM ledger WHERE kind = 'xai-e2e-probe' ORDER BY seq DESC LIMIT 1"),
    ),
  )
  console.log("ledger:", JSON.stringify(row))
} finally {
  await rt.dispose()
}
