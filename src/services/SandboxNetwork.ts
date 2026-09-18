import { basename, resolve } from "node:path"
import * as Effect from "effect/Effect"
import { Conflict } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"
import { type CreateInput, Proposals, payloadHash } from "./Proposals.ts"
import type { NetworkApproval } from "./Sandbox.ts"

export type SandboxNetworkPermission =
  | { readonly approved: true; readonly approval: NetworkApproval }
  | {
      readonly approved: false
      readonly id: string
      readonly proposal: CreateInput
      readonly message: string
    }

/** 承認はコマンドと絶対workspaceに固定する。取得用途でも任意の公開先へ送信できるため、用途名で免除しない。 */
export const prepareSandboxNetwork = (
  command: string,
  workDir: string,
  operation:
    | "shell"
    | "experiment-command"
    | "experiment-check"
    | "selfdev-install"
    | "selfdev-gate" = "shell",
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const proposals = yield* Proposals
    const dir = resolve(workDir)
    const payload = { kind: "sandbox-network", operation, command, workDir: dir }
    const serialized = JSON.stringify(payload)
    const at = nowIso()
    const existing = yield* db.get(
      `SELECT p.id,p.status FROM proposals p
        WHERE p.payload=? AND p.status IN ('proposed','approved') AND p.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM sandbox_network_uses u WHERE u.proposal_id=p.id)
        ORDER BY CASE p.status WHEN 'approved' THEN 0 ELSE 1 END,p.created_at LIMIT 1`,
      serialized,
      at,
    )
    const proposal: CreateInput = {
      summary: `Sandbox の公開通信を1回許可: ${basename(dir)}`,
      assessment: "このコマンドは公開インターネットへ任意の内容を送信できます。取得専用ではありません。",
      ask: "コマンドとworkspaceを確認し、公開通信を1回だけ許可しますか。承認後、同じ操作の再呼び出しで実行します。",
      what: command,
      when: "承認後の同一操作の再呼び出し1回。申請から1日以内。",
      who: "famulus",
      how: `workspace: ${dir}\ncommand:\n${command}`,
      howVerified:
        "起動前に承認済みpayloadを照合し、使用済み記録を確定する。起動失敗や中断でも再利用しない。",
      payload,
      pendingDays: 1,
    }
    const id = existing ? String(existing.id) : yield* proposals.create(proposal)
    if (existing?.status !== "approved") {
      return {
        approved: false,
        id,
        proposal,
        message: `走らせない: 公開通信の承認待ち ${id}。fam show ${id} で内容を確認し、fam approve ${id} で承認してから同じ操作を呼び直す。`,
      } satisfies SandboxNetworkPermission
    }
    const consume = db.withImmediateTransaction<void, Conflict>(
      "consume sandbox network approval",
      (tx, abort) => {
        const row = tx.get(
          `SELECT p.payload,p.status,p.expires_at,a.payload_hash
           FROM proposals p JOIN proposal_actions a ON a.proposal_id=p.id AND a.action='approve' AND a.actor='owner'
          WHERE p.id=?`,
          id,
        )
        if (
          row?.status !== "approved" ||
          String(row.expires_at) <= nowIso() ||
          row.payload !== serialized ||
          row.payload_hash !== payloadHash(serialized) ||
          tx.get("SELECT 1 FROM sandbox_network_uses WHERE proposal_id=?", id)
        ) {
          return abort(
            new Conflict({
              what: "Sandbox network approval",
              id,
              reason: "未承認・期限切れ・内容変更・使用済みのいずれか",
            }),
          )
        }
        tx.run("INSERT INTO sandbox_network_uses(proposal_id,used_at) VALUES (?,?)", id, nowIso())
      },
    )
    return {
      approved: true,
      approval: { command, workDir: dir, consume: () => Effect.runPromise(consume) },
    } satisfies SandboxNetworkPermission
  })
