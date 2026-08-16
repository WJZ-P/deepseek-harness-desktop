# dsh-model-capabilities

DeepSeek Harness 的模型能力声明插件，让用户在新增或编辑自定义模型时直接选择模型支持的输入类型。

## 功能

- 在原生 Models 设置页的模型条目中增加“输入类型”字段；
- 支持继承默认值、仅文本、仅图片、文本与图片；
- 写入 Harness 已有的模型 `input` 声明，因此图片能力检查与模型实际配置保持一致；
- 通过 `settings.models.model.fields` 扩展点注入字段，不接管模型表单、校验或持久化；
- Host 与浏览器两部分由同一个 Cordis 插件生命周期管理；
- 不依赖 Tauri API，可直接安装到原生 DSH 的 `web` profile。

## 安装

发布到 npm 后，可安装到原生 DSH 的 `web` profile：

```sh
dsh plugin --profile web add dsh-model-capabilities
```

从本仓库 checkout 安装本地版本：

```sh
pnpm install
pnpm run plugin:build
dsh plugin --profile web add ./plugins/dsh-model-capabilities
```

相对路径以执行命令时所在的目录为基准。在插件目录中则先构建当前包，再安装：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

安装后可以先检查最终配置，再启动：

```sh
dsh --profile web --dump-config
dsh --profile web
```

卸载：

```sh
dsh plugin --profile web remove dsh-model-capabilities
```

## 开发

```sh
pnpm install
pnpm run build
pnpm test
```

包内的 `dsh.bundle` manifest 指向 `cordis.patch.yml`，配置层负责挂载 Host 行；`dsh.client` 声明与 `exports["./client"]` 让 Harness 通过官方 Web Client 发现链路加载预构建的浏览器 bundle。官方 `@deepseek-ai/*` 兼容包均以 peer dependencies 声明。

## 兼容性

当前版本针对本仓库所携带的 DeepSeek Harness `0.1.0-rc.5` 接口构建，并依赖外部浏览器 bundle 注册口与 `settings.models.model.fields` 扩展点。使用其他 Harness 版本时，需要具备等价接口。

## License

[MIT](LICENSE)
