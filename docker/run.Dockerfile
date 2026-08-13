# 走行用のイメージ。src/services/Sandbox.ts が使う。
#
# **素の node:24-bookworm に足りないものを、走る前に入れておく。**
# 足りないと、その回は「入れる」で終わる — 実測で、`ossrun` の走行 6回のうち 4回が
# pip / venv / apt を試して落ちるだけで終わっていた(コンテナは非 root なので apt は通らない)。
# 何が入っているかは shell の道具の説明にも書いてある(src/agent/assistant.ts)。両方を一緒に直す。
#
# 入れるものは**実測で呼ばれたものだけ**(30回の走行記録から: pip 6 / uv 4 / jq 1)。
# go と cargo は各1回だが、どちらも「何が入っているか」を調べる走行で呼ばれただけなので入れない
# (2つで 1GB を超え、走行そのものでは使われていない)。
#
# bun も入れない。要るのは自分のソースを直す走行(selfdev)だけで、そこは npx で引く
# (src/core/selfdev.ts)。取得物は共有キャッシュに残るので二度目は 1.4 秒。
FROM node:24-bookworm

# --no-install-recommends を付けないと python3-pip が推奨で 300MB ぶん引き連れてくる。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-pip python3-venv jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

# uv は astral の配布イメージから実体だけ取る(インストーラは $HOME に置くので、
# 走行ごとに HOME が変わるこの使い方では毎回取り直しになる)。
COPY --from=ghcr.io/astral-sh/uv:0.9.9 /uv /uvx /usr/local/bin/

# 共有キャッシュの置き場。ホストの .data/run-cache を束ねる(Sandbox.ts の cacheRoot)。
# ここを作業場(HOME=/work)の下に置くと、作業場ごとに同じものを落とし直す。
ENV UV_CACHE_DIR=/cache/uv \
  PIP_CACHE_DIR=/cache/pip \
  npm_config_cache=/cache/npm \
  XDG_CACHE_HOME=/cache/xdg \
  UV_LINK_MODE=copy
