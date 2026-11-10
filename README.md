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
  "defaults": {
    // Maven 生命周期任务：每条都是完整的 goal 列表，可整体改写成自己的流水线
    "mavenBuild":   ["clean", "package", "-DskipTests"],
    "mavenInstall": ["clean", "install", "-DskipTests"],
    "mavenTest":    ["test"],
    "mavenClean":   ["clean"],
    "mavenDeps":    ["dependency:tree"],
    "mavenDeploy":  ["clean", "deploy", "-DskipTests"]
  },
  "toolchain": {
    "javaHome": "",          // 留空 → 读环境变量 JAVA_HOME
    "mavenHome": "",         // 留空 → 用 PATH 上的 mvn
    "nvmRoot": "",           // 留空 → 用 PATH 上的 node
    "defaultNode": ""        // 老 webpack4 前端绑定的版本，如 "18.20.3"
  },
  "overrides": {
    "my-web-app": { "basePort": 8080, "node": "16.20.2" },
    "some-lib": { "runnable": false },

    "my-api-service": {
      "debugPort": 5005,
      // 项目特有的发布流程：在自动识别的任务之上追加，不用改代码
      "extraTasks": {
        "package:product": {
          "label": "生产包",
          "kind": "build",
          "command": "mvn clean package -P release-product -pl my-distribution -am -DskipTests"
        }
      }
    }
  }
}
```

新增项目不需要改代码：

| 场景 | 操作 |
|---|---|
| 新 clone 一个仓到根目录 | 无需操作，自动识别 |
| 项目在根目录之外 | `extraRoots` 加一行路径 |
| 纳入之前排除的项目 | `devctl include <项目>`，或删掉 `exclude` 里那行 |

### 后端（Maven）任务

每个 `pom.xml` 项目自带一整组生命周期操作，不需要逐个配：

| 任务 | 命令 | 说明 |
|---|---|---|
| `run` / `debug` | `spring-boot:run` | 调试额外注入 JDWP（默认 5005） |
| `build` | `clean package -DskipTests` | 只出模块 jar，不跑 assembly |
| `install` | `clean install -DskipTests` | 装进本地仓，供其它仓依赖 |
| `test` | `test` | 增量编译并跑单测 |
| `clean` | `clean` | 删 `target/` |
| `deps` | `dependency:tree` | 依赖树 |
| `deploy` | `clean deploy -DskipTests` | **发布到私服，不可撤销** |

`deploy` 的地址来自 pom 的 `<distributionManagement>`：版本带 `-SNAPSHOT` 走
`<snapshotRepository>`，否则走 `<repository>`。面板会先算出这条命令、把目标私服地址
写在确认框里，并单独归到「发布」分组；pom 没配 `distributionManagement` 时直接提示
「deploy 会失败」，而不是让你点完才看到报错。

**多模块仓默认作用于整个 reactor。** 比如 `hs-cloud-auth` 是 9 个模块 + 根 pom，
`mvn deploy` 会发 10 个构件。只想发 `cloud-auth-api` 一个：

- 面板：确认框里把「模块」从 `全部模块` 切到 `cloud-auth-api`
- CLI：`devctl build hs-cloud-auth deploy --module cloud-auth-api`

命令会变成 `mvn clean deploy -DskipTests -pl cloud-auth-api`。

注意**不要**自己补 `-am`：它会把该模块的上游一起拉进 reactor，于是 deploy/install
连带作用在它们身上——和「只发一个」正好相反。devctl 指定模块时会主动摘掉 `-am`。

## 识别架构：探测器注册制

核心扫描器**不认识任何具体生态**。它只做一件事：遍历目录 → 问每个探测器「你认领这里吗」→ 汇总成项目。

内置探测器：

| 探测器 | 认领条件 | 产出 |
|---|---|---|
| `maven` | `pom.xml` | run / debug / build / install / test / clean / deps / deploy |
| `node` | `package.json` | 按 scripts 推导 run / build |
| `marker`（兜底·弱） | `go.mod` / `Cargo.toml` / `pyproject.toml` / `build.gradle` / compose / `*.csproj` | 只列出项目，**不猜命令** |
| `custom` | `devctl.config.json` 的 `custom` 声明 | 任意 shell 命令 |

探测器契约（`src/detectors/*.js`）：

```js
export const id = 'maven'            // 唯一标识
export const weak = false            // 可选：弱探测器不独占目录
export const fallback = false        // 可选：只在没有其它探测器命中时运行
export function probe(dir, ctx) {}   // 便宜的「这目录像不像我的项目」
export function detect(dir, ctx) {}  // 返回 facet 或 null
export function extraProjects(ctx)   // 可选：贡献目录扫描之外的项目
```

**新增一种生态 = 在 `src/detectors/` 加一个文件 + 底部 `register()` 一行。**
`scan` / `runner` / CLI / 面板都不用改。

目录递归规则：

- **强探测器**命中 → 该目录独占，不再向下（Maven 子模块不会被当成独立仓库）
- **弱探测器**命中 → 仍继续向下，找嵌套项目（Python 仓里的 `web/` 前端照样能找到）
- 单个探测器抛错不会中断扫描，错误会挂在该项目上显示

为什么 `marker` 只认不猜：Go / Rust / Python 的启动方式千差万别（`go run ./cmd/x`、`cargo run`、`uvicorn app:main`），猜错比不猜更糟——先让它出现在列表里，命令由 `custom` 或后续专用探测器补。

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
src/detectors/      生态探测器（maven / node / marker / custom）
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
