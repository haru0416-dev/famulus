# famulus

Haru の代わりに AI の動向を追い、外に出す文を書く常駐エージェント。
Bun + TypeScript + Effect + SQLite(bun:sqlite)。

- 開発の規律・検証手順: `AGENTS.md`(`CLAUDE.md` は symlink)
- 人格の正本: `SOUL.md`
- 実行環境の状態: `~/.famulus/`(この repo には状態を置かない)
- 操作の入口: `bun run fam status` / `bun run fam journal`(CLI 全体は `bun run fam` で一覧)
- ゲート: `bun run gate`(型 + lint + テスト + カバレッジ)
- 常駐 unit: famulus-{cycle,poll,presence,web}(systemd --user)
