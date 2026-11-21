# ベースイメージのタグは @cloudflare/sandbox の SDK バージョンと一致させること。
# ずれると container 側プロトコルが噛み合わない。
FROM docker.io/cloudflare/sandbox:0.12.14

# レビュー対象リポジトリの取得とマルチ言語（Node.js / Python / Go / Rust）の依存解決・テスト実行に使う。
# - install フェーズは GET/HEAD のみ許可するため、npm の自動 POST audit/fund リクエストを無効化する。
# - Python は uv に一本化し、許可外ホストからの Python 本体自動取得を無効化する。
# - Go はプリインストール済みツールチェーンのみを使い、GOPROXY を公式プロキシへ固定する。
# - Rust は HTTP GET ベースの sparse index を使う。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    UV_PYTHON_DOWNLOADS=never \
    GOTOOLCHAIN=local \
    GOPROXY=https://proxy.golang.org \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    GOPATH=/usr/local/gopath \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/gopath/bin:${PATH}"

# Node.js パッケージマネージャ（corepack 経由で packageManager 指定バージョンにも対応）
RUN npm install -g corepack@0.36.0 pnpm@11.25.0 yarn@1.22.22 && corepack prepare pnpm@11.25.0 yarn@1.22.22 --activate

# Python 実行環境・Rust リンカ（cc）・C 拡張ビルド用の最小システムパッケージ
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gcc \
      libc6-dev \
      pkg-config \
      python3 && \
    rm -rf /var/lib/apt/lists/*

# Python パッケージマネージャ（uv）
COPY --from=ghcr.io/astral-sh/uv:0.6.14 /uv /uvx /usr/local/bin/

# Go ツールチェーン
COPY --from=docker.io/library/golang:1.24.2 /usr/local/go /usr/local/go

# Rust ツールチェーン（minimal プロファイル + clippy のみでイメージ肥大化を抑える）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- -y --profile minimal --default-toolchain 1.86.0 --component clippy --no-modify-path && \
    chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}"

# ベースイメージが control server 用に使うポート
EXPOSE 3000
