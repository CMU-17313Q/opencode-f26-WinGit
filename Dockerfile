FROM oven/bun:1.3.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile

EXPOSE 4096

CMD ["bun", "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "web", "--hostname", "0.0.0.0", "--port", "4096"]
