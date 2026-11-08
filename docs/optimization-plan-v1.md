# omp-view 优化方案（v1）

- 版本：v1（待独立评审）
- 实现状态：未实施
- 目标读者：接手实施的 Agent / 用户
- 代码位置：`D:\desktop\omp-view`（Bun 1.4.4、OMP 18.15.0、Windows）

## 1. 目标与核心任务

**核心任务**：让 omp-view 覆盖「切换模型与角色」的完整闭环——选模型、试连通、批量套用、存成预设、随时切回、出错可回滚——同时保证保存不破坏配置文件、写入可预期好读。

**当前差距**（用户真实使用中暴露）：

1. 换一套模型要逐个 Role 手点，没有批量操作；本次切换 12 个 Role 只能靠临时脚本。
2. 没有预设：无法把「DeepSeek 全套」与「MiMo 全套」各存一份一键切换，只能反复改。
3. 模型元数据只能手填，且已经过时：本地代理实际提供 17 个模型，`models.yml` 里只配了 1 个，且 `maxTokens` 填 65536（代理报 128000）。
4. 保存后格式不可读：Bun 1.4.4 的 `Bun.YAML.stringify(d)` 默认输出单行 flow YAML，现有代码正是这么写的。
5. 没有连通性测试、没有保存预览、备份只能手工复制恢复。
6. 角色可以保存不存在的模型/服务标识，OMP 侧才报错。

## 2. 核心前提与依据

| 编号 | 前提 | 状态 | 依据 / 可证伪条件 |
|---|---|---|---|
| P1 | OMP 18.15.0 接受 `modelPresets.<name> = { modelRoles, defaultThinkingLevel }` 并可从 config.yml 读取 | 已证实 | `omp://settings.md`（modelPresets 行）；临时目录写入后 `omp config get modelPresets` 原样返回。若写入后该命令报 Unknown/解析失败，则不成立 |
| P2 | `Bun.YAML.stringify(obj)` 不带缩进参数时输出单行 flow 风格 | 已证实 | 本机 Bun 1.4.4 实测：`{a: 1,b: {c: x}}`；传 `(obj, null, 2)` 才是块格式。若默认输出含换行，则不成立 |
| P3 | 本地代理 `http://127.0.0.1:7864/v1/models` 带 Bearer 可列出模型及元数据 | 已证实 | 实测 200，字段含 `id/name/context_length/max_output_tokens/modalities.input/only_reasoning`；不带 key 返回 401。若 200 但缺字段，则只能填 id |
| P4 | 现有写入路径为「全量重写两个 YAML 文档 + 原子 rename + 备份目录」 | 已证实 | `config-store.js :: change()` 第 84–96 行；备份落在 `model-manager-backups/<ts>-<uuid>/`。若这些行为已变，依赖它们的步骤需重写 |
| P5 | OMP 能解析 flow 风格与块风格 config.yml | 已证实 | flow 文件实测可被 `omp config get defaultThinkingLevel` 读取。说明格式问题是可维护性，不是功能阻断 |
| P6 | 角色保存目前只做循环/悬空引用检查，不校验模型是否存在 | 已证实 | `config-store.js :: change()` roles 分支；`assertUnused` 只在删除服务时调用 |
| P7 | 前端零构建、无第三方依赖；新增静态文件必须登记到 server 白名单 | 已证实 | `server.js:37` 硬编码 4 个文件；AGENTS.md 明确要求同步白名单 |

## 3. 决策登记表

| 决策 | 选定实现 | 依据 | 什么证据会推翻 | 备选 |
|---|---|---|---|---|
| 决策 1 范围 | v1 只做 P0 正确性 + P1 工作流（批量、预设、模型拉取）；P2（diff 预览、备份恢复、外部修改监听、回退链）列为后续 | 用户当前痛点是「切换模型/角色」；先补齐闭环，再加安全网 | 若实施中发现无 diff 预览导致误写风险不可接受，则提前 P2 的保存预览 | 一次做全（成本高、验收面过大） |
| 决策 2 YAML 写入 | 不引依赖；固定 `stringify(doc, null, 2)` + 末尾换行；继续接受注释丢失 | 保持零依赖是项目现状；Bun 无 CST，定点替换脆弱 | 若用户把 config.yml 当手写文件并依赖注释，则需引入 `yaml` 的 Document API（新增依赖，另立决策） | 引入 `yaml` 包；或只改 modelRoles 的文本块 |
| 决策 3 模型目录 | 代理 `/v1/models` 为元数据来源；合并导入，不自动删除现有模型；用户勾选后才写入 | P3 实测字段完整；手工填已经过时 | 若代理返回的字段与 OMP 语义冲突（如 reasoning），则以人工勾选为准 | 只做连通性测试，不导入元数据 |
| 决策 4 预设语义 | 预设写入 `modelPresets`；「应用」= 把预设的 modelRoles 合并进全局 modelRoles 并设 defaultThinkingLevel，与 `/modelpreset switch` 等价，不依赖 OMP 命令 | P1 已验证；用户不重启也想立即生效 | 若 OMP 对预设切换有额外状态（如会话级覆盖），需改为调用 CLI | 只维护预设，让用户自己在 OMP 里切换 |
| 决策 5 连通性测试 | 只做 `GET {baseUrl}/v1/models`（5s 超时、服务端代发、密钥不出服务端）；失败时降级为 `GET baseUrl` 探活，不发送付费对话请求 | 避免产生 token 费用；P3 端点可用 | 若某服务不提供 models 端点且探活无意义，则该 provider 只显示「不可测」 | 增加一次 1-token messages 请求（可能计费） |
| 决策 6 非目标 | 不编辑 `modelOverrides`、项目级 `.omp/config.yml`、agentModelOverrides、cycleOrder；不做浏览器自动化 | 控制 v1 面积；这些是低频或需额外语义 | 若用户需要按项目切换，再立专项 | — |

## 4. 实施计划

### P0 正确性（约 2–3 小时）

**P0-1 YAML 输出格式**
- 位置：`config-store.js :: change()` 第 84 行。
- 改动：抽 `serialize(doc)` → `Bun.YAML.stringify(doc, null, 2)`，若末尾无 `\n` 补一个；解析校验保持不变。
- 验收：临时目录保存后 `config.yml` 为多行块格式、以换行结尾；`omp config get modelRoles` 正常。

**P0-2 角色选择器支持 `:auto` / `:inherit`**
- 位置：`role-selectors.js :: splitSelector()`（正则只列到 `max`）；`app.js` 的推理档位下拉。
- 改动：正则加入 `auto|inherit`；下拉增加「自动 / 继承（显式）」两项，且只在用户显式选择时写入后缀。
- 注意：模型 ID 本身可能含冒号（`cn:auto`），已用 knownModels 优先判定，保持不变。
- 验收：`splitSelector('a/b:auto', [])` 返回 `{model:'a/b', effort:'auto'}`；`splitSelector('a/cn:auto', ['a/cn:auto'])` 不拆分；新增用例进 `role-selectors.test.js`。

**P0-3 静态资源白名单集中**
- 位置：`server.js:37`。
- 改动：提为常量数组或「仅允许根目录已知扩展名」的显式列表；新增前端模块时只改一处。
- 验收：现有 4 个资源仍 200，未知路径仍 404。

**P0-4 角色引用告警**
- 位置：`config-store.js` roles 分支。
- 改动：保存前收集 `modelRoles` 中以 `provider/model` 形式出现、但 provider 不在 `models.providers` 且不是 `web/`、`@` 的值，返回 `warnings`；不阻断保存。
- 验收：写入 `wb-api/不存在` 时响应含 warning；`@default`、`web/tavily` 不告警。

### P1 工作流（约 1–1.5 天）

**P1-1 模型目录拉取**
- 新 API：`POST /api/probe`，body `{ providerId }`。
- 服务端：从 `ConfigStore` 取该 provider 的 `baseUrl/apiKey/authHeader`，`fetch(baseUrl 规范化 + '/v1/models')`，5s `AbortSignal.timeout`；只返回 `{ ok, status, ms, models:[{id,name,contextWindow,maxTokens,input,reasoning}] }`。**不得回传 apiKey。**
- baseUrl 规范化：已以 `/v1` 结尾就不再拼；Anthropic 根地址按追加 `/v1/models` 处理（该代理实测可用）。
- UI：服务页「测试连接 / 拉取模型」按钮；返回后弹勾选列表，默认勾选未配置的模型；合并规则：同 id 覆盖元数据，新 id 追加，已有但未勾选的不删除。
- 验收：对 7864 返回 ≥10 个模型且元数据非零；响应体 grep 不到密钥；断网/401 在 5s 内显示错误。

**P1-2 预设（modelPresets）**
- 新 action：`preset-save` / `preset-delete` / `preset-apply`。
- 数据结构：`config.modelPresets[name] = { modelRoles, defaultThinkingLevel }`；名称限 `[a-zA-Z0-9_-]{1,64}`。
- `preset-apply`：把该预设的 `modelRoles` 合并进全局 `modelRoles`（保留预设未提及的角色），并设置 `defaultThinkingLevel`；一次原子写入，返回被覆盖的角色列表。
- UI：Role 页顶部预设条（下拉 + 应用 + 另存为当前 + 删除）；应用前显示将修改的 Role 数量。
- 验收：创建两个预设，切换后 `omp config get modelRoles` / `defaultThinkingLevel` 与预设一致；`omp config get modelPresets` 可见；`bun test` 覆盖保存、应用、删除、非法名。

**P1-3 批量统一角色**
- 新 action：`bulk`，body `{ model, thinking, exclude? }`。
- 服务端：受管角色 = 现有 `modelRoles` 键 ∪ 内置聊天角色（`default/smol/slow/vision/plan/commit/tiny/memory/task/advisor/widget/judge`），排除 `image/web/speech/dictation` 与 `exclude`；写入 `modelRoles` 与 `defaultThinkingLevel`。
- UI：Role 页「批量设置」表单：模型输入（沿用 datalist）+ 档位 + 预览列表 + 二次确认。
- 验收：从当前配置执行后 13 个聊天角色均为 `wb-api/cn:deepseek-v4.1-flash:low`，`web/tavily` 不变，`defaultThinkingLevel=low`；与该能力的 CLI 脚本 `switch-all-to-deepseek.js` 结果一致。
- 备注：`switch-all-to-deepseek.js` 保留作为无服务时的命令行等价物，README 注明二者关系。

**P1-4 服务端测试覆盖**
- `config-store.test.js`：块格式断言、bulk、preset CRUD/apply、未知名告警。
- `server.test.js`：probe 使用本地假服务，断言超时、401、密钥不回传、Content-Length 上限不变。
- `role-selectors.test.js`：auto/inherit。
- 验收：`bun test` 全绿；新用例不依赖真实 `~/.omp` 与 7864。

### P2 后续（约 1 天，按需）

- 保存前 diff 预览：`POST /api/config { dryRun:true }` 返回将要写入的文本差异；UI 用 `<pre>` 展示增删行。
- 备份列表 + 一键恢复：只允许 `model-manager-backups/` 下的路径，恢复前先备份当前文件；恢复后提示重新加载。
- `fs.watch` + SSE 提示外部修改，避免「重新加载」按钮遗忘。
- 按角色的 `retry.fallbackChains` 编辑（本地代理挂掉时自动回退到 xiaomi 等）。
- 浏览器交互验收记录（手工清单即可，不引入 Playwright）。

## 5. 兼容、失败处理与安全

- 所有写入沿用现有「备份 → 临时文件 → rename」，失败回滚；新增 action 必须复用 `change()` 的 revision 冲突检查。
- probe 只读不写；请求由 Bun 服务端发出，浏览器只拿结果；日志不打印 header。
- 批量/预设写入后不重启 OMP：modelRoles 支持热加载；当前会话的 active model 不会自动切换，UI 明示。
- 预设、bulk、probe 的输入全部二次校验（名称正则、模型存在、档位枚举），错误返回 400，不写文件。

## 6. 验证与验收

1. `bun test` 全绿（现有 9 项 + 新增约 8–12 项）。
2. 临时配置目录（`OMP_MANAGER_CONFIG_DIR`）跑完整流程：启动 18766 → 拉取模型 → 批量 → 存预设 → 切换预设 → 恢复备份。
3. 用临时目录 + `PI_CODING_AGENT_DIR` 让真实 `omp config get` 读取结果，确认 OMP 能解析。
4. 真实配置只做只读探测；批量与预设先在临时目录验收，再由用户确认后对真实配置执行。
5. 手工浏览器验收：三个流程各截图/记录一次（不引入自动化）。

## 7. 已知盲区

| 盲区 | 为何暂不处理 | 代价 | 何时必须回来 |
|---|---|---|---|
| OMP `/modelpreset switch` 的真实切换语义未跑 | 预设应用改为直接写 modelRoles，绕开该命令 | 若 OMP 还有会话级预设状态，可能与 UI 表现不一致 | 用户报告「应用预设后 OMP 里显示不一致」 |
| 代理是否对 `/v1/models` 计费未知 | 实测为普通列表接口，未见计费说明 | 极低 | 收到账单异常 |
| YAML 注释仍会丢失 | Bun 无 CST，定点替换脆弱 | 手写注释需重加 | 用户开始维护复杂注释/锚点 |
| 项目级 `.omp/config.yml` 覆盖 | 不在 v1 范围 | 项目内切换以项目配置为准，UI 显示全局值 | 用户提出按项目切换 |
| 浏览器自动化缺失 | 项目约定零依赖、未装 Playwright | 回归靠手工清单 | 前端改动频率升高 |

## 8. 实施顺序摘要

1. P0-1 / P0-2 / P0-3（半天，先把破坏性和正确性问题清掉）。
2. P1-1（模型拉取，单独可用，先交付）。
3. P1-3（批量，最小闭环，立刻替代脚本）。
4. P1-2（预设，依赖批量后的稳定写入）。
5. P1-4 + 文档（README/AGENTS 同步）。
6. 用户验收后，再决定 P2 顺序。

## 9. 代码锚点速查

| 位置 | 作用 |
|---|---|
| `config-store.js :: change()` | 所有写操作、备份、revision 冲突、YAML 序列化 |
| `config-store.js :: snapshot()` | 返回 providers / roles / roleTags / directory |
| `server.js:12` | Bun.serve 路由与安全校验 |
| `server.js:37` | 静态资源白名单 |
| `role-selectors.js :: splitSelector()` | 模型与档位拆分（缺 auto/inherit） |
| `app.js :: openProvider()` / `renderModels()` | 服务表单与模型列表 |
| `app.js :: openRoles()` / `save()` | Role 编辑、保存 |
| `switch-all-to-deepseek.js` | 本轮临时 CLI，P1-3 的服务端等价能力 |
