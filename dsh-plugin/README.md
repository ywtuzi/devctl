# dsh-devctl-panel

DeepSeek Harness（DSH）的悬浮面板插件，是 [devctl](../README.md) 的 Web 前端。

右下角一个悬浮按钮，展开后是工作区项目清单：

- **状态为主**：`运行中` / `打包中` 两块置顶常驻，带运行时长与独立停止按钮
- **执行前二次确认**：点运行 / 打包先展示将要执行的完整命令（命令、实际进程、cwd、运行时、端口），确认后才执行
- **多任务选择**：任务多的项目（如 uni-app 的平台矩阵）用 `▾` 展开，按平台挑具体任务
- **剔除 / 选入**：收掉不想看的项目，状态单独存放，不改手写配置

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单 + `dsh.client` 段 |
| `cordis.patch.yml` | 插入 `devctl-panel` 这一行 |
| `index.js` | Host 半：注册 `/devctl-api/*`，全部转发给 devctl CLI |
| `client.js` | Client 半：注册到 `shell.overlay` 槽位，渲染面板 |
| `locale/*.json` | 插件管理器里显示的标题与描述 |
| `icon.svg` | 插件图标 |

它不含任何项目识别逻辑——扫描、命令解析、工具链绑定全在 CLI 里，
插件只是一层调用与展示。这样保证「面板里看到的命令」和「终端里敲的命令」完全一致。

## Host API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/devctl-api/projects` | 项目列表（`devctl list --json`） |
| GET | `/devctl-api/status` | 运行中 / 打包中实例 |
| GET | `/devctl-api/config` | 解析出的 root 与 cli 路径 |
| POST | `/devctl-api/preview` | 预演：返回将执行的命令，**不执行** |
| POST | `/devctl-api/run` | `{id, task?}` 启动 |
| POST | `/devctl-api/build` | `{id, task?}` 打包（后台进程，带去重锁） |
| POST | `/devctl-api/stop` | `{projectId}` 或 `{runId}` 停止 |
| POST | `/devctl-api/exclude` / `include` | `{id}` 剔除 / 选入 |

两个实现细节：

- **用 handler 路由而不是 resource 路由**：`dsh-host-webserver` 的 `serveResource()`
  只放行 GET/HEAD，其他方法一律 405。handler 拿到原始 `IncomingMessage/ServerResponse` 才能处理 POST。
- **打包去重是双层**：进程内锁挡住「连点两次」的竞态（spawn 到记录写盘有约 1 秒空窗，
  只查 status 挡不住），status 检查挡住已存在的实例。

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle  target = <本仓库路径>/dsh-plugin
```

依赖 devctl CLI。查找顺序：配置项 `cliPath` → `<root>/devctl/bin/devctl.js` →
`<root>/bin/devctl.js` → 与本插件同级的 `../bin/devctl.js`。

## 配置

默认不写配置也能工作：工作区根取 DSH 的当前工作目录，CLI 按上面的顺序自动查找。

需要固定路径时，在 `cordis.patch.yml` 里补：

```yaml
- insert:
    - id: devctl-panel
      name: 'dsh-devctl-panel'
      config:
        root: '<工作区根绝对路径>'
        cliPath: '<devctl/bin/devctl.js 绝对路径>'
```

## 剔除 / 选入

每行右侧的 `×` 是把项目剔除；被剔除的项目在底部「已剔除」区，点「选入」放回来。

状态写在**工作区根**的 `.devctl/prefs.json`，不会改写手写的 `devctl.config.json`：

```json
{
  "excluded": ["some-app"],
  "included": ["vendor/legacy-app"]
}
```

- `excluded`：面板剔除，优先于配置
- `included`：用来覆盖 `devctl.config.json` 里 `exclude` 的显式路径排除

基础设施类排除（`node_modules`、`target` 这类裸名或通配）不会出现在「已剔除」列表里，
只有显式路径排除才提供选入入口。

## 改代码后如何生效

Host 半的模块被 Node 的 ESM 缓存住，**不会自动热重载**：

1. 在插件管理器里把 `include:devctl-panel` 停用再启用（实测可加载新模块）；或
2. 重启 DSH

Client 半的改动需要**刷新页面**才会重新执行模块。

> 注意：停用再启用会让浏览器里的客户端注册被 dispose，必须配合刷新页面才恢复。

## 已知限制

- 构建任务与运行任务在 `status.running` 里混在一起，客户端按任务 `kind` 区分展示
- 无浏览器控制能力时，视觉呈现未经截图验证；只能验证槽位注册与 HTTP 接口
