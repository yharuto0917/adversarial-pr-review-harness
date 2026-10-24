# ベースイメージのタグは @cloudflare/sandbox の SDK バージョンと一致させること。
# ずれると container 側プロトコルが噛み合わない。
FROM docker.io/cloudflare/sandbox:0.12.9

# レビュー対象リポジトリの取得とパッケージ操作に使う。
# ベースイメージには node / git / npm は含まれているが corepack は PATH に無いため npm で入れ、
# 既定の pnpm / yarn を事前アクティベートした上で packageManager 指定バージョンの自動取得も有効化する。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@0.36.0 pnpm@11.25.0 yarn@1.22.22 && corepack prepare pnpm@11.25.0 yarn@1.22.22 --activate

# ベースイメージが control server 用に使うポート
EXPOSE 3000
