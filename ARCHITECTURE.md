# 架构

## 一句话

**扫描 → 注册表 → 两个前端（CLI / DSH 面板）→ 同一个 Runner。**

## 数据流

```
            devctl.config.json（人写，工作区根）
                      │
                      ▼
   ┌──────────────────────────────────┐
   │ scan()  walk + parse + overrides │   每次调用都实时重算，无缓存
   └──────────────┬───────────────────┘
                  │  [{ id, kind, tasks, node, basePort, warnings }]
        ┌─────────┴──────────┐
        ▼                    ▼
   bin/devctl.js        dsh-plugin/index.js
   （人 / agent）        （Web 面板，HTTP 转发到 CLI）
        └─────────┬──────────┘
                  ▼
            runner.js  Runner
   工具链解析 / spawn / 解码 / 日志 / 端口 / pid
                  ▼
        .devctl/runs/*.json   .devctl/logs/*.log
```

## 关键决策

### 1. 扫描不缓存

全量扫描几十个项目实测 < 200ms（只读 `pom.xml` / `package.json`）。
所以每次 `list` / `run` / `build` 前都重新扫描：无状态、永不错过新增目录，
新增仓库零操作。**刻意不做**文件监听与增量索引——那才是复杂度的来源。

### 2. 目录即身份

项目 ID = 相对路径。不用 `package.json` 的 `name`：同一个工作区里多个仓
共用同一份模板、`name` 完全相同是常见现象（复制粘贴的脚手架），拿它当身份会撞车。

### 3. 工具链走绝对路径，不走 PATH

- Node：直接拼 `<nvmRoot>\vX.Y.Z\node.exe`，把版本目录前置到子进程 PATH。
  **不调 `nvm use`**——它是全局切软链，并发项目会互相覆盖。
- Java：用 `JAVA_HOME\bin\java.exe`，因为 PATH 上的 `java` 可能是个 JRE。

### 4. Runner 是库，不是守护进程

CLI 与 MCP/HTTP 前端内嵌同一个 Runner，运行态通过文件 + `process.kill(pid, 0)`
存活探测共享。代价是不能跨进程实时流日志，只能 tail 文件——这点复杂度不值得换。

长驻任务额外起一个 detached 的 `daemon.js`：CLI 写完 spec 立即退出，
daemon 守着子进程、解码输出、落日志、更新状态。

### 5. 编码按任务类型选

Maven → GBK，Node 工具 → UTF-8。用流式 `TextDecoder` 避免多字节字符被 chunk 边界切断。
落盘统一 UTF-8。

### 6. 交互状态与手写配置分离

面板上的「剔除 / 选入」写 `.devctl/prefs.json`，**不改写** `devctl.config.json`。
两级剔除：`config.exclude`（基线）与 `prefs.excluded`（交互），`prefs.included` 可覆盖两者。
基础设施类排除（裸名 / 通配，如 `node_modules`）不提供选入入口。

### 7. 执行前预演

`bin/plan.js` 复用与真实执行相同的 `buildExecSpec()` 算出命令、cwd、Node、JAVA_HOME、
端口，但**不 spawn**。面板的二次确认卡片就是渲染这份结果，
保证用户看到的就是真正会执行的那条命令，而不是二次拼出来的近似值。

## 模块职责

| 文件 | 职责 |
|---|---|
| `src/config.js` | 配置加载、工作区根定位、prefs 读写 |
| `src/util.js` | 排除规则匹配、CJK 宽度对齐、版本比较 |
| `src/detectors/` | 生态探测器与注册表（maven / node / marker / custom） |
| `src/scan.js` | 目录遍历、override 合并、端口冲突检测 |
| `src/toolchain.js` | nvm 版本发现、Java/Maven 定位、子进程 env 组装 |
| `src/runner.js` | 命令规格、spawn、解码、日志、运行记录、停止 |
| `src/daemon.js` | 长驻任务守护进程 |
| `src/ports.js` | 端口占用探测（connect 优先） |
| `src/ui.js` | 表格与颜色 |

## 扩展点

插件边界靠**探测器注册制**扩展，核心零改动：

```js
// src/detectors/go.js
export const id = 'go'
export const probe = (dir) => existsSync(join(dir, 'go.mod'))
export function detect(dir) {
  if (!probe(dir)) return null
  const mod = readFileSync(join(dir, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)
  const name = mod ? mod[1].split('/').pop() : 'app'
  return {
    kind: 'go', type: 'go', runnable: true, warnings: [],
    tasks: {
      run:   { name: 'run', kind: 'run', type: 'shell', command: `go run ./cmd/${name}`, encoding: 'utf8', label: '启动' },
      build: { name: 'build', kind: 'build', type: 'shell', command: `go build -o bin/${name} ./cmd/${name}`, encoding: 'utf8', label: '构建' },
    },
  }
}
```

再在 `src/detectors/index.js` 底部 `register(go)` 一行即可——`scan` / `runner` / CLI / 面板都不用动。

其它扩展方向：

- **新构建系统**：加探测器（如上）。
- **新前端**：实现「读取项目列表 + 调用 CLI」两层，不要复制 Runner 逻辑。
- **新任务类型**：在 `buildExecSpec()` 加分支，预演与实际执行自动保持一致。
- **新动作（test/lint/deploy）**：任务已有通用 `kind` 字段，探测器产出即可；
  面板按 `kind` 分组渲染，不需要为新动作改代码。
  需要再细分的（例如把「发布到私服」从普通打包里拆出来）用可选的 `section` 字段，
  它只影响展示分组，不影响执行语义（`kind=run` 后台常驻，其余阻塞收集输出）。
