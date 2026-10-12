# 参与开发

架构决策见 [`docs/adr/`](docs/adr/README.md)，术语见 [`CONTEXT.md`](CONTEXT.md)，计划和待办见 [`docs/roadmap.md`](docs/roadmap.md)；给 agent 的约定在 [`AGENTS.md`](AGENTS.md)。

## 从源码运行

检出仓库，需要 Bun（装依赖、跑脚本）+ Node 25+：

```sh
bun install

bun run host -- --faux "hi"

# 另一个终端起 Web 客户端开发服务器（http://127.0.0.1:5199）：
bun run web
bun run link
```

## 验证

```sh
bun run typecheck
bun run test    # vitest + Playwright，首次跑前先 bunx playwright install chromium
bun run build
```

## 发布（ADR-0016）

推 `v*` tag 触发 `.github/workflows/release.yml`，三个 job：`verify` 跑 typecheck / test / build、打包、`npm pack`、装包冒烟；`macos`（macos-26）签名 + 公证出 arm64 的 dmg/zip，挂镜像验证签名和公证票据，再跑一遍 `desktop:e2e`；`publish` 先把两者做成 **draft** GitHub Release（`PiNomad <version>`，自动生成 release notes，预发布 tag 打 `--prerelease`），上传 dmg / zip / blockmap / `latest-mac.yml` / `SHA256SUMS.txt`，然后 `npm publish`，全成了才解除 draft。`latest-mac.yml` 就是桌面端自动更新的更新源。带 `-` 的预发布 tag（`v0.2.0-beta.1`）发到 `next` 且不是 latest release，正式版发到 `latest`。发布用 npm trusted publishing（OIDC），仓库里没有 npm token。

macOS 签名和公证需要这些仓库 secrets：`MAC_CSC_LINK`（开发者证书的 base64 .p12）、`MAC_CSC_KEY_PASSWORD`（p12 密码）、`APPLE_API_KEY`（App Store Connect 的 .p8 内容）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`。`workflow_dispatch` 手动触发也跑完整签名公证（版本号 `0.0.0-dryrun`），只是不会走 `publish` job，方便干跑验证发布链。

```sh
git tag v0.1.1
git push origin v0.1.1
```

- 手动发布（流水线不可用时）：`bun run build && bun run package -- --version <v>`，再在 `apps/cli/out` 里 `npm publish`。终端里的 npm 要先 `npm login`（`npm whoami` 能报出用户名）；没登录时 npm 回的是 `404 Not Found` 而不是 401，容易误判成包名问题。
- 发布后几分钟内 registry 可能还没处理完（新包还会先出现一个 `0.0.0-stage` 占位版本）；这期间查过的机器缓存了旧元数据，安装报 `ETARGET` / "No matching version" 时加 `--prefer-online`。
