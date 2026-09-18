# famulus

Haru の代わりに AI の動向を追い、外に出す文を書く常駐エージェント。
Bun + TypeScript + Effect + SQLite(bun:sqlite)。

- 開発の規律・検証手順: `AGENTS.md`(`CLAUDE.md` は symlink)
- 人格の正本: `SOUL.md`
- 実行環境の状態: `~/.famulus/`(この repo には状態を置かない)
- 操作の入口: `bun run fam status` / `bun run fam journal`(CLI 全体は `bun run fam` で一覧)
- ゲート: `bun run gate`(型 + lint + テスト + カバレッジ)
- 常駐 unit: famulus-{cycle,poll,presence,web}(systemd --user)

## Sandbox の公開通信

`shell` と `experiment` は通常オフラインで動く。`net=true` の初回呼び出しは承認を申請し、コマンドを実行しない。
Discord の承認カードか `bun run fam show <id>` でコマンドと workspace を確認する。
`bun run fam approve <id>` またはカードの承認操作の後、同じ操作を呼び直すと1回だけ実行できる。
承認対象はコマンド文字列と workspace であり、workspace 内のファイル内容を固定するものではない。
公開先へ任意の内容を送信できるため、取得専用の許可ではない。

許可は申請から1日で失効する。起動前に使用済みとして記録するので、起動失敗や中断でも再利用できない。
`experiment` の実行と検査、`fam selfdev` の依存取得とゲートには、それぞれ別の承認が要る。
使用済み時刻は `fam show <id>` で確認できる。一般の提案は承認しても自動実行しない。

## 記録と抹消

`fam journal` は実行IDが一致する記録だけを集計する。IDのない旧記録は数量不明と表示し、時刻から帰属を推測しない。
返信のキュー保存に失敗した入力は未読のまま残す。保存後の配送失敗は配送状態に従って処理し、結果不明の送信を自動再送しない。

`Memory.redact` は指定イベントの本文・検索索引・引用を消し、そのイベントを根拠に持つ引用も消す。
参照している belief の値そのもの、元資料、バックアップは消さない。イベントIDと参照関係は保持する。
DBを次に開く際の移行で、すでに抹消済みのイベントに残る引用も削除する。
