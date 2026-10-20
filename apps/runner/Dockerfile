# ベースイメージのタグは @cloudflare/sandbox の SDK バージョンと一致させること。
# ずれると container 側プロトコルが噛み合わない。
FROM docker.io/cloudflare/sandbox:0.12.9

# レビュー対象リポジトリの取得とパッケージ操作に使う。
# ベースイメージには node / git / npm は含まれているが corepack は PATH に無いため npm で入れる。
RUN npm install -g pnpm@11.25.0

# ベースイメージが control server 用に使うポート
EXPOSE 3000
