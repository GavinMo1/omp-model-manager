# omp-view 优化方案（v2）

- 版本：v2（v1 经三路评审后修订；实现状态：未实施）
- 适用环境：Windows、Bun 1.4.4、OMP ≥ 18.18.1（评审时实测 18.18.1）
- 代码位置：`D:\desktop\omp-view`

## 0. v1 → v2 主要变化

1. **放弃自建 HTTP probe + 静态导入**，改用 OMP 自带的 `discovery.type: openai-models-list`；`omp models <provider> --json` 作为「刷新模型 / 验证连接」的唯一实现（实测 17 个模型、`1000000/128000`、思考档位齐全）。
2. **预设应用改为整表替换**，与 OMP `/modelpreset switch` 一致；明确「不切换当前会话的活动模型」，并检测项目层覆盖。
3. **批量统一不新增写入口**：复用现有 `roles` action，前端「批量设置」只预填表单；`roles` action 增加 `defaultThinkingLevel`。
4. **拆分两套思考档位枚举**：角色后缀 9 值、全局 `defaultThinkingLevel` 7 值；修复现有 CLI 脚本。
5. **修 `change()` 的写盘判定**：新增 action 默认只改 config.yml，但第 88 行会把 `changed[1]` 置 false，导致静默不写；改为显式 action→文件映射。
6. 删除 P0-3（静态白名单改造，收益过低）；P0-4 降为「只对自定义 provider 的模型 id 拼写告警」。
7. 备份恢复、diff 预览、SSE、回退链仍放 P2；核心任务不再承诺「一键恢复」。

## 1. 目标与核心任务

**核心任务**：让 omp-view 覆盖「切换模型与角色」的闭环：看得到模型（含自动发现）、能批量套用、能存成预设并整表切回；同时保存结果可读、写入不静默失败、错误配置有提示。

**用户痛点（现状证据）**

| # | 痛点 | 证据 |
|---|---|---|
| 1 | 换一套模型要逐个 Role 手点 | 本次 12 个 Role 切换只能靠临时脚本 `switch-all-to-deepseek.js` |
| 2 | 没有预设，两套模型无法一键切回 | `config.yml` 无 `modelPresets`；OMP 自带 `/modelpreset` 但用户不想开 TUI |
| 3 | 模型元数据过时且只配了 1 个 | 代理实际 17 个模型；`cn:deepseek-v4.1-flash` 配置 `1048576/65536`，代理报 `1000000/128000` |
| 4 | 保存后变成单行 flow YAML | `config-store.js:84` 用 `Bun.YAML.stringify(d)`；Bun 1.4.4 默认 flow |
| 5 | 新增写 action 会静默不写 | `config-store.js:88` 非 `roles` action 强制 `changed[1]=false` |
| 6 | 全局思考档位不可编辑，且枚举易写错 | 无 UI；`defaultThinkingLevel: off` 被 OMP 静默回落 `high`（实测） |

## 2. 核心前提

| 编号 | 前提 | 状态 | 依据 / 可证伪条件 |
|---|---|---|---|
| P1 | `modelPresets.<name> = { modelRoles, defaultThinkingLevel }` 可写入并被 OMP 读取 | 已证实 | `omp://settings.md` modelPresets；临时目录写入后 `omp config get modelPresets` 原样返回 |
| P2 | `Bun.YAML.stringify(doc)` 无缩进参数输出单行 flow；`(doc, null, 2)` 输出块格式 | 已证实 | 本机 Bun 1.4.4 实测。若默认含换行则不成立 |
| P3 | `discovery.type: openai-models-list` 对 `anthropic-messages` provider 有效，返回 17 个模型及 limits/thinking | 已证实 | 临时目录 + `omp models wb-api --json`：17 条，`1000000/128000`，thinking `["low","high","max"]`；约 11.8s |
| P4 | 显式 `models` 条目覆盖 discovery 的同名字段 | 已证实 | 同上实验：`cn:deepseek-v4.1-flash` 仍返回 `1048576/65536` 与 `text+image`。若发现发现值胜出则本条不成立 |
| P5 | `change()` 只写/只备份受影响的文件 | 已证实 | `config-store.js::change()` 第 84–98 行；测试断言另一文件逐字节不变 |
| P6 | `change()` 第 88 行会让非 `roles` action 的 config.yml 修改不落盘 | 已证实 | 代码：`if (body.action === 'roles') changed[0] = false; else changed[1] = false;` |
| P7 | 全局 `defaultThinkingLevel` 合法值不含 `off`/`inherit`，非法值静默回落 `high` | 已证实 | `omp://settings.md:518`；临时目录实测 `off` → `omp config get` 返回 `high` |
| P8 | `/modelpreset switch` 是整表替换（清空预设未含角色），并切换活动模型 | 已证实（文档） | `omp://models.md:842`。未在 TUI 实跑；若行为不符，决策 4 需重开 |
| P9 | 前端零构建、无第三方依赖；新增静态文件需登记白名单 | 已证实 | `server.js:37`；AGENTS.md |
| P10 | `omp models <provider> --json` 可无 TUI 运行，输出不含密钥 | 已证实 | 实测 exit 0，5.2KB JSON，仅 `{models:[…]}`；临时目录复现 |

## 3. 决策登记表

| 决策 | 选定实现 | 依据 | 推翻条件 | 备选（未采纳原因） |
|---|---|---|---|---|
| 决策 1 范围 | v1 = P0 快改 + 自动发现 + 批量 + 最小预设；P2 = diff/恢复/SSE/回退链 | 先补闭环与正确性，安全网不阻塞使用 | 若预设在真实使用中频率很低，可砍掉 P1-3 只留批量 | 全量做（验收面过大） |
| 决策 2 YAML 写入 | 不引依赖；`stringify(doc, null, 2)` + 末尾换行；接受注释丢失 | 零依赖约定；Bun 无 CST | 用户开始依赖注释/锚点 → 另立决策引入 `yaml` | 引入 `yaml` Document API（新增依赖） |
| 决策 3 模型来源 | 用 OMP 原生 discovery（`openai-models-list`），`omp models --json` 只做展示与验证；显式条目只作覆盖 | 实测一次拿到 17 个模型且元数据正确，OMP 负责缓存与凭据 | 若某 provider 不支持该端点 → 该服务退回手填，不阻断 | 自建 HTTP probe + 静态导入（会再次过期，且要复刻凭据/headers） |
| 决策 4 预设语义 | `preset-apply` 整表替换 `modelRoles` 并写 `defaultThinkingLevel`；不切换活动会话模型；检测项目层并提示 | 对齐 `omp://models.md:842`，避免两套语义 | 若 TUI 实跑证明还有会话级额外状态 → 重开 | 合并语义（用户从 OMP 切回时角色会被清空，预期不一致） |
| 决策 5 批量实现 | 不新增写 action；前端「批量设置」预填所有聊天 Role 输入 + 全局档位，走现有 `roles` 保存 | 最小改动；复用 revision/备份/冲突保护 | 若 roles action 需要处理的大批量字段超出现有结构 → 再抽 action | 新 `bulk` action（必须同时修 P6 的写盘判定） |
| 决策 6 连通性 | 以 `omp models <provider> --json` 成功/失败 + 耗时作为「连接正常/异常」证据；不做付费对话请求 | 复用 OMP 凭据链（含 env 变量、headers、OAuth） | 若该命令对部分 provider 不可用 → 显示「不可测」 | 直连 `/v1/models`（要复刻 apiKey 解析、`!cmd`、headers，风险高） |
| 决策 7 校验边界 | 格式/枚举/名称 → 400；模型存在性 → 只对「自定义 provider 下不存在的 model」告警，不阻断；内置 provider 不校验 | omp-view 无完整模型目录 | 若引入目录缓存，可升级为硬校验 | 保存时调用 `omp models` 校验（每次 ~12s，不可接受） |
| 决策 8 非目标 | 不编辑 modelOverrides、不写项目级配置、不做浏览器自动化、不改启停脚本 | 控制面积 | 用户提出按项目切换 | — |

## 4. 实施计划

### P0 低风险快改（约 3–4 小时）

**P0-1 块格式 YAML + 空备份目录**
- 位置：`config-store.js :: change()` 第 84 行、第 89–90 行。
- 改动：`serialize(doc)` → `Bun.YAML.stringify(doc, null, 2)` 并补尾部 `\n`；备份目录只在确有文件写入时创建。
- 验收：保存后 `config.yml` 多行、末尾有换行；无变更的保存不产生备份目录；`omp config get modelRoles` 正常。

**P0-2 写盘判定显式化**
- 位置：`config-store.js:88`。
- 改动：`const TOUCHES = { provider: [0], delete: [0], roles: [1], 'preset-save': [1], 'preset-apply': [1], 'preset-delete': [1] }`；`changed[i] = changed[i] && TOUCHES[action].includes(i)`；返回 `changedFiles`；无文件变化时返回 `changedFiles: []`，不建备份。
- 验收：新增的 preset action 能实际写入 config.yml（先写测试再实现）；`changedFiles` 与文件 mtime 一致。

**P0-3 角色集合与档位单一来源**
- 新文件 `role-config.js`（纯 ESM，无 Node API）：
  - `CHAT_ROLES`（内置聊天角色 11 个）、`KIND_ROLES = ['image','web','speech','dictation','judge']`、`OPTIONAL_CHAT_ROLES = ['judge']`（覆盖前提示失去原生 Jev）。
  - `SELECTOR_EFFORTS = ['off','minimal','low','medium','high','xhigh','max','auto','inherit']`
  - `SETTING_THINKING_LEVELS = ['minimal','low','medium','high','xhigh','max','auto']`
  - `managedRoles(existingKeys, {includeJudge})`：内置聊天角色 ∪ 现有键 − KIND_ROLES − 显式排除。
- 使用方：`app.js`、`switch-all-to-deepseek.js`、`config-store.js`（服务端校验）。
- 同步更新 `server.js:37` 白名单。
- 验收：三处枚举一致；CLI `--thinking=off` 被拒绝并提示全局档位不支持；`bun test` 新增用例覆盖 `managedRoles`。

**P0-4 角色选择器**
- 位置：`role-selectors.js :: splitSelector()`。
- 规则：
  - `off…max` 保持现状（无歧义）。
  - `inherit` 可直接识别（无模型 id 冲突）。
  - `auto` 仅当 `knownModels` 包含去掉后缀的基础模型时拆分；不传 `knownModels` 时不拆。
- 同步改 `role-selectors.test.js:5`（现有断言保持不变，新增「带 knownModels 才拆 auto」用例）与 AGENTS.md 的冒号规则。
- 验收：`splitSelector('local/cn:auto', [])` 仍为整串；`splitSelector('x/m:auto', ['x/m'])` 拆出 `auto`；`bun test` 全绿。

**P0-5 角色写入门槛与预设引用**
- `config-store.js :: change()` roles 分支：
  - 新增可选 `defaultThinkingLevel`，按 `SETTING_THINKING_LEVELS` 校验；`null` 表示删除该键。
  - warnings：仅当值形如 `customProvider/model`、provider 在 `models.providers`、且 id 不在该 provider 的 models 中时提示；跳过 `@`、`*`、`pi/`、逗号分隔项、内置 provider。
  - `assertUnused` 同时扫描 `modelPresets[*].modelRoles`，错误信息指出「预设 X 仍在用」。
- 验收：`wb-api/不存在` 有 warning 但保存成功；`anthropic/claude-opus-4-5:high` 无 warning；删除被预设引用的模型被拒绝。

**P0-6 修复 CLI 脚本**
- `switch-all-to-deepseek.js`：导入 `role-config.js`；`--thinking` 只接受 7 个全局档位（默认 `low`）；`CHAT_ROLES` 使用共享集合；在 `--exclude` 说明中注明 `judge` 副作用。
- 验收：对临时目录运行结果与 v1 相同（除不再允许 off/inherit）；重复运行幂等。

### P1 工作流（约 1 天）

**P1-1 自动发现**
- `config-store.js` provider 校验：
  - 允许 `data.models` 为空，前提是 `data.discovery?.type === 'openai-models-list'`。
  - 允许模型条目缺省 `contextWindow/maxTokens/reasoning`（由发现提供）；若提供则仍按现有规则校验。
- UI（`app.js :: openProvider/renderModels`）：
  - 新增「自动发现模型（openai-models-list）」复选框；勾选时写 `discovery: { type: 'openai-models-list' }`。
  - 勾选后模型区文案改为「显式覆盖（可选）」，上下文字段可留空；提示「显式条目会覆盖自动发现值，留空即使用发现值」。
  - 保留至少一条显式条目的理由写在帮助文本：需要图片输入或自定义显示名时（发现只报 `text`）。
- 新 API：`POST /api/discover`，body `{ providerId }`。
  - 服务端 `Bun.spawn([process.env.OMP_BIN || 'omp', 'models', providerId, '--json'], { env: { ...process.env, PI_CODING_AGENT_DIR: store.dir } })`；20s 超时后 kill；stdout 上限 5MiB。
  - 解析 `{ models: [...] }`，只回传 `id/name/contextWindow/maxTokens/input/reasoning/thinking`；结果按 provider 缓存 60s。
  - 失败只回 `{ ok:false, reason:'not-found'|'timeout'|'auth'|'unavailable', ms }`，不透传 stderr 原文。
- UI 按钮：「刷新模型 / 验证连接」；成功后只读展示发现结果；保存仍走原有 provider action。
- 验收：
  - 临时目录保存 discovery provider → `omp models wb-api --json` 返回 17 条；`/api/discover` 返回条数一致。
  - 断网/错误 provider 在 20s 内返回错误；响应体不含 `apiKey`。
  - 未勾选 discovery 时行为不变。

**P1-2 批量设置（复用 roles）**
- UI：Role 页新增「批量设置」区：模型输入 + 角色档位（9 值）+ 全局默认档位（7 值）+「同时覆盖 judge」复选框（默认关闭，提示副作用）。
- 点击「填入全部聊天角色」：把当前所有非 kind 角色输入设为 `模型:档位`（含 `judge` 仅当勾选），全局档位选择器同步；用户仍需点「保存 Role 配置」。
- 服务端：沿用 `roles` action，新增 `defaultThinkingLevel`；值非法直接 400。
- 验收：对临时目录保存后，13 个聊天角色为 `wb-api/cn:deepseek-v4.1-flash:low`，`web/tavily` 不变，`defaultThinkingLevel` 为 `low`；与 CLI 脚本输出一致；`off` 被 400 拒绝（全局档位）。

**P1-3 最小预设**
- `snapshot()` 增加 `presets`、`defaultThinkingLevel`、`modelRoleStorage`（只读）。
- 新 action：
  - `preset-save`：`{ name }`，用当前 `modelRoles` 与 `defaultThinkingLevel` 生成整条预设；名称要求非空、≤64、无 `/` `\` 与换行（保留中文）。
  - `preset-apply`：`{ name }`，用预设 `modelRoles` **整表替换**全局 `modelRoles`（清除未含角色），设置 `defaultThinkingLevel`；返回 `added/removed` 列表。
  - `preset-delete`：`{ name }`。
- 复用 `change()` 的 revision 校验、备份与 P0-2 的 TOUCHES。
- UI：Role 页预设条：下拉、应用、另存为当前、删除。应用前弹确认：「将覆盖 X 个角色，清除 Y 个未包含角色」；若 `<cwd>/.omp/config.yml` 存在或 `modelRoleStorage === 'project'`，追加「项目层可能覆盖，结果可能不同」。
- 验收：`omp config get modelPresets` 可见；应用后 `modelRoles` 与预设完全一致（含清空）；未含角色被删除；`bun test` 覆盖保存/应用/删除/非法名/项目层提示。

**P1-4 测试与文档**
- 测试（在现有 9 项上新增约 8–12 项）：
  - config-store：块格式与尾换行、无变更不建备份、TOUCHES 写盘、roles 的 defaultThinkingLevel、preset CRUD/整表替换、assertUnused 扫预设、discovery provider 空 models 允许。
  - role-selectors：auto 命中/未命中、inherit、旧用例不回归。
  - 服务器：`/api/discover` 的解析与错误映射用纯函数测试；真实 `omp` 只做手工验收（避免 12s × N 的不稳定用例）。
- 文档：README/AGENTS 更新版本号、测试数、预设与 discovery 能力、probe 不存在、judge 分类与副作用、与 OMP `/modelpreset switch` 的差异。

### P2 后续（按需）

- 保存前 diff 预览（`dryRun` 返回将要写入的文本）。
- 备份列表 + 一键恢复（realpath 校验、拒绝符号链接、恢复前再备份、解析校验）。
- `fs.watch` + 提示外部修改。
- 按角色 `retry.fallbackChains` 编辑。
- 备份保留策略（如最近 50 份）。
- 浏览器交互验收记录（手工清单）。

## 5. 兼容、失败处理与安全

- 所有写操作沿用「备份 → temp → rename」；新增 action 必须走 `change()` 与 P0-2 的 TOUCHES。
- `/api/discover` 只接受已保存的 `providerId`，不接受任意 URL；走 OMP 凭据链，不执行 `!cmd`，不回传密钥；错误不透传上游 body。
- 批量与预设写入后：`modelRoles` 由 OMP 热加载；`defaultThinkingLevel` 的生效时机按新会话/重启说明（未在官方热加载清单内，标注「建议重启」）。
- 预设应用不切换当前会话活动模型，UI 明示「新会话或手动切换后生效」。
- 预设应用不检查 `default` 模型可用性（OMP 会拒绝而本工具会写入）；UI 在应用前提示这一差异（P2 可接入 `omp models` 校验）。

## 6. 验收

1. `bun test` 全绿（现有 9 + 新增 8–12）。
2. 临时目录全流程：保存 discovery provider → `/api/discover` 返回 17 条 → 批量设置 → 存预设 A/B → 应用 A → 应用 B；每步用 `PI_CODING_AGENT_DIR` + `omp config get` 校验。
3. 真实配置只读验证：`/api/discover` 对 `wb-api` 返回 17 条；不写入真实配置。
4. 手工浏览器验收：自动发现、批量、预设三个流程各记录一次（不引入自动化）。
5. 回归：现有 provider 保存、Role 保存、冲突 409、备份行为不变。

## 7. 已知盲区

| 盲区 | 为何暂不处理 | 代价 | 何时必须回来 |
|---|---|---|---|
| `/modelpreset switch` 未在 TUI 实跑 | 无 CLI 入口；依据 `omp://models.md:842` | 若会话级额外状态与文档不符，应用预设后的表现可能不一致 | 用户报告「应用预设后 OMP 显示不一致」 |
| `defaultThinkingLevel` 热加载时机 | 官方热加载清单未列 | 运行中写入可能对新会话才生效 | 用户要求免重启生效 |
| 显式模型条目覆盖发现值 | OMP 合并规则如此（P4） | 留空才用发现值；UI 必须解释清楚 | 用户报告「元数据还是旧的」 |
| discovery 缓存 TTL 与 12s 首次探测 | 未测缓存失效 | 刷新按钮可能较慢 | 用户觉得刷新不可用 |
| 预设名约束未在 OMP 侧核实 | 只按无路径/无换行限制 | 极端名称可能 OMP 不认 | 用户创建中文/符号名预设失败 |
| 项目级配置与 `modelRoleStorage: project` | v1 只写全局 | 项目内可能被覆盖 | 用户提出按项目切换 |
| YAML 注释丢失 | Bun 无 CST | 手写注释需重加 | 用户开始维护复杂注释 |
| judge 覆盖后失去原生 Jev | 由用户勾选决定 | 原生评判能力下降 | 用户依赖 judge 质量 |
| 浏览器自动化缺失 | 零依赖约定 | 回归靠手工清单 | 前端改动频率升高 |

## 8. 实施顺序

1. P0-1 / P0-2（写入正确性，先写测试）。
2. P0-3 / P0-4 / P0-6（共享枚举与选择器）。
3. P0-5（roles 扩展与告警）。
4. P1-1（自动发现，独立可用）。
5. P1-2（批量，复用 roles）。
6. P1-3（预设，依赖 TOUCHES 与 roles 稳定）。
7. P1-4（测试与文档）。
8. 用户验收后决定 P2。

## 9. 代码锚点

| 位置 | 作用 |
|---|---|
| `config-store.js :: change()` 第 84 行 | YAML 序列化 |
| `config-store.js:88` | action→文件写盘判定（必须改） |
| `config-store.js:89–90` | 备份目录创建（改为按需） |
| `config-store.js :: snapshot()` | 需增加 presets/defaultThinkingLevel/modelRoleStorage |
| `config-store.js :: assertUnused()` | 需扫描 modelPresets |
| `server.js:12` | 路由与安全校验 |
| `server.js:37` | 静态白名单（新增 role-config.js） |
| `role-selectors.js :: splitSelector()` | auto/inherit |
| `app.js :: openProvider()/renderModels()` | discovery 开关与模型区 |
| `app.js :: openRoles()` / `save()` | 批量、预设、全局档位 |
| `switch-all-to-deepseek.js` | CLI 等价物，需共享枚举并收紧档位 |
| 新 `role-config.js` | 角色集合与两套档位枚举的单一来源 |

## 10. v1 评审意见处置

| 来源 | 问题 | 处置 |
|---|---|---|
| TI-1 / OE-1 / ADV-2 | 预设合并语义与 OMP 不等价 | 改为整表替换；删除「等价」表述；补项目层提示 |
| TI-2 | 回滚在核心任务但排 P2 | 核心任务不再承诺恢复；恢复留在 P2，手工复制可用 |
| TI-3 / OE-7 | probe 无法验证未保存连接 | 删除 probe；发现只对已保存 provider 生效，UI 说明 |
| TI-4 / OE-2 / ADV-8 | 凭据/headers 复刻风险 | 改用 `omp models`，复用 OMP 凭据链；不执行 `!cmd` |
| TI-5 / OE-8 / ADV-6 / ADV-7 | 角色告警误报与「模型存在」假承诺 | 仅自定义 provider 下的未知 model id 告警；校验边界写死 |
| TI-6 / OE-5 / ADV-5 | 加 auto 会破坏 `cn:auto` 与旧测试 | auto 仅在 knownModels 命中时拆分；旧断言保留 |
| TI-7 | 「全量重写两个文件」表述错误 | 改为「只写/备份受影响文件」，并新增 P0-2 |
| TI-8 / ADV-1 | 自建 probe 重复 OMP discovery | 删除 probe/静态导入，改用 `openai-models-list` |
| TI-9 / OE-10 / ADV-9 | 预设验收不可判定、项目层 | 验收改为「与预设完全一致」；项目层提示 |
| TI-10 / OE-14 | revision/密钥表述 | action 契约写明 revision；安全表述限定为 probe/discover 不回传密钥 |
| TI-11 | assertUnused 调用点表述 | 改为「删除服务/移除模型时调用；roles 分支只做循环检查」 |
| TI-12 / OE-11 / ADV-12 | 角色清单与 judge 归类漂移 | 新建 `role-config.js` 单一来源；judge 为可选覆盖并提示副作用 |
| TI-13 / ADV-13 | OMP 版本漂移 | 改为 ≥18.18.1 |
| TI-14 / OE-3 | baseUrl 规范化 | 删除 probe，问题消失；discovery 由 OMP 处理 |
| TI-15 / TI-16 / OE-18 | 字段默认/钳制/上下文过时 | 删除静态导入；discovery 由 OMP 提供，显式条目留空继承 |
| TI-17 / OE-12 | probe 验收不确定 | 删除 probe；discover 解析纯函数测试 + 手工真实验收 |
| TI-18 | snapshot 缺 presets | 已加入 P1-3 |
| TI-19 / ADV-10 / OE-16 | 静态白名单改造收益低/泄漏风险 | 删除 P0-3，只登记新文件 |
| TI-20 | 「密钥不出服务端」过宽 | 表述限定为 discover 响应 |
| OE-4 | 失败降级误报 | 删除 probe；`omp models` 失败即失败，不降级 |
| OE-6 / ADV-3 | 两套档位枚举混用 | 拆分 SELECTOR/SETTING 枚举，CLI 同步修 |
| OE-9 | 预设悬空引用 | assertUnused 扫 presets |
| OE-13 | P0 命名与排序 | P0 改为「低风险快改」，按本文件第 8 节排序 |
| OE-15 | defaultThinkingLevel 热加载 | 写入盲区并提示重启 |
| OE-17 / OE-19 / ADV-11 | 恢复路径安全、备份保留、空目录 | P2 恢复条目补充安全要求；P0-1 修空目录；保留策略列入 P2 |
| OE-20 | 文档漂移 | P1-4 明确列出需改的 README/AGENTS 条目 |
| OE-21 | 出站/SSRF | 删除 probe；discover 只按 providerId、固定 omp 命令 |
| ADV-4 | change() 第 88 行静默不写 | 新增 P0-2，显式 TOUCHES |
| ADV-14 | probe 超时 5s | 删除 probe；discover 用 20s |
