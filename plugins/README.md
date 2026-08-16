# DSH plugins

这里存放面向 **原生 DeepSeek Harness 用户** 的可复用插件。设计、测试和发布时默认使用者运行的是普通 DSH `web` profile，而不是 Tauri Desktop。

真正依赖窗口、Tauri IPC 或桌面生命周期的集成才放在 `desktop-plugins/`。可复用业务能力即使会被 Desktop 预装，也必须放在 `plugins/` 并保持可独立安装。

## 标准目录

```text
plugins/<package-name>/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ LICENSE
├─ scripts/build.mjs
├─ src/index.mjs
├─ src/client.tsx       # 有浏览器半时使用
└─ test/
```

`lib/` 是构建产物，由 Git 忽略并在打包前重新生成。

## 清单要求

每个插件必须：

1. 使用可发布的 npm 包名，不设置 `private: true`；
2. 以 `./lib/index.mjs` 作为 Host 入口；
3. 在 `dsh.bundle.patch` 中声明 `./cordis.patch.yml`；
4. 带浏览器 UI 时同时声明 `dsh.client.platform: web`，并导出 `./client`；
5. 通过 `files` 明确包含 `lib/`、配置层、README 与 License；
6. 提供独立的 `build`、`prepare` 和 `test` 脚本；
7. 官方 `@deepseek-ai/*` 兼容包只放在 `peerDependencies`，不放进 `dependencies`；
8. README 同时记录 npm 安装、本地路径安装、卸载和兼容接口；
9. 不引用 Tauri API、Desktop 目录或仅在桌面外壳存在的运行时状态。

最小 manifest 片段：

```json
{
  "name": "dsh-example",
  "type": "module",
  "main": "./lib/index.mjs",
  "files": ["lib/", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  }
}
```

## 验证

仓库级构建器会自动发现 `plugins/*`，先检查标准清单，再调用各包自己的构建脚本：

```sh
pnpm run plugin:test
```

准备发布单个包时还应执行：

```sh
cd plugins/<package-name>
npm pack --dry-run
```

最后使用一个隔离的 `$DSH_HOME`，通过下面的路径安装方式启动原生 profile，确认 Host、浏览器 bundle 与页面功能均正常：

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh --profile web
```

## 插件商店投稿

`awesome-dsh-plugin` 当前从 `data/plugins/*.yml` 生成中英文 README。Monorepo 子包应把 `url` 指向插件子目录，并使用 `owner/repo#subname` 作为展示名；不要再手工维护 catalog README 行。可复用插件在投稿前还应：

1. 在 GitHub 仓库添加 `dsh-plugin` topic；
2. 准备事实性中英文描述，不写营销性最高级；
3. 确认仓库创建已满一天且至少有十次提交；
4. 优先发布带预构建 `lib/` 的 npm 包；
5. 如需商店截图，将 1–8 张图片保存在本仓库并使用 GitHub 托管的 HTTPS URL。

`dsh-attachments` 的可复制 YAML、截图 URL 模板和提交清单见 [`dsh-attachments/MARKETPLACE.md`](dsh-attachments/MARKETPLACE.md)。
