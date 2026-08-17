-- 意味検索の索引。events の search_text を ruri-v3-30m(256次元)で埋め込む。
-- events 本体は触らない(append-only)。行の対応は events.rowid。
-- 原文を redact したら、この2表の行も同じ tx で消す — 埋め込みは原文から作られる。
CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[256] distance_metric=cosine);

-- 埋め込みの由来。モデルや次元を替えたとき、再埋め込みの対象をここで判別する。
CREATE TABLE events_embedding (
  rowid       INTEGER PRIMARY KEY,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL CHECK (dim > 0),
  content_sha TEXT NOT NULL CHECK (length(content_sha) = 64),
  embedded_at TEXT NOT NULL
) STRICT;
