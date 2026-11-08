# omp-view 优化方案（v3.5）

- 版本：v3.5（已实施；v2 三路评审 + v3.1–v3.4 收口后修订）
- 环境：Windows、Bun 1.4.4、OMP ≥ 18.18.1（实测 18.18.1）
- 代码：`D:\desktop\omp-view`

## 0. v2 → v3 主要变化

1. **删除 `/api/discover` 与「验证连接」**。实测 `omp models <provider> --json` 在错误密钥、死端口、未知 provider 下均 exit 0；暖缓存还会直接返回旧模型（OMP 模型缓存 TTL 2h，刷新失败保留 stale）。它不能作为连通性证据。模型目录由 OMP 原生 discovery 提供，omp-view 只写 5 行配置。
2. **只保留 discovery 开关**，并补全 UI 可达性：空 models 的服务可重新打开、可关闭发现、显式条目可留空继承。
3. **删除角色模型存在性告警**（对 discovery provider 系统性误报，且无内置 provider 清单）。
4. **删除 `splitSelector` 的 auto/inherit 扩展**（Role 页下拉不支持，保存会静默丢后缀；属纯展示收益）。
5. **judge 不再混入批量集合**：批量只覆盖非 model-kind 角色；judge 用单独复选框覆盖，且只写 `provider/model`，不带思考后缀。
6. **预设应用复用 roles 的完整校验**（键名、换行、`@` 别名解析、循环、原型键），整表替换，只写全局；不做无法正确的项目目录检测，只保留静态说明。
7. 修 `change()` 写盘判定、空备份目录、`widget` 内置角色误判为可删、`defaultThinkingLevel` 枚举。

## 1. 目标与核心任务

**核心任务**：让 omp-view 覆盖「切换模型与角色」的可用闭环：模型元数据由 OMP 自动发现、能一键把全部聊天角色套到某模型与档位、能把当前角色组合存成预设并整表切回；保存结果可读、写入不静默失败。

**痛点与证据**

| # | 痛点 | 证据 |
|---|---|---|
| 1 | 换一套模型要逐个 Role 手点 | 本次切换 12 个 Role 只能靠临时脚本 |
| 2 | 无预设，两套模型无法一键切回 | `config.yml` 无 `modelPresets`；用户不想开 TUI |
| 3 | 模型元数据过时、只配 1 个 | 代理实际 17 个；配置 `1048576/65536`，代理 `1000000/128000`；OMP discovery 一次可取全 |
| 4 | 保存后单行 flow YAML | `config-store.js:84` 无缩进参数 |
| 5 | 新增 action 静默不写 | `config-store.js:88` 非 roles 强制 `changed[1]=false` |
| 6 | 全局思考档位不可编辑 | 无 UI；`off/inherit` 非法且被静默回落 `high` |

## 2. 核心前提

| 编号 | 前提 | 状态 | 依据 / 可证伪条件 |
|---|---|---|---|
| P1 | `modelPresets.<name>={modelRoles,defaultThinkingLevel}` 可写入并被 OMP 读取 | 已证实 | `omp://settings.md`；临时目录写入后 `omp config get modelPresets` 原样返回 |
| P2 | `Bun.YAML.stringify(doc)` 默认 flow 单行；`(doc,null,2)` 为块格式 | 已证实 | Bun 1.4.4 实测；两者默认都不带尾换行 |
| P3 | `discovery.type: openai-models-list` 对 `anthropic-messages` provider 有效 | 已证实 | 临时目录 `omp models wb-api --json`：17 条，`1000000/128000`，thinking 齐全，首次约 12s |
| P4 | discovery provider 的 `models` 可为空（缺失或 `[]`） | 已证实 | 临时目录空数组/缺失均返回 17 条 |
| P5 | 显式 `models` 条目只覆盖已提供字段，未提供字段继承发现值 | 已证实 | 只写 `{id,name,input:[text,image]}` → 返回 `1000000/128000`、`text+image` |
| P6 | 全局 `defaultThinkingLevel` 合法值不含 `off/inherit`，非法值静默回落 `high` | 已证实 | `omp://settings.md:518`；临时目录实测 `off → high` |
| P7 | `/modelpreset switch` 为整表替换（清空未含角色） | 已证实（文档） | `omp://models.md:842`；未在 TUI 实跑 |
| P8 | `change()` 只写/只备份受影响文件；第 88 行会让非 roles action 不落盘 | 已证实 | 代码与测试 |
| P9 | 前端零构建；新增静态文件需登记白名单 | 已证实 | `server.js:37`；AGENTS.md |
| P10 | `omp models` 在失败时无可用信号（exit 0、空或 stale 列表） | 已证实 | 四路复核实测：错误密钥/死端口/未知 provider 均 exit 0；暖缓存直返旧模型 |

## 3. 决策登记表

| 决策 | 选定实现 | 依据 | 推翻条件 | 备选（未采纳原因） |
|---|---|---|---|---|
| 决策 1 范围 | v1 = P0 快改 + discovery 开关 + 批量 + 最小预设；P2 = diff/恢复/SSE/回退链 | 只保留不可替代的能力 | 预设在真实使用中频率低 → 可再砍 P1-3 | 全量做（验收面过大） |
| 决策 2 YAML 写入 | 不引依赖；`stringify(doc,null,2)` + 尾换行；注释仍丢失 | 零依赖；Bun 无 CST | 用户依赖注释/锚点 → 另立决策引入 `yaml` | 引入 `yaml` Document API |
| 决策 3 模型元数据 | 只写 `discovery:{type:'openai-models-list'}`；UI 不拉取、不探测、不显示发现列表；显式条目仅作覆盖 | P3/P4/P5；`omp models` 无失败信号（P10） | 若 OMP 增加带 source/fetchedAt 的稳定接口 → 再接展示 | 自建 HTTP probe（需复刻凭据/headers/`!cmd`）；`omp models` 包装（假成功） |
| 决策 4 预设语义 | 整表替换全局 `modelRoles`，写合法的 `defaultThinkingLevel`；不切活动模型、不处理会话覆盖；只写 global | `omp://models.md:842` 的核心语义 | 若 TUI 实跑发现还有别的状态 → 重开 | 合并语义（与 OMP 不一致）；写项目层（本工具只管理全局） |
| 决策 5 批量实现 | 前端预填所有非 kind 角色输入 + 全局档位，复用现有 roles 保存 | 零新增写入口 | 若 roles action 结构不够 → 再抽 action | 新 bulk action（需额外修 TOUCHES） |
| 决策 6 judge | 批量默认不含 judge；单独复选框覆盖时只写 `provider/model`，不带档位 | judge 是 model-kind role，不用聊天档位；覆盖会失去原生 Jev | 用户明确要统一 judge 档位 → 另议 | 把 judge 混进聊天集合（会写非法后缀） |
| 决策 7 校验边界 | 格式/枚举/名称/别名/循环 → 400；不做模型存在性校验与告警 | 无完整模型目录；告警对 discovery 必误报 | 引入目录缓存后再升级 | 保存时调 `omp models`（慢且不可靠） |
| 决策 8 UI 档位 | Role 页保持现有档位下拉（off…max）；不新增 auto/inherit | 扩展会与下拉不匹配并静默丢后缀 | 用户需要在 UI 显式设 auto/inherit → 一并改下拉与拆分 | 只改 splitSelector（已证实会丢值） |
| 决策 9 非目标 | 不编辑 modelOverrides、不写项目级、不做浏览器自动化、不改启停脚本 | 控制面积 | 用户提出按项目切换 | — |

## 4. 实施计划

### P0 低风险快改（约 3 小时）

**P0-1 YAML 与备份**
- `config-store.js`：`serialize(doc)` → `Bun.YAML.stringify(doc, null, 2)` + 补 `\n`；备份目录只在确有文件写入时创建；无写入时 `backup: null`。
- 验收：保存后多行、末尾换行；同一排版下第二次无变更保存不产生备份目录，前端不提示「已备份」。首次保存因排版归一仍会重写，属已知代价。

**P0-2 写盘判定**
- `config-store.js:88` 改为模块级导出的显式映射：
  ```js
  export const TOUCHES = { provider: [0], delete: [0], roles: [1], 'preset-save': [1], 'preset-apply': [1], 'preset-delete': [1] };
  ```
  `const targets = TOUCHES[action]; if (!targets) throw new Error('内部错误：action 未登记写盘目标');`；`changed[i] &&= targets.includes(i)`；返回 `changedFiles`，无写入时 `backup: null`。
- 验收：直接单测 TOUCHES 映射表（不经 action 分发）；未知 action 不写盘、不建备份目录且报错可读；`changedFiles: []` 时 `backup: null`。

**P0-3 共享角色定义（并入现有模块）**
- 在现有 `role-selectors.js`（已被 app.js 引入且已登记白名单）中增加：
  - `ROLE_DEFS`：显示名/描述，含 `widget`；kind 角色 `image/web/speech/dictation/judge`。
  - `KIND_ROLES`、`SELECTOR_EFFORTS`（9 值，供 CLI 与校验）、`SETTING_THINKING_LEVELS`（7 值）。
- 不新建 `role-config.js`，避免新增白名单项与文档行。
- `app.js` 删除内联 `roleNames`/`kindIds`，改用 `ROLE_DEFS`/`KIND_ROLES`。
- `config-store.js` 的内置角色删除保护加入 `widget`。
- `snapshot()` 增加只读字段 `presets`、`defaultThinkingLevel`、`modelRoleStorage`（后续 P1-2/P1-3 依赖，必须在此之前完成）。
- 验收：`widget` 显示为内置、无删除按钮；删除 `widget` 被拒；`snapshot()` 返回三个新字段。

**P0-4 roles action 扩展与预设引用**
- `roles` 分支增加可选 `defaultThinkingLevel`（7 值；`null` 删除）。
- 抽出 `parseRoleSelectors(value)`：按逗号拆分、trim、跳过空项，识别 `@role`/`pi/role`/`*`；`validateModelRoles(roles)` 用它做键正则/换行/别名解析/循环检查。roles 与 preset-apply 共用。
- `assertUnused` 改为逐选择器比较，并同时扫描 `modelRoles` 与 `modelPresets[*].modelRoles`。匹配规则：先判断完整值是否等于 `provider/model`，再看是否以 `provider/model:` + 已知档位后缀（`SELECTOR_EFFORTS`）开头；**不要盲目剥离 `:auto`**（真实模型 id 可能是 `cn:auto`）。`parseRoleSelectors` 接受当前 provider 的显式模型 id 集合，完整命中时不剥离后缀。
- **不设 discovery 例外**：没有可靠目录信号，无法证明被移除的 id 仍可发现；移除显式条目照常拦截。用户想用发现值应清空字段而不是删除条目（P1-1）。
- 已知限制：`@` 间接引用只解析一层（与现有 roles 校验一致）。
- 验收：`defaultThinkingLevel: off` → 400；逗号列表 `a/x,b/y` 的任一项被删除都被拦；`b/y,a/x` 顺序不影响；`cn:auto` 与 `cn:auto:high` 两种引用都能命中；删除被预设引用的模型被拒。

**P0-5 CLI 修正**
- `switch-all-to-deepseek.js` 导入 `role-selectors.js` 的共享定义。
- `--thinking` 接受 9 个角色档位；仅当值属于 7 个全局档位时写 `defaultThinkingLevel`，否则打印「仅角色后缀，不改全局」。
- judge 默认不覆盖；新增 `--include-judge`，值为 `provider/model`（无后缀）。
- 目标模型解析：`--model` 显式给出时，若 provider 带 discovery，**按原文接受、不做后缀剥离**（档位由 `--thinking` 提供）；非 discovery provider 先做完整值命中已知模型，再考虑后缀。自动识别 DeepSeek 仍只扫显式列表，找不到时提示「请用 --model 指定（可能来自自动发现）」。
- 写文件时同样补尾部 `\n`，避免与 omp-view 交替保存时互相触发重写与备份。
- 验收：`--thinking=off` 成功写角色后缀且全局档位不变；默认结果不再包含 judge；`--include-judge` 时 judge 无后缀；discovery provider 可用 `--model` 切换。

### P1 工作流（约 0.5–1 天）

**P1-1 discovery 开关（只写配置）**
- `config-store.js` provider 校验与合并：
  - 开头统一 `const models = data.models ?? []; if (!Array.isArray(models)) throw ...`；全程用 `models`；写回时始终写 `models: []`（不要省略），避免前端 `draft.models.map` 崩溃。
  - 空 `models` 对**任何带 `baseUrl` 的自定义 provider**合法（取消 discovery 后仍可保存）；仅在既无 models、又无 discovery、且无 baseUrl 时按 override-only 处理。仍有 models 时，空 id/重复 id/非对象条目照旧拒绝；有 discovery 或无 limits 时允许缺 `contextWindow/maxTokens/reasoning`。
  - 合并必须按字段处理，不能直接 `{...old, ...data}`：
    ```js
    const { discovery, auth, ...rest } = data; // auth 不落地，始终用 old.auth
    const merged = { ...old, ...rest };
    if (discovery === null) delete merged.discovery;
    else if (discovery) merged.discovery = { ...(old.discovery || {}), ...discovery };
    ```
    **绝不能把 `null` 写入 YAML**（实测 OMP 会报 `providers.<id>.discovery: must be an object (was null)`，所有自定义 provider 一起失效）。
  - `apiKey` 规则：以合并前的 `old.auth` 为准（`auth` 视为高级字段，UI 不编辑，写入前从 payload 剥离）。空字符串/缺失且 `old.auth` 不是 `none|oauth` → 400；若 `old.auth` 是 `none|oauth`，**删除 `apiKey` 键**（`delete merged.apiKey`），绝不能写 `""`。实测 OMP 对 `apiKey: ""`（即使 auth none/oauth）报 `must be apiKey a non-empty string` 并禁用全部 custom provider。
  - 模型条目字段归一：
    - `contextWindow/maxTokens` 只接受有限 number；`''`、`null`、`undefined`、非有限数视为缺省并删除键；字符串（含数字字符串）一律 400。
    - `reasoning` 单独按布尔处理：`''`/`null`/`undefined` 删除键；`true/false` 原样写入。
  - 模型条目按「可编辑字段重建」而不是整对象合并，才能清空旧值：
    ```js
    const EDITABLE = ['name','reasoning','input','contextWindow','maxTokens'];
    const entry = { ...oldModel };
    for (const k of EDITABLE) delete entry[k];
    Object.assign(entry, m); // m 中缺省的键不再写入
    ```
    其余高级字段（`cost`/`headers`/`compat` 等）保留。
  - 手写的 `discovery.injectV1`/`timeoutMs`/`advertisedReasoning` 通过上面的嵌套展开保留；UI 只暴露 `type`。
- `app.js`：
  - 服务页新增「自动发现模型（openai-models-list）」复选框；**仅当现有 `discovery.type` 为空或等于 `openai-models-list` 时才可操作**。其他类型（ollama/proxy/litellm…）显示只读提示「由手写配置提供，本页不改」，提交时不发送 `discovery` 字段，避免把 type 改写成 openai-models-list 或误删。
  - 勾选写 `{type:'openai-models-list'}`，取消写 `null`（服务端删除键）。
  - 打开已有 provider 时 `draft.models = Array.isArray(draft.models) ? draft.models : []`（手写 discovery provider 可能没有 models 键，畸形值也不崩）。
  - 只读「内置服务 · 参数覆盖」早退条件改为：无 models、无 discovery **且无 baseUrl**；有 baseUrl 的空模型自定义服务仍显示表单。侧栏与标题区分「自动发现」「空模型自定义服务」「内置服务参数覆盖」；`init()` 允许打开这些 provider。
  - discovery 开启时：
    - 允许移除最后一个模型（`disabled` 条件改为「仅剩 1 行且未启用 discovery」）。
    - `freshModel()` 在 discovery 模式下不填默认 limits；渲染时用空字符串 + 占位「自动发现」；移除 `required`。
    - `syncModels` 对空字符串/NaN **省略键**；对 discovery 模式**不采集、并在条目对象上 `delete reasoning`**（不能只隐藏控件）；保留「支持图片」并写 `input`。
    - 用户清空已有条目的 limits 时，提交对象中不得带旧值（按新对象重建，而不是 `Object.assign` 到旧对象）。
  - 帮助文本：「显式条目只覆盖填写的字段；上下文字段留空即使用 OMP 发现值；发现值不会在页面列出」。
- 验收（临时目录，仅结构往返，不用真实密钥）：
  - 勾选 → 保存 → 重开服务页仍可编辑；models.yml 含 `discovery` 且无 `null`。
  - 取消勾选（即使 models 为空）→ 保存后 models.yml 无 `discovery`；再次保存不会复活。
  - 仅 `{id,name,input:[text,image]}` 的条目保存后只有这些字段；已有条目清空 limits 后字段消失（不是保留旧值）。
  - 手写 `injectV1:false` 在保存后仍存在。
- 真实发现结果只在 §6.3 的临时目录步骤验证（真实配置只读）。

**P1-2 批量设置**
- Role 页新增「全局默认思考档位」下拉：选项为 7 个合法值 + 「保持当前」（不发送字段）+ 「不设置（发送 null 删除该键）」，初始值读 `snapshot.defaultThinkingLevel`；不得用空选项默认删除已有键。
- 新增批量区：模型输入（datalist）+ 角色档位（现有 8 选项）+「填入全部聊天角色」+「同时覆盖 judge」复选框。
- 填写逻辑：遍历所有 `[data-role-card]` 中非 `KIND_ROLES` 的卡片（含自定义 `designer`、`widget`），设置模型与档位；勾选时把 judge 卡片模型设为 `provider/model`（不带后缀）。全局档位映射：批量档位为空（继承/自动）→ 全局下拉置「保持当前」（不发送字段）；仅 7 个合法值同步到全局下拉；`off/inherit` 不写全局。所有程序化赋值都 `dispatchEvent(new Event('input', {bubbles:true}))`，确保 `dirty` 置位。不自动保存。
- 保存：沿用 roles action，附带 `defaultThinkingLevel`。
- 验收：临时目录保存后，11 个内置非 kind 角色（含 `widget`）为 `wb-api/cn:deepseek-v4.1-flash:low`；fixture 预置 `designer` 时为 12 个。`web/tavily` 不变，全局档位为 `low`；judge 选项关闭时保持原值，勾选时只写 `wb-api/cn:deepseek-v4.1-flash`（无后缀）。

**P1-3 最小预设**
- 新 action（全部走 `change()` 与 TOUCHES）：
  - 名称与容器校验按 action 区分：
    - 三个 action 都要求 `name` 为非空字符串、拒绝 `constructor/prototype/__proto__`。
    - `preset-save`：`modelPresets` 缺失时创建 `{}`；容器存在但非对象（含数组）→ 400；同名覆盖需确认，不因首次创建而 400。
    - `preset-apply`/`preset-delete`：`modelPresets` 必须是非 null 对象（不含数组）、`Object.hasOwn` 命中、命中的预设必须是非 null 对象（不含数组）；apply 时 `modelRoles` 必须是对象；不满足一律 400，不得抛 TypeError。
  - `assertUnused` 扫描预设时跳过 `null`/非对象条目（OMP 用它隐藏预设），与 apply/delete 的 400 语义分开。
  - `preset-save`：`{name}`，名称非空、≤64、无 `/` `\` 换行；用 `structuredClone(config.modelRoles)` 与合法 `defaultThinkingLevel` 生成整条（**禁止直接赋同一对象引用**，否则 Bun 会写出 YAML 锚点 `&/*`，后续改角色会连带改写预设）；同名时先确认覆盖。注意：OMP 自身保存的是 effective assignments，本工具只抓全局层，差异写入文档。
  - `preset-apply`：`{name}`，用 `validateModelRoles(preset.modelRoles)` 校验后**整表替换** `config.modelRoles = structuredClone(preset.modelRoles)`；`defaultThinkingLevel` 缺失则保持当前值，存在但不在 7 值枚举内 → 400（与 roles 分支一致）；写后按新角色集合裁剪 `modelTags` 与 `cycleOrder`（与现有自定义 Role 删除一致），不保留悬空项；返回 `added/removed`。
  - `preset-delete`：`{name}`，不存在返回 400。
- UI：Role 页顶部预设条（下拉、应用、另存为当前、删除）。有未保存修改时先确认。应用前用当前角色与预设做客户端 diff，确认「覆盖 X 个、清除 Y 个」。全局档位下拉区分「保持当前」（不发送字段）与「不设置（发送 null 删除该键）」。
- `modelPresets` 中的 `null` 或非对象条目（OMP 支持用 null 隐藏预设）：列表忽略，写其他预设时原样保留，不静默删除。
- 静态提示：「只写全局配置；`modelRoleStorage: project` 时 OMP 可能优先项目层，本工具无法检测任意项目目录」。snapshot 读到 `modelRoleStorage === 'project'` 时，预设条显示强警告（不阻止）。
- 验收：`omp config get modelPresets` 可见；应用后全局 `modelRoles` 与预设完全一致（含清空）；应用后改角色，`modelPresets` 不变（无锚点/无引用共享）；悬空 `@` 预设被 400；`__proto__` 名称被拒；`modelRoleStorage: project` 出现强警告；同名覆盖需确认；`modelTags`/`cycleOrder` 无悬空项。

**P1-4 测试与文档**
- 测试新增（约 12–15 项）：
  - config-store：块格式/尾换行、无变更不备份与 `backup:null`、TOUCHES、roles 的 defaultThinkingLevel、preset save/apply/delete、整表替换、`__proto__`、悬空别名、预设无 YAML 锚点、应用后改角色不影响预设、应用后裁剪 modelTags/cycleOrder、assertUnused 逐项/逗号/预设/`cn:auto`、discovery 空 models/部分字段/取消发现/高级字段保留/清空 limits、widget 删除保护。
  - role-selectors：不变，现有 6 断言保持。
  - 不新增 `omp` 子进程测试；discovery 用临时目录手工验收。
- 文档：README/AGENTS 更新版本号、测试数、discovery 开关、预设能力与「不切活动模型/只写全局」、UI 不支持 auto/inherit、judge 副作用、删除 probe 相关描述；同时改 `index.html` 页脚「每次保存自动备份」与 `app.js::save()` 的 toast，按 `changedFiles/backup` 分支提示。

### P2 后续

- 保存前 diff 预览（`dryRun`）。
- 备份列表 + 一键恢复（realpath、拒符号链接、恢复前再备份、解析校验）。
- 外部修改提示（fs.watch）。
- 回退链编辑。
- 备份保留策略（最近 50 份）。
- 手工浏览器验收清单。

## 5. 兼容、失败处理与安全

- 所有写操作沿用「备份 → temp → rename」；新增 action 必须走 `change()` 与 TOUCHES。
- omp-view 不读取、不记录、不回传凭据；启用 discovery 后，凭据解析（包括 `!cmd`）由 OMP 自身在加载/探测时执行，这是 OMP 的既有行为。
- `modelRoles` 变更对后续子 Agent 路由即时生效；当前会话的活动模型不变；`defaultThinkingLevel` 是否热加载未在官方清单内，UI 提示「建议重启」。
- 预设应用不做 `default` 可用性检查（OMP 会拒绝而本工具会写入）；UI 在应用前提示这一差异。

## 6. 验收

1. `bun test` 全绿（现有 9 + 新增约 12–15 项）。
2. 临时目录全流程：保存 discovery provider（空 models）→ 重开可编辑 → 取消 discovery → 批量设置 → 存预设 A/B → 应用 A/B；每步用 `PI_CODING_AGENT_DIR` + `omp config get` 校验。
3. 真实配置只读检查：手工运行 `omp models wb-api --json` 并记录当前条数（当前 models.yml 未启用 discovery，预期 1 条；这不是失败）。17 条只在临时目录启用 discovery 后验证：`apiKey` 写成环境变量名，磁盘上不出现密钥。
4. 手工浏览器验收三个流程：discovery 往返、批量保存、预设应用（按 §6 第 2/3 条执行，不产出清单文件）。
5. 回归：provider/Role 保存、409 冲突、备份内容与恢复语义不变；仅「无变更时不再建备份目录」是预期变化。

## 7. 已知盲区

| 盲区 | 为何暂不处理 | 代价 | 何时必须回来 |
|---|---|---|---|
| `/modelpreset switch` 未在 TUI 实跑 | 无 CLI 入口；依据文档 | 若还有会话级状态，表现可能不一致 | 用户报告预设切换不一致 |
| UI 不能显式设置 `:auto`/`:inherit` | 下拉不支持，扩展会丢值 | 只能手改配置或整体继承 | 用户需要按角色显式 auto/inherit |
| 发现列表不在页面展示 | `omp models` 无可靠失败信号，且 12s/次 | 用户需在终端查看或自由输入模型 id | 用户要求页面内浏览目录 |
| `defaultThinkingLevel` 热加载时机 | 官方清单未列 | 运行中写入可能新会话才生效 | 用户要求免重启生效 |
| 项目层与 `modelRoleStorage: project` | 只写全局，无法可靠检测任意项目目录 | 项目内可能被覆盖 | 用户提出按项目切换 |
| YAML 注释丢失 | Bun 无 CST | 手写注释需重加 | 用户维护复杂注释 |
| judge 覆盖失去原生 Jev | 由用户勾选 | 评判能力变化 | 用户依赖 judge 质量 |
| `assertUnused` 的 `@` 间接引用只解析一层 | 与现有 roles 校验一致 | 极端别名链可能漏检 | 用户使用多层 `@` 引用 |
| discovery 高级字段（`injectV1`/`timeoutMs`） | UI 只暴露 `type`，手写字段保留 | 版本化根路径网关可能发现失败且无提示 | 用户使用 `/v3/compat` 类网关 |
| 发现目录不保证覆盖被移除的显式 id | 无可靠目录接口；只能由用户确认 | 网关限流/版本化时角色可能悬空 | 用户删除显式条目后 OMP 报模型不存在 |
| 浏览器自动化缺失 | 零依赖约定 | 回归靠手工清单 | 前端改动频率升高 |

## 8. 实施顺序

1. P0-1 / P0-2（写入正确性，先补测试）。
2. P0-3（共享定义，解除 app/config-store 漂移）。
3. P0-4（roles 校验与预设引用）。
4. P1-1（discovery 开关，独立可用）。
5. P1-2（批量，复用 roles）。
6. P1-3（预设，依赖 TOUCHES 与校验）。
7. P0-5（CLI 对齐）。
8. P1-4（测试与文档）。
9. 用户验收后决定 P2。

## 9. 代码锚点

| 位置 | 作用 |
|---|---|
| `config-store.js :: change()` 84 | YAML 序列化 |
| `config-store.js:88` | 写盘判定（必须改） |
| `config-store.js:89–90` | 备份目录创建（改为按需） |
| `config-store.js:28/45` | provider 空 models 与 discovery 合并/删除 |
| `config-store.js:50–77` | roles 校验（抽出共用） |
| `config-store.js :: assertUnused()` | 扫描 modelPresets |
| `config-store.js :: snapshot()` | 增加 presets/defaultThinkingLevel |
| `server.js:37` | 静态白名单（本次不新增文件） |
| `role-selectors.js` | 角色定义与两套档位枚举 |
| `app.js:5/7/18/26–29/49/55/62/65/99/105` | 角色定义、空 models 早退、档位、保存提示 |
| `app.js :: openRoles()` | 全局档位、批量、预设条 |
| `switch-all-to-deepseek.js` | CLI 对齐 |

## 10. v2 评审处置

| 来源 | 问题 | 处置 |
|---|---|---|
| CA-1 / CO-1 / CT-1 / OE-4 | `omp models` 无失败信号，缓存掩盖死连接 | 删除 `/api/discover` 与「验证连接」；只保留 discovery 配置开关 |
| CA-2 / CT-2 | 扩展 auto/inherit 但下拉不支持，保存丢后缀 | 放弃 splitSelector 扩展；列为盲区 |
| CA-3 / OE-10 / CT-7 | 预设作用域/项目层 | 只写全局；删除 cwd 检测；静态提示 |
| CA-4 / CO-2 / CT-3 | 空 models/discovery provider UI 不可达 | P1-1 明确 4 处 UI 改造与往返验收 |
| CA-5 | 项目层 cwd 检测错误 | 删除动态检测 |
| CA-6 / CO-6 / OE-12 | discover 缓存/失败面 | 删除 discover |
| CA-7 | `OMP_PROFILE` 覆盖 `PI_CODING_AGENT_DIR` | 删除 spawn |
| CA-8 | 临时目录真实密钥违反 AGENTS | 删除 discover；真实目录仅手工只读 |
| CA-9 / CO-4 / CT-4 | 告警对 discovery 误报 | 删除模型存在性告警 |
| CA-10 | `omp models` 子串过滤 | 删除 spawn |
| CA-11 / CO-5 / CT-6 | judge 归类与验收矛盾 | judge 独立复选框，只写无后缀模型；批量集合不含 judge |
| CA-12 / CO-6 / CT-5 | 预设绕过校验、`__proto__` | 抽出 validateModelRoles；名称黑名单；共用 |
| CA-13 / CT-13 | widget 被当可删自定义角色 | ROLE_DEFS 含 widget；builtin 删除保护加入 widget |
| CA-14 | 无变更仍提示已备份 | 按 changedFiles 分支提示 |
| CA-15 / OE-12 | discover 纯函数测试落点 | 删除 discover |
| CA-16 | assertUnused 漏逗号/@ | 列入盲区 |
| CO-3 / CT-8 | `!cmd` 执行面 | 删除 discover；表述改为「由 OMP 解析」 |
| CO-7 | 留空继承被 `Number('')→0` 与强制字段破坏 | P1-1 明确 syncModels 省略空值、隐藏 reasoning |
| CO-8 | `omp models` 默认只列 chat kind | 删除 spawn |
| CO-9 | 文档仍称「一致」 | 决策 4 改为「核心语义对齐，差异已列」 |
| CO-10 | CLI 无法表达 off/inherit | `--thinking` 9 值；全局仅写 7 值 |
| CO-11 | providerId 与 `omp models` ACTION 冲突 | 删除 spawn |
| CO-12 | 取消 discovery 无法删除键 | `discovery: null` 删除语义 + 往返测试 |
| CO-13 | provider 拼写错误无告警 | 不做模型存在性告警，列入校验边界 |
| CT-9 | 发现结果不进 datalist | 列为盲区；显式条目可手填 |
| CT-10 | 真实目录验证会写 models.db | §6.3 已改为「不写 config/models.yml」 |
| CT-11 | snapshot 扩展晚于批量 | snapshot 扩展提前到 P1-1/P1-2 前置，实施顺序已调 |
| S-1 | `omp models` 无失败信号 | 同 CA-1：删除 discover 与「验证连接」 |
| S-2 | discovery-only provider 保存后打不开 | P1-1 明确早退条件、侧栏文案、允许删到 0 行 |
| S-3 | 发现结果不进 Role 候选 | 列为盲区（需可靠目录接口才做） |
| S-4 | assertUnused 阻止删除显式条目，抵消发现收益 | 不设 discovery 例外；改为清空字段继承发现值（P1-1），删除条目照常拦截 |
| S-5 / S-6 | 告警误报与 warnings 契约 | 删除模型存在性告警，不做 warnings |
| S-7 | 角色数量/judge 公式矛盾 | 批量集合排除 judge；验收改为 11 个内置 + fixture 预置 designer 为 12，judge 可选；CLI 用 `--include-judge` |
| S-8 | 预设 default 不可用/项目层/effective 差异 | UI 确认与强警告；只写全局；文档写明 preset-save 只抓全局层 |
| S-9 | assertUnused 逗号列表漏检 | P0-4 改为 `parseRoleSelectors` 逐项比较，并列入测试 |
| S-10 | `discovery: null` 会让整份 models.yml 失效 | 服务端删除键，绝不写 null；补往返测试 |
| S-11 | 留空继承被默认值/required 写回 | P1-1 明确省略空值、移除 required、隐藏 reasoning |
| S-12 | TOUCHES 验收依赖未实现 action | 改为映射单测；`backup:null` |
| S-13 | 无变更保存只在排版归一后成立 | P0-1/验收已限定 |
| S-14 | CLI 在 discovery 下找不到模型 | P0-5 增加 discovery-aware `--model` |
| S-15 | 验收需真实凭据/会写 models.db | §6.3 已改为「不改 config/models.yml，可能更新 models.db」 |
| S-16 | 预设 null/同名/缺档位/全局档位无法清除 | P1-3 补「不设置」选项、同名确认、缺失保持；null 预设列入限制 |
| S-17 | auto 拆分优先级 | UI 不扩展 auto/inherit，问题不引入 |
| S-18 | discovery 只暴露 type，漏 injectV1/timeoutMs | 手写字段保留；列入盲区 |
| V31O-1 | preset 共享对象引用 → YAML 锚点、预设被连带改写 | `structuredClone` 保存/应用；加「应用后改角色预设不变」测试 |
| V31O-2 | discovery null 在 payload 侧仍被写回 | 解构剥离 payload 的 `discovery`，只在合并时删除/深合并 |
| V31O-3 | parseRoleSelectors 盲剥 9 值后缀 | 接受 knownModels，完整命中不剥；`cn:auto` 用例 |
| V31O-4 | CLI discovery 放宽 + 盲剥写错模型 | discovery 下 `--model` 原文接受、不剥后缀 |
| V31O-5 | discovery 浅合并丢 injectV1/timeoutMs | 嵌套展开合并 |
| V31O-6 | UI 清空/隐藏字段仍写入旧值 | 条目重建、省略空键、`delete reasoning`、允许删到 0 |
| V31O-7 | TOUCHES 未登记 action 崩溃 | 导出 TOUCHES + 明确内部错误 |
| V31O-8 | 缺 models 时 `data.models.map` 崩溃 | 统一 `models = data.models ?? []`，始终写回 `[]` |
| V31O-9 | discovery 豁免无法验证可发现性 | 删除豁免，移除显式条目照常拦截 |
| V31O-10 | 临时目录验收要求真实密钥 | 改为结构往返；真实目录单独手工只读 |
| V31-L1/L2/L3 | 备份 toast、预设清理、档位语义 | P1-4 文案；apply 裁剪 tags/cycleOrder；「保持当前」与「删除」分离 |
| V31-1 | parseRoleSelectors 无 knownModels 守卫 | 同 V31O-3 |
| V31-2 | discovery 浅合并丢高级字段 | 同 V31O-5 |
| V31-3 | 取消 discovery 后空 models 不能保存/重开 | 空 models 对带 baseUrl 的自定义 provider 合法；早退需无 baseUrl |
| V31-4 | 隐藏 reasoning 仍写 false | `syncModels` 删除 reasoning 键 |
| V31-5 | 清空 limits 后旧值被保留 | 客户端重建条目 + 服务端按可编辑字段重建 |
| V31-6 | discovery 豁免按旧状态判定 | 豁免已删除；移除显式条目照常拦截 |
| V31-7 | snapshot 扩展晚于 P1-2 | 提前到 P0-3 |
| V31-8 | preset 名称查找未做 hasOwn/黑名单 | 三个 action 统一处理，不存在返回 400 |
| V31-9 | 预设应用留下 modelTags/cycleOrder 悬空 | apply 后裁剪 |
| V31-10 | 临时目录验收 12 个角色不可达 | 改为 11 个内置 + fixture 预置 designer |
| V31-11 | 无 models 键的 discovery provider 打开即崩 | `draft.models ||= []` |
| V31-12 | 假 action 测 TOUCHES 不可执行 | TOUCHES 模块级导出后单测 |
| V31-13 | CLI 无尾换行、文案未同步 | CLI 补 `\n`；index/toast 列入 P1-4 |
| V31-14 | §6 措辞矛盾 | §6.4/6.5 已改写 |
| V31A-1 | 清空字段仍保留旧值，留空继承不生效 | 客户端重建条目 + 服务端删除可编辑字段；补已有条目清空往返 |
| V31A-2 | 真实配置当前无 discovery，17 条验收不成立 | §6.3 改为记录当前 1 条；17 条只在临时目录（密钥走环境变量）验证 |
| V31A-3 | discovery 其他类型被复选框改写/删除 | 仅 type 为空或 openai-models-list 时可操作；其他类型只读且不发送字段 |
| V31A-4 | assertUnused 的 discovery 例外不可验证 | 删除例外；用清空字段继承，删除条目照常拦截 |
| V31A-5 | preset apply/delete 缺名称所有权校验 | 三 action 统一 hasOwn/黑名单/对象校验 |
| V31A-6 | 无 models 键时打开崩溃 | `draft.models ||= []` |
| V31A-7 | 空 apiKey 可写入导致整份配置失效 | 空 key 且无 auth none/oauth → 400 |
| V31A-8 | 新 role-config.js 冗余 | 并入 existing `role-selectors.js`，不新增白名单 |
| V31A-9 | 假 action 测 TOUCHES 不可执行 | TOUCHES 模块级导出后单测 |
| V31A-10 | 批量未同步全局档位/dirty | 同步全局下拉并 dispatch input |
| N1 | 空 apiKey + auth none/oauth 仍会使 OMP 禁用全部 provider | 空 key 且 old.auth 非 none/oauth → 400；none/oauth → 删除 apiKey 键，不写空串 |
| N2 | 预设 null/非对象导致 TypeError | apply/delete 统一校验容器、条目、modelRoles 与 name，不满足 400 |
| N3 | §10 残留 discovery 例外/真实目录 17 条 | S-4/V31O-9/V31-6 已改写；P1-1 末行改为临时目录 |
| N4 | 空字符串 limits 会写坏配置 | 服务端将 `''/null/undefined/非有限数`视为缺省并删除键；字符串/非数字 400 |
| N5 | 批量空档位无全局映射 | `''` → 「保持当前」（不发送字段），仅 7 值同步 |
| 高-1 | 预设校验误伤 preset-save 首次创建 | hasOwn/容器存在校验仅用于 apply/delete；save 缺失时创建 `{}`；数组不算对象 |
| 中-1 | apiKey 判定用 merged.auth，payload 可注入 auth | 以 `old.auth` 为准，`auth` 从 payload 剥离 |
| 中-2 | assertUnused 扫到 null 预设会崩 | 扫描跳过 null/非对象条目 |
| 中-3 | reasoning 布尔被并入数值校验；数字字符串未归一 | reasoning 单独按布尔；limits 只接受有限 number，字符串 400 |
| 中-4 | preset-apply 对非法 defaultThinkingLevel 静默忽略 | 存在但非法 → 400；缺失才保持当前 |
