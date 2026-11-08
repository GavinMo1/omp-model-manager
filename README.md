# OMP 模型管理器

给 oh-my-pi（OMP）使用的中文本地配置界面。在浏览器里管理自定义模型服务和 Role，保存后直接写入 OMP 原生 YAML 文件。

程序目录：`D:\Desktop\omp-view`。仅监听本机 `127.0.0.1`，界面资源全部本地加载，无需云端部署。

## 功能

- 添加、编辑、删除自定义模型服务，配置地址、密钥、模型 ID、上下文、最大输出及推理/图片能力。
- 可选「自动发现模型」：只写 OMP 原生 `discovery` 配置，模型目录由 OMP 在加载时获取；显式条目仅覆盖填写的字段。
- 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses。
- 粘贴 Claude Code env JSON 导入，也支持 OpenAI 环境配置及单个服务 JSON。导入先填表，点击保存才写文件。
- 配置全部 16 个内置 Role，新增自定义 Role，设置显示名称、模型及推理档位。
- 批量把全部聊天角色填成同一个「模型:档位」，judge 可单独选择是否覆盖。
- 角色预设：把当前 Role 组合存为预设，一键整表切回；应用前显示覆盖/清除数量。
- 常用角色一键跟随默认模型，防止角色循环引用。
- 保存前自动备份（仅在实际有改动时），检测外部修改冲突，保留已有高级字段。
- 阻止删除仍被当前 Role 或预设引用的服务或模型。

## 技术栈与环境

| 部分 | 技术 |
| --- | --- |
| 后端 | Bun + JavaScript，Bun.serve |
| 配置 | Bun 内置 YAML、Node.js 文件 API |
| 前端 | 原生 HTML、CSS、JavaScript ES Modules |
| 测试 | Bun Test |
| Windows 启停 | PowerShell |

已在 Windows、Bun 1.4.4、OMP 18.18.1 上验证。建议 Bun 1.4.4 或更新版本。没有第三方运行依赖，无需 npm install 或 bun install。

## 启动与停止

前台启动：

```powershell
cd D:\Desktop\omp-view
bun run start
```

访问 <http://127.0.0.1:18764/>，Role 页面是 <http://127.0.0.1:18764/#roles>。前台进程按 Ctrl+C 停止。

后台启动并打开浏览器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Desktop\omp-view\launch.ps1
```

本机桌面「OMP 模型管理器」快捷方式已指向该脚本。重复打开会复用默认端口上的服务。关闭浏览器不会停止后台进程。启动脚本按端口是否监听判断服务已启动，不校验监听者身份；如果 18764 被其他程序占用，应先确认占用来源，或手动指定其他端口运行。

## 停止后台服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Desktop\omp-view\stop.ps1
```

停止脚本只匹配从当前项目目录运行的管理器，不会结束 OMP 或其他 Bun 程序。

## 一键切换全部聊天 Role

不想开界面时，可用一次性脚本把所有聊天 Role 统一到某个模型与思考档位：

```powershell
cd D:\Desktop\omp-view
bun run switch-deepseek                    # 直接写入全局 config.yml
bun run switch-deepseek -- --dry-run       # 只预览，不写文件
bun run switch-deepseek -- --thinking=low --model=wb-api/cn:deepseek-v4.1-flash
bun run switch-deepseek -- --thinking=off  # 只写角色后缀，不改全局档位
bun run switch-deepseek -- --include-judge
bun run switch-deepseek -- --exclude=designer
```

- 默认自动挑选 `models.yml` 中唯一的 DeepSeek 模型，档位默认 `low`，并在档位属于 7 个全局合法值时写入 `defaultThinkingLevel`。
- 覆盖 `default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`memory`、`task`、`advisor`、`widget` 及已有的自定义聊天 Role（如 `designer`）。
- `web`、`image`、`speech`、`dictation` 属于非聊天角色，保持原值；`judge` 默认也不改动，加 `--include-judge` 时只写模型、不带档位。
- 使用自动发现的服务可以传 `--model=服务/模型`，脚本按原文接受，不会剥掉看起来像档位的后缀。
- 写入前备份到 `model-manager-backups/<时间>-switch-deepseek/config.yml`，可重复运行（已是目标值时不动文件）。
- 脚本只改全局配置；项目级 `.omp/config.yml`、`modelPresets`、`task.agentModelOverrides` 若有内容会提示但不改动。

## 配置文件与生效方式

程序与用户配置分开存放，迁移源码不会移动 OMP 配置。

| 位置 | 内容 |
| --- | --- |
| `%USERPROFILE%\.omp\agent\models.yml` | 自定义服务、密钥和模型参数 |
| `%USERPROFILE%\.omp\agent\config.yml` | modelRoles、角色显示名称 modelTags、全局思考档位、可选的 modelPresets |
| `%USERPROFILE%\.omp\agent\model-manager-backups\` | 保存前的原文件备份，按时间分目录 |

保存后新启动的 OMP 读取最新配置。已有会话建议重启；本程序不会切换正在运行的会话。项目配置、环境变量、启动参数或配置覆盖层可能优先于全局设置。

默认管理全局配置，不自动发现或编辑 --profile 隔离配置。可用环境变量指定其他配置目录，见下文。

## 使用步骤

1. 左侧点击「＋」添加服务，或点击「粘贴配置导入」。
2. 填写协议、地址、密钥和模型 ID，检查上下文和输出上限，保存。也可以勾选「自动发现模型」并留空模型列表，由 OMP 在加载时获取目录。
3. 打开「Role 配置」，为 default 选择模型，其他角色按需设置或跟随默认模型；可用「批量设置聊天角色」一次填完。
4. 需要多套组合时，用预设条的「另存为当前」保存，之后选择预设并「应用」即可整表切回。
5. 保存 Role 配置，重新启动 OMP。

Anthropic 通常填写服务根地址，例如 http://127.0.0.1:7864；OpenAI 兼容地址通常包含 /v1。Bearer 认证是否开启以服务要求为准。

上下文 131072、输出 8192 是表单初值，请按实际能力修改。密钥默认隐藏，底层仍保存在本机 YAML 中。程序不主动发送模型连通性请求，也不获取真实计费信息。

## Role 机制

Role 是模型的用途或快捷名称。

| 类别 | Role |
| --- | --- |
| 对话与任务 | default、smol、slow、vision、plan、commit、tiny、memory、task、advisor、widget |
| 专用能力 | image、web、speech、dictation、judge |

可以新增 reviewer 等自定义角色，保存后通过 `omp --model @reviewer` 选择。

「常用角色跟随默认模型」将 smol、slow、plan、commit、tiny、memory、task、advisor、widget 设置为 @default。以后切换 default，它们也随之变化。视觉和专用能力角色需按实际能力单独配置。

「批量设置聊天角色」会填入所有非专用能力角色（包括自定义聊天角色），可同时勾选 judge；judge 只写模型，不带档位，以免改变评判行为。

角色模型留空会清除本机全局分配。推理档位单独展示，保存时生成「服务/模型:档位」，例如 `local-anthropic/cn:auto:high`。模型 ID cn:auto 会保留完整；可用推理档位取决于模型服务。引用其他角色时继承被引用角色的档位。

## 模型自动发现

服务页勾选「自动发现模型（openai-models-list）」后，本程序只写：

```yaml
discovery:
  type: openai-models-list
```

真正拉取模型列表的是 OMP 自身；页面不发起探测，也不展示发现结果。显式模型条目只覆盖填写的字段，上下文字段留空即继承 OMP 发现值。手写的其他 discovery 类型（ollama、proxy 等）在页面中只读，保存时原样保留。

`omp models` 在密钥错误、端口不可达时仍可能返回 0 或旧缓存，因此本程序不提供「验证连接」。

## 角色预设

预设保存当前全局 `modelRoles` 与合法的 `defaultThinkingLevel`。应用预设会整表替换全局 Role，未包含的角色会被清除，并按新角色集合裁剪 `modelTags`、`cycleOrder`；不会切换正在运行的会话模型。只写全局配置，`modelRoleStorage: project` 时页面会显示警告。

本程序保存的是全局层，OMP 自身可能保存 effective assignments，两者可能存在差异。

## 备份与恢复

有实际改动时，保存会在备份目录创建时间子目录，仅备份本次涉及的原文件；没有改动不会新建备份。

1. 停止编辑，找到所需时间的备份。
2. 将备份中的 models.yml 或 config.yml 复制回 `%USERPROFILE%\.omp\agent\`，覆盖对应文件。
3. 重新加载管理器并重新启动 OMP。

备份可能包含密钥，请与原始配置一样妥善保存，不要提交到 Git。

## 开发与测试

```powershell
cd D:\Desktop\omp-view
bun run test
```

目前 24 项测试，覆盖块格式与尾换行、无改动不建备份、显式写盘目标、Role 增删和循环引用、全局思考档位、预设保存/应用/删除与引用隔离、逗号列表及预设引用保护、自动发现往返、显式字段覆盖、空密钥与数值校验、带冒号模型 ID、HTTP 读写和来源验证。测试使用临时目录，不修改真实 OMP 配置；HTTP 测试短暂使用 18765 端口，并在结束后停止测试进程。

| 文件 | 职责 |
| --- | --- |
| server.js | 本地 HTTP、静态资源、API 验证 |
| config-store.js | 配置校验、备份、写入、冲突保护 |
| index.html / app.js | 页面、服务导入及 Role 编辑 |
| switch-all-to-deepseek.js | 一次性脚本：全部聊天 Role 与思考档位切到 DeepSeek |
| style.css / roles.css | 样式 |
| role-selectors.js | 模型 ID 与推理档位拆分、组合 |
| *.test.js | 自动化测试 |
| launch.ps1 / stop.ps1 | Windows 后台启停 |

可选环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| OMP_MANAGER_CONFIG_DIR | `%USERPROFILE%\.omp\agent` | 配置目录 |
| OMP_MANAGER_PORT | 18764 | HTTP 端口 |

```powershell
$env:OMP_MANAGER_CONFIG_DIR = 'D:\omp-test-config'
$env:OMP_MANAGER_PORT = '18766'
bun run server.js
```

自定义端口需手动访问对应地址，launch.ps1 固定使用默认端口。

## 当前限制

- 保存涉及的 YAML 文件时会重新格式化为 2 空格块格式，原注释不保留。
- 内置提供商的高级参数覆盖仅展示，不提供表单编辑。
- 模型建议来自自定义服务和现有 Role，不展示自动发现的完整目录；可直接输入模型 ID。
- Role 下拉档位只提供 off…max，不支持显式设置 auto/inherit；手写这些后缀打开后保存仍会保留原值，但页面无法单独编辑。
- 不提供完整 OMP 设置管理、agent 提示词编辑或运行中会话热切换。
- 删除引用保护检查全局 modelRoles 与 modelPresets；不检查项目配置或外部覆盖层。
- Role 页面不编辑 cycleOrder、角色颜色、隐藏状态；已有高级设置会保留，应用预设会裁剪悬空项。
- 只知道 7 个全局思考档位；非法值由 OMP 自行处理，页面显示「保持当前」。
- 自动化验证覆盖配置层和 HTTP API，并完成主要浏览器交互验收；尚无持续浏览器回归测试。

Git 忽略运行日志、环境文件、临时文件和备份。仓库只保存程序源码，真实模型密钥不应写入项目文件。
