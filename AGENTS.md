# famulus

Haru の代わりに AI の動向を追い、外に出す文を書く常駐エージェント。
Bun + TypeScript + Effect + SQLite(bun:sqlite)。実行環境の状態は `~/.famulus/` にあり、この repo には状態を置かない。

## 検証と commit

- commit の前に `bun run gate`(lint + テスト + カバレッジ)。ゲートが通ったら commit を切る — 可否は訊かない。push は頼まれたときだけ。
- テストを個別に走らせるときは `bun run test <file>`。素の `vitest` は Node で動いて `bun:sqlite` が無く落ちる。
- 実運用の確認: `bun run fam status` / `fam journal`。unit は famulus-{cycle,poll,presence}(systemd --user)。

## DB の規律

- `events` は append-only。トリガが UPDATE/DELETE を拒否する。データを捨てる schema 変更をしない。
- 新しいテーブルは読み手・書き手・テストの3点が揃うまで足さない。
- DB 本体は `~/.famulus/data/famulus.db`。検査は `:memory:` を使う。

## コメントと文書

- コメントは日本語。書くのは制約・不変条件・実測値・非自明な選択の理由だけ。
- 動作をなぞる注釈と、概念メタファー(砦・器・天井・目を覚ますの類)を書かない。
  Claude 系モデルの既定文体で混入しやすいことを実測済み。定着した死喩(枯渇・空振り)は用語として可。
- 変更履歴の語り(「前は〜だった」)をコメントに残さない — それは git が持つ。

## その他

- `SOUL.md` は famulus の人格の正本。日付を置かない(テストが拒否する)。
- 秘密(トークン・auth)は `.env`(600 権限)と `~/.famulus/data/` にある。値を出力しない。コミットしない。
