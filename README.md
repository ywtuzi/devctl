# devctl

**一个工作区里几十个仓，一条命令管住它们的运行与打包。**

多仓工作区项目运行器：扫描识别工作区里的前后端项目，统一 `run` / `build` / `debug`，
给人和 AI agent 提供同一份项目注册表。

```
不加 devctl：每个仓记一套命令                    加了 devctl：一份注册表
┌──────────────┐  cd web-a && npm run dev           ┌────────────────────────┐
│ web-a        │  cd web-b && npm run dev -- --port │  devctl list           │
│ web-b        │  cd api   && mvn -pl svc -am ...   │  devctl run  web-a     │
│ api (多模块) │  cd mp    && npm run dev:mp-weixin │  devctl build api      │
│ mp           │  + 各自的 Node 版本 / JAVA_HOME     │  devctl run  api debug │
└──────────────┘                                   └────────────────────────┘
```

## 它解决什么

一个工作区里几十个彼此独立的仓库：Maven 多模块、Vue CLI、Vite、uni-app、VuePress……
每个的启动命令、Node 版本、端口、构建方式都不一样。

- 人记不住，每次都要翻 `package.json` / `pom.xml`
- AI agent 更猜不准：它不知道哪个模块可运行、该用哪个 Node、端口会不会撞

devctl 把这些差异收敛成一次扫描的结果：**不需要配置就能跑起来**，需要覆盖时再写配置。

## 特性

- **零配置起步**：识别 `pom.xml` / `package.json`，自动推导可运行模块与任务
- **工具链按项目绑定**：直接拼 nvm 里对应版本的 `node.exe` 绝对路径，不调 `nvm use`；Maven 项目覆写 `JAVA_HOME`
- **长驻任务 daemon 化**：`run` 立即返回 `runId` + `pid` + `url`，进程不随终端关闭而死
- **编码自适应**：Maven 的 GBK 与 Node 工具的 UTF-8 分开解码，日志统一落 UTF-8
- **端口冲突自动偏移**：多个前端同默认端口时可以并存
- **剔除 / 选入**：交互状态单独存放，不改你手写的配置
- **后端 debug**：给 `spring-boot:run` 注入 JDWP，IDE 直接 attach
- **全链路 `--json`**：agent 不需要解析人类输出

## 依赖

- Node **≥ 18**（用 nvm 管理更省事；本工具自身零第三方依赖，不需要 `npm install`）
- Maven 项目需要可用的 `mvn`，Node 项目需要已安装依赖

## 快速开始

```bash
# 1) 把模板复制到「工作区根目录」并改名
cp devctl.config.example.json /path/to/workspace/devctl.config.json

# 2) 看看识别到了什么
node /path/to/devctl/bin/devctl.js list

# 3) 跑起来
node /path/to/devctl/bin/devctl.js run my-web-app
node /path/to/devctl/bin/devctl.js build my-api-service
```

在任意子目录执行都可以——它从当前目录向上查找 `devctl.config.json` 来定位工作区根。

也可以 `npm link` 后用 `devctl` 直接调用。

## 命令

| 命令 | 说明 |
|---|---|
| `devctl list [--json] [--type maven\|node]` | 列出项目与可用任务 |
| `devctl scan` | 重新扫描并写 `.devctl/manifest.json` |
| `devctl run <项目> [任务] [--port N] [--node X]` | 启动（长驻，立即返回） |
| `devctl build <项目> [任务] [--timeout ms]` | 构建（阻塞，返回退出码） |
| `devctl stop <runId\|项目>` | 停止 |
| `devctl status [--json]` | 运行中的实例与最近任务 |
| `devctl logs <runId> [--lines N] [-f]` | 查看日志 |
| `devctl ports [端口...]` | 端口占用检查 |
| `devctl exclude\|include <项目>` | 从列表剔除 / 选回 |
| `devctl doctor` | 工具链自检 |

全局选项：`--root <dir>`、`--json`、`--node`、`--port`、`--timeout`、`--lines`
退出码：`0` 成功 / `1` 业务失败 / `2` 参数错误

### 例子

```bash
devctl run web-a                          # 起前端，端口冲突自动偏移
devctl run mp dev:mp-weixin               # uni-app 指定平台
devctl run api debug                      # 后端以调试模式启动（JDWP）
devctl build api --timeout 600000         # 打包后端
devctl logs web-a_dev_20260101090000 -f   # 跟日志
```

## 配置

工作区根放 `devctl.config.json`（模板见 `devctl.config.example.json`）。

**只写差异。** 能自动推出来的（构建系统、可运行模块、脚本名、端口）绝不重复写，
否则仓库一变配置就腐烂。空字符串等同于不写，表示自动推断。

```jsonc
{
  "toolchain": {
    "javaHome": "",          // 留空 → 读环境变量 JAVA_HOME
    "mavenHome": "",         // 留空 → 用 PATH 上的 mvn
    "nvmRoot": "",           // 留空 → 用 PATH 上的 node
    "defaultNode": ""        // 老 webpack4 前端绑定的版本，如 "18.20.3"
  },
  "overrides": {
    "my-web-app": { "basePort": 8080, "node": "16.20.2" },
    "my-api-service": { "debugPort": 5005 },
    "some-lib": { "runnable": false }
  }
}
```

新增项目不需要改代码：

| 场景 | 操作 |
|---|---|
| 新 clone 一个仓到根目录 | 无需操作，自动识别 |
| 项目在根目录之外 | `extraRoots` 加一行路径 |
| 纳入之前排除的项目 | `devctl include <项目>`，或删掉 `exclude` 里那行 |

## 自动识别规则

- 目录里有 `pom.xml` 或 `package.json` → 视为项目，**不再向下递归**（避免把 Maven 子模块当成独立仓）
- 没有构建文件的目录 → 继续向下探到 `maxDepth`（默认 2），用来发现嵌套项目
- **Maven**：`spring-boot-maven-plugin` 所在模块 = 可运行模块；
  `<pluginManagement>` 里的声明不算；`packaging=pom` 的聚合根自身不可运行
- **Node**：按 `@vue/cli-service` 主版本判断是否 webpack4，决定绑定哪个 Node；
  `uni` → uni-app（按 `-p <platform>` 生成平台任务）；`vuepress` → 文档站
- 同目录同时有 `pom.xml` 和 `package.json` → `mixed`，任务带 `maven:` / `node:` 前缀
- `*-custom` 这类需要额外参数的脚本不会被选为默认任务

## 六个我们踩过的坑

集成这些老项目时真实踩到的，代码里都有对应处理：

1. **Node 版本按项目绑定，不要调 `nvm use`**
   `nvm use` 是全局切软链，多项目并发会互相覆盖。devctl 直接拼绝对路径。

2. **webpack4 在 Node 17+ 需要 `--openssl-legacy-provider`**
   但 **Node 16 会拒绝把它放进 `NODE_OPTIONS`**（`not allowed in NODE_OPTIONS`），
   所以要绑 Node 18+，并在脚本没带时兜底注入。

3. **PATH 上的 `java` 可能是个 JRE**
   有的机器 `java` 指向 JRE（没有 `javac`），而 `JAVA_HOME` 才是 JDK。
   devctl 一律用 `JAVA_HOME` 的绝对路径。

4. **Maven 输出是 GBK，Node 工具是 UTF-8**
   按 UTF-8 硬解中文会全乱码，错误行也提取不出来。按任务类型选解码器。

5. **Windows 上端口探测不能用 listen**
   `SO_REUSEADDR` 允许重复绑定，`listen` 成功不代表端口空闲。必须先 `connect` 探测。

6. **Windows 文件名不能含冒号**
   `uni-app` 的任务名是 `dev:mp-weixin`，直接拼进 runId 会变成 NTFS 备用数据流，
   目录里看到的文件名被截断，导致 `status` / `stop` 找不到记录。生成时统一替换非法字符。

## 运行态

```
.devctl/
  manifest.json         扫描结果
  runs/<runId>.json     运行记录
  logs/<runId>.log      日志（UTF-8）
  prefs.json            剔除 / 选入偏好
```

`.devctl/` 已在 `.gitignore` 里——它包含绝对路径与本机信息。

## 目录

```
bin/devctl.js        CLI 入口
bin/plan.js          预演：只解析命令不执行（面板二次确认用）
bin/attach.js        前台运行：保留彩色输出与 Ctrl+C
src/config.js        配置加载、根定位、剔除/选入偏好
src/scan.js          目录扫描、override 合并、端口冲突
src/parse.js         Maven / Node 项目解析
src/toolchain.js     Node(nvm) / Java / Maven 解析
src/runner.js        命令解析、spawn、解码、日志、运行态
src/daemon.js        长驻任务守护进程
src/ports.js         端口探测
src/ui.js            表格与颜色
dsh-plugin/          DeepSeek Harness 悬浮面板插件
```

## DeepSeek Harness 面板

`dsh-plugin/` 是一个 DSH bundle：右下角悬浮按钮 → 项目面板，展示运行中 / 打包中状态，
运行与打包都要二次确认并显示将要执行的完整命令。

安装方式与配置说明见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

## 测试

```bash
npm test
```

覆盖排除规则匹配、Maven/Node 解析、runId 合法性、端口探测。全部在临时目录里跑，
不依赖外部服务。

## 许可

MIT，见 [LICENSE](LICENSE)。
