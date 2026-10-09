# ADR-0016：分发——单个 npm 包 `pinomad`，GitHub Actions 按 tag 发布

- 状态：Accepted
- 日期：2026-10-10

## 背景

ADR-0009 §2 定过"安装就是源码检出"，把打包发布留到以后：Node 不对 `node_modules` 里的文件做类型剥离，宿主必须先构建成 JS。中继做完以后这个限制更具体了：VPS 上的中继也要检出整个仓库、装 Bun、`bun run build`，运维成本不小。现在把宿主、中继、构建好的 Web 客户端打成**一个**公开的 npm 包 `pinomad`，`npm i -g pinomad` 就是全部安装。

## 决策

1. **一个包，不是三个。** 包名 `pinomad`，`bin` 只有 `pinomad` 一个入口；子命令 `host` / `relay` / `service` / `upgrade` / `link` / `pair` / `relay-id` 都走它。宿主、中继、Web 客户端的版本天然一致——VPS 上的中继和宿主装同一个包，就不存在各自检出时的版本漂移（ADR-0015 §4 的版本偏斜问题只剩跨大版本升级窗口）。

2. **用 Bun.build 把我们自己的代码打成 bundle，第三方依赖保持 external。** Node 的类型剥离不覆盖 `node_modules`，所以发出去的必须是 JS；`apps/cli/build.ts` 产出 `dist/pinomad.js` + 若干扁平 chunk（ESM splitting，`naming` 固定文件名模式）。第三方依赖不进 bundle，由 npm 按 `package.json` 里的精确版本装。合并三个包的 `dependencies` 时版本冲突直接报错。

3. **`PINOMAD_VERSION` 是唯一的"源码 vs 打包"开关。** `Bun.build` 的 `define` 注入版本号；源码检出里它未定义，`typeof` 判别。所有差异集中在 `apps/host/src/distribution.ts`：Web 根（包内 `web/` vs 检出 `apps/web/dist`）、服务入口（`dist/pinomad.js host` vs `src/main.ts`）、命令拼写（`pinomad pair` vs `bun run pair`）。每个 CLI 模块导出 `main(argv)`，入口文件底部 `if (import.meta.main)` 触发；打进 bundle 的 chunk 里 `import.meta.main` 为假，源码直跑时为真。

4. **打包安装的升级 = `npm i -g pinomad@latest` + 等空闲重启。** `pinomad upgrade` 在打包模式跳过 git/bun 步骤（检出可能根本不干净或不存在），复用 ADR-0009 §5 的 restart 路径。源码检出照旧 `git pull && bun install && bun run build`。

5. **打 tag 走 GitHub Actions 发布（`.github/workflows/release.yml`）。** 全套门禁（typecheck、test、build）+ `bun run package` + `npm pack` + `smoke.ts`（真安装 tgz、跑 `--version`/`relay-id`/host/relay 冒烟）之后才 `npm publish`。发布用 trusted publishing（OIDC，`id-token: write`），仓库里不放长期 token。两个前提：仓库先公开（private 仓库的 Action 也能跑，但 npm 包必须是公开范围语义下的包）；首个版本要手动 `npm publish` 一次，trusted publisher 只能在已存在的包上配置，且配置项要选允许 `npm publish`（不是只允许 `npm stage publish`）。

6. **`bun run start` 不进包。** 它依赖 vite 开发服务器，是开发路径；npm 包里宿主自己提供 Web 客户端（ADR-0009 §7），不需要它。源码检出继续是唯一的开发方式，`bun run host|relay|service|upgrade|link|pair|relay-id|start` 不变。

## 考虑过的方案

- **一个源码包直接跑 `.ts`**：装完即用、不用构建，但 Node 拒绝剥离 `node_modules` 里的 TS，死路。
- **三个包（host/relay/web）分开**：宿主和中继版本要互相对齐，发布矩阵翻倍；VPS 装 `pinomad` 就同时拿到中继和对应版本的 Web 客户端，一个包更省。
- **把所有依赖也打进 bundle**：bundle 巨大、许可证和原生模块（如将来可能有的）麻烦；external + npm 安装是常规做法，版本精确锁死在 `dependencies` 里。
- **长期 npm token（NODE_AUTH_TOKEN）**：能跑但泄露面大；OIDC trusted publishing 没有可偷的凭证。

## 后果

- 这条取代 ADR-0009 §2（不再只是源码检出安装）并修订 §6（打包安装升级走 npm）；§9 的日志约束不变。
- `pinomad service install` 在打包模式下写进服务定义的是 `<npm prefix>/node_modules/pinomad/dist/pinomad.js` + `host` 参数；升级后新装/重装服务会指向新包路径。
- 依赖该包的机器只需要 Node 25+，不需要 Bun、不需要仓库；Omarchy 那台宿主上 `npm i -g pinomad` 装的运行实例和任何开发检出互不相干。
- 发布前置条件：仓库公开、首个版本手动发布、trusted publisher 配置允许 `npm publish`。
- 源码路径仍是开发主场：`bun run test` 不跑 smoke（smoke 要真连 npm registry，只在 release 流水线里跑）。
