# dsh-attachments

[English](README.md) | 中文

`dsh-attachments` 为 DeepSeek Harness Web UI 增加文件与文件夹附件能力。图片继续使用 Harness 原生图片链路，插件负责普通文件与完整目录树。

## 功能

- 从操作系统拖入普通文件、图片或文件夹；
- PNG/JPEG/WebP/GIF 继续使用 Harness 原生预览、历史画廊与模型能力检查；
- 一个拖入的文件夹只对应一张附件卡片，同时保留完整目录树；
- 在模型步骤前，将已提交的文件与文件夹复制到当前工作区的 `.deepseek-harness/attachments/`；
- 在输入区和持久化消息历史中展示附件卡片；
- 以流式方式上传和下载，插件自身不设置文件数量或单文件大小上限；
- 没有插件附件时，保持原有输入栏布局。

## 截图

### 拖放界面

插件在窗口外围增加虚线拖放边界，同时保留 Harness 原生图片接收界面。

![拖放附件界面](assets/screenshots/01-drag-drop-overlay.png)

### 图片消息历史

原生图片消息继续显示在持久化会话历史中，并可交给支持多模态的模型处理。

![图片消息与模型回复](assets/screenshots/02-image-conversation.png)

### 多图片预览

多张原生图片预览与插件提供的文件、文件夹卡片共用输入栏附件区域。

![同一条消息中的多图片预览](assets/screenshots/03-multiple-image-preview.png)

## 安装

当前版本可直接从 GitHub 的 monorepo 子包安装到原生 DSH 的 `web` profile：

```sh
dsh plugin --profile web add github:WJZ-P/deepseek-harness-desktop#path:/plugins/dsh-attachments
```

这里显式指定 GitHub 来源：npm 上未带 scope 的 `dsh-attachments` 已属于另一个项目。
在本插件拥有独立的 registry 包之前，插件市场同样会使用这个 GitHub 子包地址。

从本仓库根目录构建并安装本地版本：

```sh
pnpm install
pnpm run plugin:build
dsh plugin --profile web add ./plugins/dsh-attachments
```

也可以在插件目录内执行：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

检查最终配置并启动：

```sh
dsh --profile web --dump-config
dsh --profile web
```

卸载：

```sh
dsh plugin --profile web remove dsh-attachments
```

## DSH 包约定

本包遵循可安装的 DSH bundle 格式：

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，由它插入 Host 插件行；
- `dsh.client.platform` 设置为 `web`，并通过 `exports["./client"]` 暴露预构建的浏览器 bundle；
- 官方 `@deepseek-ai/*` 兼容包均声明为 peer dependencies；
- npm 压缩包携带预构建的 `lib/` 产物，因此从 registry 安装时无需构建浏览器 bundle。

Host 端负责字节传输、持久化元数据与工作区落盘；浏览器端通过 Harness 扩展 slot 提供输入区和历史消息 UI。整个插件与 Tauri 运行时解耦。

## 兼容性

当前版本面向 DeepSeek Harness `0.1.0-rc.5` 的标准 bundle 加载、Web Client 发现、输入区与历史消息 slot、会话事件及 Host 路由注册接口。

## 开发

```sh
pnpm install
pnpm run build
pnpm test
npm pack --dry-run
```

可直接复制的商店 catalog YAML 与截图 URL 模板维护在 [MARKETPLACE.md](https://github.com/WJZ-P/deepseek-harness-desktop/blob/main/plugins/dsh-attachments/MARKETPLACE.md)，截图文件放在 [`assets/screenshots/`](https://github.com/WJZ-P/deepseek-harness-desktop/tree/main/plugins/dsh-attachments/assets/screenshots)。

## License

[MIT](LICENSE)
