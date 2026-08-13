# 大模型AI v1.3.0：AI 接手与维护指南

这份文档写给以后接手本扩展的 AI 或开发者。开始修改前应先完整阅读本文，再阅读当前源码。文档是路线图，当前文件永远是最终事实来源；不要依赖旧对话中的行号或旧版结论。

## 1. 首先理解用户真正要什么

本扩展不是要把大模型伪装成一套绝不会出错的确定性程序，而是要让大模型拥有足够的规则、局面和历史信息，作出接近人的完整决策，同时由游戏引擎负责合法性和安全兜底。

维护时必须遵守这些原则：

1. **模型犯傻可以容忍，扩展结构性错误不能容忍。**
   - 模型选错人、漏选、顺序写反、引用不存在的 ID、给出低水平策略，都属于可容忍的模型操作失败。
   - 扩展漏发合法候选、提示协议自相矛盾、稳定 ID 映射错误、执行失败后没有清干净选择，则属于程序问题，需要修复。
2. **模型计划失效时不要猜。** 撤销本次尚未结算的 UI 选择，交回本体原版 AI。
3. **不要按某张牌或某个技能写特判。** 应按无名杀的事件原语、选择槽位、`filter/select/filterOk` 和实时合法候选实现。所有牌一视同仁。
4. **一次认知上不可分割的选择，应尽量只问模型一次。** 例如同一个事件中的“选牌→选目标”，点牌本身尚未结算，不应再让模型重新思考目标。
5. **技能说明用于理解，游戏引擎用于裁决。** 当前不向 API 发送技能原始 JavaScript 源码；操作协议由提示契约和实时合法候选提供。
6. **小改、小测、可回落。** 不要为了一个问题重写无关模块。
7. **遇到中等或更高复杂度的新要求，先说明工作量、方案和风险，再等用户确认。** 用户可能通过调整要求大幅降低工作量。
8. **修改运行代码前先做可恢复备份。** 备份说明中写明当时问题、准备改什么，以及“模型犯傻可回原 AI、程序问题要修”的总原则。仅新增说明文档时无需重复备份。
9. **前端和实局测试由用户完成。** 维护者负责语法、静态检查、可用的模块测试和清晰交接，不要假称已经看见前端效果。

## 2. 当前版本的准确状态

### 2.1 已实现

- 把本体同步 `ai.basic` 的选择点安全桥接成可等待的大模型决策，同时保留原版 AI。
- 大模型可处理选牌、选目标、选按钮、技能入口和跳过等当前选择。
- 稳定引用优先：牌用 `cardId`，角色用本局 `playerId/targetId`，按钮用 `buttonId`，角色还可用座位号；临时序号只作末级兼容。
- 动态有序多目标：后继目标依赖前一目标时，模型一次返回完整有序目标数组，执行器逐项刷新并实时校验。
- 同一安全事件内的两槽元计划：普通 `card→target`、`button→target` 可一次模型请求完成；后继槽不重复请求。
- 模型把带明确牌引用的 `action:"give"` 等自然“使用”动作写法归一到现有用牌语义，不再因 `give` 无法识别直接失败。
- 当前战局中与观察者相关、有效且可知的技能中文规则会发送给模型，包含实际规则组成关系、动态说明和当前 event/backup 技能入口；原始 JavaScript 源码不进入请求。`sourceSkill` 只是来源标签，`derivation` 只是衍生展示关系，二者不会被当作当前技能展开。
- 结构化 WorldContext：当前局面、事件、已选项、全场玩家、自己手牌、聊天语义、最近战局时间线等使用同一快照。
- 聊天不再靠旧版关键词正则强制行动；聊天模型输出结构化语义，行动模型结合原话、时间线、局面和合法候选决定。
- 被聊天的角色会收到自己的真实身份，并被提醒聊天公开发言可能暴露身份；是否坦白、伪装、试探或保密由模型自主判断。`sanitizeChatReply()` 只做普通文本归一化和空回复兜底，不得恢复按“忠臣/反贼/内奸”等词删句的本地身份审查。其他角色未公开身份仍只作为未知信息处理。
- `currentGameModeContext()` 把 `get.mode()/lib.config.mode`、`_status.mode` 子模式、模式名、身份公开规则以及当前已公开/未公开人数写入 WorldContext。身份、斗地主、国战和公开阵营模式有通用模式级语义；未知或扩展模式不猜规则，只要求以玩家状态行的实际公开身份和 `att` 为准。普通行动、快速行动和聊天回复必须复用这份模式信息。
- 有界战局时间线，可由用户设置保留条数；清空后旧记录不会从本体历史重新复活。
- 每名 AI 按本局角色 ID 隔离的连续行动记忆：只保存已经成功执行的动作、结论理由和可选的后继 `nextIntent`，并作为独立 system 消息传给其后续行动请求；对局结束即清空，不跨局。
- 出牌阶段可返回最长 16 个规范化步骤；当前动作立即执行，剩余步骤进入 `rollingPhasePlans`，跨后续事件按稳定引用、实时合法候选和本体速度软续接。普通结算变化不自动清空，映射失败时只让模型修正剩余部分。
- 技能规则按本次观察者和事件生成紧凑清单，直接给出技能 ID、中文名、中文效果、动态说明和归属；提示中用一次格式说明加数组行表达相同信息，不再维护或发送追加式源码目录。
- 技能发动后的按钮、选牌或目标事件会在能可靠关联当前事件链时读取最近成功技能及其 `nextIntent/reason`，把它当作软行动方针，避免重新论证是否应发动该技能；按钮链在本体未保留来源时允许使用同角色同回合最近技能，牌/目标链则必须有事件来源匹配。候选映射和最终合法性仍由本体实时裁决。
- `Temperature` 与 `Top P` 已加入游戏设置和真实 API payload；普通、聊天和聊天“快点”决策均尊重用户设置，不按决策复杂度自动篡改推理预算或随机度。
- 玩家 `@` 武将后的聊天回复也使用当前服务端推理档位、提示词思考深度、Temperature、Top P 与最大输出设置，不得恢复旧版固定 `low`。
- 可配置 `aiSpeechProbability`；命中时行动响应可携带武将口吻 `speech`。它与行动共用一次 API，只有最终确认成功后才写入聊天记录并显示气泡；实时日志去掉 speech 字段，完整 TXT 保留原始响应。
- 局内日志页只显示耗时、Token/推理 Token、缓存命中率、思考设置、模型最终 JSON 和执行结果；完整 reasoning、候选与上下文仍写入 TXT 决策日志。
- 角色头像上的“AI 思考中 N秒”由 JS 计时更新。连续请求使用 `activeThinkingUIByPlayer` 做所有权隔离，旧请求的延迟收尾不得删除新请求的标签样式；标签自身强制金色、横向 flex 和不换行。
- 旧版 `noAIEffect`、十周年视觉技能 filter 包装以及决策期间的高光隐藏 CSS 已删除。不要恢复：思考标签只能作为附加 UI，不得改变武将、牌、按钮的本体高光和动作特效。加载时仅清理可能由旧版残留的 `llm-ai-deciding/phase/actor/no-fx` 类名。
- 支持原版 AI 概率分流、连续 0-100% 的原版 AI 提示参考程度、角色级/全体原版 AI 接管，以及五个互相独立的事件类别托管开关。参考程度每 1% 等幅变化，不得恢复任何低/中/高阈值；不存在用原版 AI 收益分在回答后否决模型合法决定的功能。
- 决策超时、请求过期、控制权变化、非法结果、执行失败均有原版 AI 回落路径。
- `AI决策日志.txt` 记录完整模型决策链，`log.txt` 记录运行诊断流水。

### 2.2 未来可扩展方向

当前有两层计划：同一根事件的相邻槽位使用可回滚事务；出牌阶段后续独立动作使用跨事件软计划。以后完全可以继续扩展到：

- 对全部 `skill→button/control→cost card→target` 动态形态构建显式动作图；
- `chooseButton.backup` 动态生成规则后的条件步骤；
- 技能 content 内多个子事件组成的可解释长链；
- 发生摸牌、判定、随机、伤害或隐藏信息变化后的条件计划和局部重规划；
- 更完整的战局摘要、长期策略记忆和上下文预算管理。

这些不是“不能做”，也不是现版本故障，而是受本轮时间、Token、回归风险和事务复杂度限制，没有纳入 v1.3.0。任何一项都属于中等或更高复杂度，实施前必须先向用户说明。

## 3. 文件地图

### 3.1 正式扩展目录

| 文件 | 作用 | 维护提示 |
|---|---|---|
| `extension.js` | 主程序：配置、核心补丁、聊天 UI、提示构建、请求、解析、执行、回落、日志和生命周期 | 修改最多；优先按函数名搜索，不依赖本文行号 |
| `game-timeline.cjs` | 战局事件规范化、去重、隐私过滤、裁剪、清空截点、聊天锚点 | 不应泄露未知牌、暗将或私密事件 |
| `skill-source-snapshot.cjs` | 安全发现当前技能与关联闭包，并提供中文规则元数据 | 当前仍用于收集技能集合和诊断，但 `definition/function source` 不加入 API 消息；保留模块便于以后恢复或排错 |
| `config.json` | 分发时的公开默认配置/回退源 | API Key 必须保持为空；完整默认值以 `extension.js` 为准 |
| `info.json` | 扩展元信息与版本 | 发版时同步版本号 |
| `README.txt` | 现有快速安装和历史总说明 | 运行时不会读取；以后可精简成两份新文档的入口，但本轮保留 |
| `用户使用说明.md` | 面向普通用户的完整说明 | 与本文职责不同 |
| `log.txt` | 当前仍在使用的运行诊断日志 | 不是废弃文件；可在游戏关闭时清空，之后会自动重建 |
| `AI决策日志/` | 当前局和按局归档的模型决策日志 | 不要把日志当源码；排错时优先读取最新文件 |
| `wdyd_QQqun.jpg` | 扩展图片资源 | 与本轮逻辑无关 |

### 3.2 会被扩展补丁的本体文件

扩展并非只改自己的目录。安装/启用时会安全检查并可能修改：

- `resources\app\noname\library\element\content.js`
- `resources\app\noname\game\index.js`

旁边会有 `.bak-llm-ai` 备份和 `.llm-ai-meta.json` 哈希元数据。不要手工删除或覆盖这些文件。卸载/关闭时只有在源码、备份和哈希均符合预期的情况下才自动还原，避免覆盖用户或本体后来的修改。

## 4. 启动与核心桥接

`patchCoreForAsyncAI()` 会检查 `content.js` 中预期的选择调用点，并安装 `globalThis.__nonameLLMChoose` 桥。当前版本要求精确的 18 个桥点以及 2 个“AI 代选”回调；不确定或不完整时拒绝盲写本体，并继续使用原版 AI。

`patchLineAnimationCleanup()` 为太虚/十周年 UI 的指示线清理增加安全保护，防止重复 `removeChild`。它不改变正常结算语义。

`restoreCoreOnRemove()`、对应的动画恢复逻辑及 `teardownExtensionRuntime()` 负责生命周期清理。修改补丁时必须保留：

- 原始备份；
- 补丁版本和 SHA-256 元数据；
- 分阶段写入；
- 幂等安装；
- 版本不符时拒绝覆盖；
- 扩展不可用时同步原版 AI 仍可运行。

不要用全局异步重写替代这些精确桥点，也不要直接把本体所有 AI 函数改成异步。

## 5. 一次行动的完整数据流

正常决策大致经过以下链路：

```text
本体 choose* 事件
  → __nonameLLMChoose 桥
  → 检查扩展开关、操作者、托管、事件价值和原版 AI 分流
  → 捕获 live candidates / select range / original AI scores
  → captureWorldContext（同一份世界快照）
  → 捕获当前有效技能集合、中文规则和动态说明
  → buildPrompt 或 buildQuickPrompt
  → callLLM / requestChat（OpenAI-compatible /chat/completions）
  → normalizeActionPlanResponse / parseChoiceDetailed
  → 稳定 ID 映射、数量、顺序与本体实时合法性校验
  → applyChoice 或 pending ActionPlan
  → 每一步 game.check() + live selectable 复核
  → 成功提交；或清理本次选择并交回 ai.basic
```

关键原则：模型输出只是声明式计划，最终合法性永远以当前事件、本体候选和 `game.check()/filterOk` 为准。

## 6. 提示词架构

行动请求的认知信息不是一段随手拼接的文字，而是几个职责层：

1. **稳定行为契约**：角色、思考深度、严格 JSON、禁止捏造 ID，以及 card/skill/button/target 的统一操作协议。
2. **紧凑技能规则层**：当前相关技能的归属、内部 ID、中文名、中文效果、动态说明和 event/backup 入口；不含原始 JavaScript 源码。
3. **本局连续记忆**：该角色最近成功执行的动作、结论理由和可选后继 `nextIntent`。本回合记忆作为优先延续的方针，本局较早记忆保持长期意图；普通出闪、掉血、失牌或进入紧邻技能事件不自动使其失效。
4. **WorldContext**：捕获时刻的主模式/子模式及身份公开规则、回合、阶段、玩家、事件、已选项、公开局面、自己手牌、聊天和时间线。
5. **当前 DecisionSpec**：本步骤合法候选、选择范围、原版 AI 参考、动态有序目标说明、可安全续接的后继目标池。

`captureWorldContext()` 生成快照及指纹。正常和快速提示应复用同一决策 Session 的事实；重试若刷新局面，必须生成新的 revision，不能把旧世界和新候选混用。

JSON 输出格式从来不依赖源码：系统契约明确字段，DecisionSpec 提供稳定 ID 与候选，执行器负责实时合法性。停止发送原始源码后，模型仍按中文规则理解战略，但低难度选择无需反复携带数万 Token 的函数文本。技能规则快照失败或认知模块缺失时，行动请求仍应回原版 AI。

## 7. 技能规则快照（原始源码不发送）

`skill-source-snapshot.cjs` 仍用于确定**当前对局中与观察者相关、有效且可知的技能**及其实际规则组成关系，但 `extension.js` 只抽取中文名、中文效果、动态说明和归属形成 `activeSkillRules/dynamicSkillRules`；模块序列化出的原始 JavaScript 定义不进入 API 请求。

行动观察者通常获得：

- 自己的可用、装备、临时、附加及必要隐藏技能；
- 其他角色对其可见的技能；
- 由上述实际技能定义声明并关联到的全局技能；
- 当前事件动态/backup 技能；
- `group/global/inherit/subSkill` 等会直接组成当前技能规则的已注册关系。

`sourceSkill` 只标明技能来源，`derivation` 只标明衍生展示内容；它们不代表角色当前拥有或正在生效，因此快照不得沿这两个字段展开。比如【源影·改】的 `sourceSkill` 指向【源影】时，只发送当前实际拥有的【源影·改】，不能因此把已经失去的【源影】重新混入当前规则。

不要把整个 `lib.skill.global` 注册表作为根集合。它汇集所有已加载武将包、模式、UI 和内部全局技能，并不等于“本局正在作用的全局技能”。当前实现保持：角色实际技能＋当前事件技能作为根，关系闭包负责补齐所属 `global/group`；然后仅发送这些技能的紧凑中文规则。

公开聊天使用更保守的技能视图，不把当前私密 `event.skill`、对手隐藏技能或其说明塞入上下文。

模块仍必须保持以下安全属性，以便安全收集定义元数据并保留未来可恢复能力：

- `Function.prototype.toString` 只读取文本，绝不执行；
- compiled content 同时保留可用的 `original` 源码；
- 通过属性描述符读取，不触发 getter/setter；
- 不能直接枚举不可信 Proxy；调用方可通过无名杀受信任的 `get.info(name)` / `getGlobalSkills()` 提供定义与全局技能，序列化器只处理返回值；
- 循环引用用稳定 `$ref`；
- 键、技能和所有者稳定排序并生成哈希；
- 任何配额或异常导致的不完整都要写入 diagnostics；
- 即使未来重新启用源码实验，也必须放在 `UNTRUSTED_GAME_SKILL_SOURCE` 边界内，且先经用户确认，因为这会显著增加 Token。

中文规则帮助模型理解“技能做什么”；系统操作契约和实时候选告诉模型“该输出什么、当前能点什么”。闭包捕获值、实时 mod、动态 backup 返回值以及当前真实可点项始终必须由引擎给出。

`compactRuleText()` 必须先解析 `<noname-poptip poptip=...></noname-poptip>`，通过 `lib.poptip.getName/getType` 恢复为 `〖技能名〗` 或 `【卡牌名】`，然后才能删除普通 HTML。不能直接用 `<[^>]+>` 把空组件清掉，否则如 `olsbdinglun_info` 中“获得〖趋袭〗至你下个准备阶段”会变成语义残缺的“获得至你下个准备阶段”，诱发模型长时间循环猜测。这里只展开规则文本已经明确引用的 ID，不额外遍历技能注册表，不改变可见性边界。

### 7.1 紧凑规则层与成本

`battleSkillSourceMessages()` 这个旧函数名暂时保留以减少接线改动，但当前返回的 `stableMessages` 为空；`dynamic` 才是实际发送的技能规则消息。它包含 `owners/globalSkills/currentEventExtraSkills/activeSkillRules/dynamicSkillRules`，不含函数源码与 `sourceHash`。`owners` 使用 `[角色,可见性,技能ID列表]`，`activeSkillRules` 使用 `[技能ID,中文名,中文效果]`，`dynamicSkillRules` 使用 `[角色,当前动态说明]`；这是等信息压缩，禁止为了省 Token 静默删掉中文效果。

日志 `[技能提示体积]` 必须显示 `source_sent_chars=0` 和 `rule_summary_chars=N`。若以后有人重新接回 `skillDefinitionDirectoryMessages`，或把 `serializeSkillDefinition(...).data` 拼进 `relevantRuleText()`，就会重新制造高输入问题；未经用户明确同意不得恢复。

行动消息的第 0 条必须是 `STABLE_ACTION_PROTOCOL_PROMPT`，第 1 条才是模式与思考设置，之后依次为动态技能规则、连续行动记忆和本次 user 局面。普通与聊天“快点”路径都要遵守这一顺序。不要把角色名、时间、哈希、思考档位或候选写进固定协议，否则会破坏公共前缀。

服务商是否命中系统契约等稳定前缀仍由返回的 `cached_tokens` 证明。不要为了提高缓存命中率而恢复巨型源码目录：更高命中率不等于更低的逻辑输入或账单。

## 8. WorldContext 与战局时间线

`game-timeline.cjs` 从本体 global history 中提取有战略意义的事件，如阶段、使用牌、响应、公开技能、伤害、回复、阵亡、判定、展示牌及主要牌移动，并进行去重和更新。

时间线具有这些约束：

- 每条事件有稳定序号、事件 ID、阶段根和行动根关联；
- 角色优先用本局 `playerid`，缺失时使用匿名 `seat-N`，不能以暗将内部名充当公开 ID；
- 未知摸牌/获得手牌只记录数量；公开使用、打出、判定和展示牌才记录牌名；
- 历史上已经知道的事实不会因牌后来移动而“失忆”，原本未知的历史也不会因牌后来公开而被追溯解密；
- 聊天使用玩家发送消息时冻结的时间线锚点，晚到的回复不能混入发送之后的新事件；
- `timelineMaxRecords` 超限后裁掉最旧记录；被裁记录不会在下次同步时重新加入；
- 清空本局记忆会记录 cutoff，旧本体历史不会立即复活。

时间线是有界的战略上下文，不是录像文件，也不保证记录每个内部触发子事件。

### 8.1 本局连续行动记忆

Chat Completions 请求本身无状态；如果扩展不重新提供旧输出，模型并不知道自己上次决定了什么。`memoryData.actionGuidance` 因此按 `playerMemoryKey/playerId` 保存每名 AI 已成功执行的动作、简短 `reason`、原始 `skillName` 和可选 `nextIntent`，每名最多保留 24 条、全局硬上限 200 条；每次只向当前操作者提供本回合最近 3 条和本局较早 2 条。

这层记忆与时间线分工不同：时间线保存客观发生的事实，行动记忆保存“这个 AI 当时准备怎么做、为什么”。只记录成功应用的模型选择，不记录失败、回落或数千 Token 的隐藏推理。它以独立 system 消息放在紧凑技能规则之后，以免无限扩张。公开聊天只读取隐私过滤后的时间线和聊天历史，不直接注入可能包含私有手牌判断的行动理由。

记忆是行动方针，不是硬编码命令。小幅局面变化不自动删除它；执行仍以当前候选和引擎合法性为准。`clearMemory()`、新局、对局结束或卸载都会清空，绝不跨局永久保存。

当当前槽是 `button/card/target` 时，`skillStageContinuationText()` 会尝试关联本回合最近一次成功发动的技能。若事件链保留 `skill/sourceSkill/originSkill`，必须匹配原技能或其 `_backup` 前后缀。标准按钮链有时不保留来源，因此按钮槽可以同角色、同回合最近技能作为软续接；普通牌和目标事件太多，牌/目标槽在没有事件链来源时必须拒绝关联，避免把无关出牌误当技能后继。模型在技能入口可额外输出 `nextIntent`（不要求提前虚构未来 ID）；若 `rollingPhasePlans` 中已有能映射的稳定步骤则可直接消费，否则后继请求优先读取 `nextIntent/reason`，减少重复战略推理。

### 8.2 本回合滚动计划

`normalizeActionPlanResponse()` 最多接收 16 个规范化步骤。首个当前槽及可安全绑定的紧邻 target 留在同事件 `pendingActionPlans`；剩余步骤存入每名玩家一个的 `rollingPhasePlans`。其关键不变量是：

- 只在该玩家仍是 `_status.currentPhase` 且 phase/round 锚点一致时有效；不跨回合、不跨局；
- 后继必须使用稳定 `cardId/skillName/buttonId/targetId/targetSeat`，未来 `indices` 一律拒绝；
- 每次仅消费当前真实事件能承接的前缀，成功确认后才推进 `nextIndex`；
- 续接前 `await game.delayx(0.6)`，因此实际间隔随本体游戏速度缩放；延时后再次核对 event 与计划身份；
- HP、手牌等普通变化不会单凭指纹清空计划；若候选映射或本体实时合法性校验失败，记录 `lastFailure/suspendedEvent`，同一事件改由模型结合剩余方针修正；
- 新模型选择成功后才替换旧计划，不能让一次未执行的修正提前清空可用旧方针；
- 它只撤销尚未提交的 UI 选择，绝不宣称可回滚已经结算的伤害、随机、摸牌或牌移动。

## 9. 聊天与语义指令

旧版“匹配固定关键词就强制做某事”的正则系统和编辑器已经删除。不要恢复这种架构。

当前流程是：

1. 玩家消息在发送时绑定对象、回合/事件锚点和公开世界快照；
2. 聊天模型判断它是否是行动意图；
3. 有效 intent 必须显式给出作用域、受令对象和决策类型；
4. 结构化语义随原话写入局内内存；
5. 当前行动若匹配该语义，行动模型同时看到原话、局面、时间线和候选；
6. 引擎只负责 ID 映射、合法性和回落，不用本地关键词硬删候选。

主要结构字段包括：

- `scope`: `event / turn / game`
- `target`: addressed AI / all / explicit seat
- `decisionTypes`: `play / response / discard / card / target / button / all`
- 响应 subject：如 `wuxie`、`shan`、`tao` 或通用响应

聊天模型失败或意图格式无效时，不应由本地规则擅自扩大成全局强制指令。普通聊天仍可作为最近语境，但不等于机械命令。

身份发言同样遵循“模型理解、引擎不代替思考”的原则：聊天角色知道自己的真实身份，系统只提示公开发言可能泄露阵营，不强制保密，也不在回复生成后按身份词二次删改。此处的自主发言不等于给模型开放其他玩家的隐藏身份或隐藏手牌。

“快点”控制是结构化语义的独立能力：当前事件、当前回合或本局范围可进入约 1.5 秒的快速请求；失败立即原版 AI。它不是普通行动超时设置。

## 10. 模型输出与稳定引用

### 10.1 单步骤兼容协议

常见输出形态：

```json
{"action":"use","cardIds":["牌的稳定ID"],"reason":"..."}
```

```json
{"action":"use","skillName":"技能内部名","reason":"..."}
```

```json
{"action":"target","targetIds":["目标ID1","目标ID2"],"reason":"..."}
```

```json
{"action":"button","buttonIds":["按钮ID"],"reason":"..."}
```

```json
{"action":"skip","reason":"..."}
```

解析优先级大致为：稳定 ID → 当前步骤稳定语义 → 本次 indices → 旧显示文字兼容。模型不应在未来步骤使用 `indices`，因为后继候选尚未生成。

内部行动记忆和滚动计划不得再向模型暴露 `{kind,field,values}` 或 `stableStep` 这种实现格式；传回提示词时必须由 `modelProtocolPlanStep()` 转成上面的正式字段，例如 `{"kind":"target","targetIds":["..."]}`。`cardIds/targetIds/buttonIds` 等复数字段即使只有一项也保持数组；单个技能用 `skillName`。解析器仍保留对旧 `{field,values}` / `stableStep` 的受限兼容，且只接受当前 kind 对应的字段，随后照常映射实时合法候选。这样可修复旧日志里模型照抄内部格式而“无法映射”的问题，同时不降低合法性约束。

### 10.2 ActionPlan 协议

安全的同事件连续选择可返回：

```json
{
  "action": "execute",
  "steps": [
    {"type":"card","cardIds":["card-id"]},
    {"type":"target","targetIds":["player-id"]}
  ],
  "reason": "一次完成选牌与目标"
}
```

或：

```json
{
  "action": "execute",
  "steps": [
    {"type":"button","buttonIds":["button-id"]},
    {"type":"target","targetIds":["player-id"]}
  ],
  "reason": "一次完成按钮与目标"
}
```

当前 v1.3.0 实际接受的多步骤形状为：

- `card→target`：`chooseToUse`、`chooseToRespond`、`chooseCardTarget`；
- `button→target`：`chooseButtonTarget`；
- 必须是同一个 event 对象中相邻的两槽；
- 后继引用必须使用稳定 ID/座位，不能用未来 indices；
- 存在 `event.custom.add.card/button/target` 等自定义选择钩子时不建立事务计划；
- 以技能入口开头的多步骤计划当前不挂 pending plan。
- 同一 target 槽需要多个有序目标时应使用一个 `targetIds`/`targetSeats` 数组；模型若等价地输出多个连续 target 步骤，解析器会先通用合并再执行。
- 选牌提示会根据本体 `selectTarget` 标注“手动目标 / 本体自动目标 / 无目标槽”；本体已自动选中的目标可在后继桥接中直接核验完成，不能再按 selectable 池重复映射。

此外，活动出牌阶段可在同一个 `steps` 数组里继续列后续独立牌/技能及其目标。例如 `酒 → 杀 → target → 下一张牌`。解析器只把当前动作（以及可安全绑定的当前 target）交给当前 event，其余转入上节的滚动软计划；不得把多张独立牌一起塞入一次 UI 事务。

响应可选顶层 `speech`。只有 `world.speechRequested` 为真时提示才允许它，长度清理后最多 100 字符；正常提示要求 1-45 个汉字。`completeChoiceContinuations()` 只在动作确认成功后调用 `emitDecisionSpeech()`，并将其写入聊天内存、聊天页和武将气泡。`liveModelOutputWithoutSpeech()` 仅从实时日志副本移除 `speech/say`，不得改写完整决策日志的 raw。

这是按事件原语限制，不是按常见牌名枚举。杀、过河拆桥、顺手牵羊、决斗、乐不思蜀以及其他牌是否进入这一流程，由本体当前事件结构决定，代码不应维护牌名白名单。

## 11. 动态有序目标

`buildOrderedTargetPlan()` 处理 `complexTarget` 等后继候选依赖前缀的目标事件。它解决的典型结构是：初始只看得到第一个合法角色，选中后第二个角色才出现，但最终范围要求两个目标。

计划会：

- 保存调用前已经选择的目标；
- 区分当前第一步合法目标和后续潜在目标；
- 把 `targetIds` 明确为点击顺序；
- 要求一次返回本次新增的完整有序后缀；
- 每一步重新读取 live selectable targets；
- 最后以 `game.check()/filterOk` 判断能否确认；
- 任一步不一致就恢复基线并交原版 AI。

不要重新退化成“只截取第一次 `get.selectableTargets()` 的静态快照”，也不要为妩艳等具体技能名写特殊分支。

## 12. 事务执行与原版 AI 回落

对当前支持的同事件两槽计划，执行器会快照：

- `ui.selected.cards`
- `ui.selected.targets`
- `ui.selected.buttons`

首槽成功后保存 pending plan。下一个同 event 桥接不会再请求模型，而是：

1. 核对 event、player、phase/round、控制权和下一槽类型；
2. 用当前 live candidates 解析稳定引用；
3. 再做原版 AI 安全参考校验；
4. 逐项点击、逐项 `game.check()`；
5. 终态必须可确认且通过 `filterOk`；
6. 成功后完成一条组合决策日志。

失败时恢复三类选择基线，再让原版 AI 从首槽和当前槽重新完成。这只是**尚未提交的 UI 选择事务回滚**，不等于能够回滚已经发生的摸牌、伤害、随机、判定或游戏状态变更。

`applyChoice()` 的普通目标分支也必须捕获中途异常并清理选择。外层回落之前，原版 AI 应看到干净状态。

## 13. 原版 AI 的角色

原版 AI 不是临时补丁，而是架构中的常驻安全层：

- `originalAIProbability`：普通决策按概率直接走原版 AI，节省时间和 Token；有相关聊天指令时不应随机跳过。
- `originalAIReferenceStrength`：兼容旧配置键名，用户界面称“原版 AI 提示参考程度”。取值 0-100%，提示按 `原版AI建议=X%，完整局面独立判断=100-X%` 连续表达；只能在 0% 处自然关闭参考，不得添加 70/100 等策略分档或隐藏阈值。它绝不参与回答后的收益否决。稳定 ID、数量、顺序与本体实时合法性约束永远存在。
- 五类托管配置键为 `originalAITakeoverPlayPlan/originalAITakeoverTactical/originalAITakeoverResponse/originalAITakeoverResource/originalAITakeoverMechanical`。`classifyOriginalAIEvent()` 必须只按事件结构分类，禁止按具体牌名或技能名写白名单。互斥优先级是 `mechanical → response → resource → play_plan → tactical`。
- `play_plan` 仍以 `event.player` 本人是否正在自己的主动出牌链为准，不能只看全局有没有人在出牌；`activePhaseUseRoot()` 的 `_status.currentPhase === event.player` 守卫必须保留。`responseOrRescueRoot()` 要优先识别无懈、濒死、`chooseToRespond`、respond 类型和非主动 `chooseToUse`，避免别人回合打闪/出桃被归入主动出牌。
- `resource` 处理弃牌、给牌、获得/弃置他人牌和移动整理牌；`mechanical` 只在 forced 且无需真实选择策略时命中，强制弃牌沿用既有快速托管语义。命中开启的类别后所有选择直接由原版 AI，聊天也不能绕过。
- 旧 `originalAITakeoverMode` 与更早的 `aiEnabled/outsidePhaseUseOriginalAI/takeRespond` 只用于迁移：off=五类全关、always=五类全开、inside=仅 play_plan、outside=除 play_plan 外四类开启。不得重新放回菜单。
- 无懈在没有结构化聊天指令时有友方保护快路；有相关语义时交模型权衡。
- 聊天框可把指定 AI 或全部 AI 切回原版接管；真人托管和“AI 代选”始终即时使用本体 AI。

模型结果不可映射时不要消耗格式纠错重试；记清原因后直接回落。HTTP/网络失败可在同一绝对截止时间内重试。

## 14. 配置权威值

完整默认值以 `extension.js` 的 `DEFAULT_CONFIG` 为准：

| 键 | 默认 | 含义 |
|---|---:|---|
| `apiKey` | 空 | 用户自行填写，禁止随包分发 |
| `baseURL` | `https://api.deepseek.com` | OpenAI 兼容 API 根地址 |
| `model` | `deepseek-v4-flash` | 模型名 |
| `timeout` | `20` | 单次行动的绝对总秒数 |
| `temperature` | `0.25` | 请求随机度，游戏菜单可设 0-2 |
| `topP` | `1` | 核采样范围，游戏菜单可设 0.01-1；API 字段为 `top_p` |
| `serverReasoningEffort` | `low` | 服务端推理档位 |
| `promptThinkingDepth` | `50` | 提示词要求的思考深度百分比；设置值填写 1-100，对外统一显示为 1%-100% |
| `actionMaxTokens` | `8192` | 行动最大输出 Token |
| `retryCount` | `2` | 首次之后额外 HTTP/API 重试次数 |
| `decisionLog` | `true` | 决策日志开关 |
| `decisionLogRetention` | `20` | 归档局数 |
| `timelineMaxRecords` | `240` | 时间线最大记录数，0 为关闭 |
| `originalAITakeoverPlayPlan` | `false` | 主动出牌及其连续目标链是否由原版 AI 托管 |
| `originalAITakeoverTactical` | `false` | 其余技能与战术选择是否由原版 AI 托管 |
| `originalAITakeoverResponse` | `true` | 响应、无懈、救援和被要求用牌是否由原版 AI 托管 |
| `originalAITakeoverResource` | `true` | 弃牌、给牌、获得/弃置他人牌和移动牌是否由原版 AI 托管 |
| `originalAITakeoverMechanical` | `true` | 强制弃牌、唯一项和必须全选等机械选择是否由原版 AI 托管 |
| `skillInfo` | `true` | 内部技能资料开关 |
| `memoryPolicy` | `all` | 聊天可见 AI 范围 |
| `originalAIProbability` | `0` | 普通选择原版 AI 概率 |
| `aiSpeechProbability` | `15` | 成功模型行动附带武将拟人发言的命中概率 0-100；不新增 API 请求 |
| `originalAIReferenceStrength` | `50` | 原版 AI 提示参考程度百分比；连续 0-100%，无档位，只影响给模型的信息，不参与执行否决 |
| `skillDescLen` | `600` | 内部技能说明长度上限 |
| `debugUI` | `false` | 调试 UI |

`config.json` 不是完整配置清单，游戏内保存值和 `extension.js` 默认值会覆盖/补充它。公开分发文件必须保持 API Key 为空。

设置页的导入/导出协议是 `schema="noname-llm-ai-config"`、`schemaVersion=1`，正式文件把值放在 `settings` 对象中。`CONFIG_EXPORT_KEYS` 必须由当前配置键减去 `apiKey` 得到；导出不得包含 API Key、聊天、行动记忆、角色托管状态或日志。导入也必须显式忽略 `apiKey` 和未知键，对布尔/数字/字符串做类型校验，再经 `coerceConfig()` 归一化后逐项 `game.saveExtensionConfig()`，最后重载配置并重启游戏。为兼容早期手工文件，可以接受顶层直接为设置对象，但不能接受更高的未知 schema 版本。新增配置键时应自动进入非敏感白名单；若将来新增任何密钥、令牌或凭据，必须像 `apiKey` 一样显式排除，不能仅依赖当前差集。

本懒人包的 `resources/app/main.js` 把 Electron `appData/userData` 指向包内 `resources/app/Home/AppData` 与 `resources/app/Home/UserData`。`game.saveExtensionConfig()` 最终保存到 IndexedDB（无 IndexedDB 时才使用 Local Storage），因此只复制扩展目录不会携带游戏内 Key，但分发整个懒人包必须排除/清理 `Home/UserData`。发布物也不应附带运行日志、决策日志或用户配置数据。

请求地址由 Base URL 规范化后调用 `POST /chat/completions`。不要记录 Authorization、API Key 或完整敏感请求头。

行动、玩家 `@` 武将后的普通聊天和聊天“快点”请求都使用用户设置的 `temperature/topP`。普通聊天还必须使用 `reasoningProfile().thinking/effort`、`promptThinkingDepth` 提示和 `actionMaxTokens`，不得残留固定 `low`。快速模式只关闭服务端推理、缩短提示并使用较短时间，不得擅自把 Temperature 固定为 0；模型输出格式稳定与对局策略随机性是两件事。只有“测试 API 连接”固定 `temperature=0`，因为它不是对局决策。

`promptThinkingDepth` 只是提示词内的软要求，并非服务端硬推理预算。配置仍保存整数 1-100，但发给模型、聊天框状态、完整日志和设置说明统一写成百分数（例如 `5%`）。日志必须同时显示服务端推理档位、提示词深度、最大输出、Temperature、Top P 和实际 `reasoning_tokens`，不要据“深度=5%”就断言服务端一定少思考。用户已明确不要加入“按决策复杂度自动限制推理预算”，维护者不得悄悄恢复该功能。

## 15. 两类日志不要混淆

### `log.txt`

当前仍由 `log()` 主动追加，约有大量运行路径调用。它记录：

- 扩展加载和核心补丁检查；
- 回落原版 AI 的原因；
- API 耗时与 Token usage 摘要；
- 聊天/控制权/生命周期异常；
- 思考标签、输入保护和界面生命周期诊断。

旧内容可能因历史编码显示乱码，但文件并未废弃。游戏关闭时可以清空，运行后会重新生成。

### `AI决策日志.txt`

用于模型行动审计，通常位于 `AI决策日志` 子目录，记录：

- 局面与候选；
- session/world 指纹；
- API 尝试、公开 reasoning 字段；
- 模型最终 JSON 和理由；
- 扩展解析；
- 实际执行、回落或过期结果。

当前局结束后按时间归档，并按 `decisionLogRetention` 清理。它不会伪造服务端没有公开的推理，也不应记录 API Key。

局内聊天框的“日志”页是人类可读的实时摘要，只显示：本次思考设置、耗时、输入/输出/推理 Token、缓存命中率、模型最终 JSON、理由和是否执行/回落。完整候选、公开 reasoning、上下文和错误细节仍只放 TXT。不要把数千 Token 的思考过程重新塞进聊天框。

正常回落必须区分：模型没有最终正文、模型返回无法映射或不符合本体实时合法性、网络失败。这三类分别属于模型输出失败、模型操作失败和网络失败；只要选择清理干净且原版 AI 接管成功，就不是扩展状态残留故障。不得重新加入基于原版 AI 收益分的事后否决。

角色级控制权按钮会主动 abort 该角色正在进行的 fetch。Chromium 有时抛出 `TypeError: The user aborted a request.` 而不是标准 `AbortError`；`requestChat()` 必须结合 `controller.signal.aborted` 标记 `expectedCancellation`，`callLLM()` 不得把它记为网络失败或重试，行动层应写“控制权变化，正常取消”。

排错顺序通常是：最新 AI 决策日志 → `log.txt` → 当前源码 → 本体补丁元数据。

成本排查先看 `log.txt` 中两行：`[技能提示体积]` 应给出 roots/definitions/source_sent_chars=0/rule_summary_chars，`[提示组成]` 给出 system/user 各消息字符数。缓存命中率很高也不代表巨型提示免费；服务商可能仍按缓存输入计费，而且第一次未命中会完整计费。

兼容性细节：若 API 把正文留空、却把一个可完整解析的最终 JSON 放在 `reasoning_content` 末尾，`recoverFinalJSONFromReasoning()` 可以保守恢复；只接受独立 JSON 或推理文本末尾的完整 JSON，不得从中间抓取示例对象。选牌成功记忆也只能在确有后继目标槽时延后，无目标响应、自动完成目标和技能入口应立即结算，避免留下 stale receipt。

## 16. 隐私与信息边界

- 行动模型以当前操作者为观察者：可以看到自己合法知道的手牌和技能，其他角色只看到公开信息。
- 聊天模型不能偷用真人或目标 AI 不该知道的隐藏牌、暗将和私密事件。
- 公开聊天的事件上下文只从经过隐私过滤的时间线渲染；没有公开证据时显示“私密事件细节省略”。
- `useSkill` 只有明确公开时才进入公开时间线，公开渲染仍保守处理技能名。
- 不要把 live GameEvent、Player、Card 或完整 global history 直接 JSON 化发给模型。
- 任何未来“全知 AI”模式都会改变游戏信息规则，必须作为单独显式选项讨论，不能悄悄加入默认行为。

## 17. 当前测试证据

截至本文快照，已完成：

- `node --check extension.js`
- `node --check game-timeline.cjs`
- `node --check skill-source-snapshot.cjs`
- 时间线隔离测试：`game-timeline: 10 groups passed`
- 技能快照模块隔离测试：10 类通过，包括函数源码、compiled original、循环、getter 零执行、Proxy trap 零执行、观察者可见性、关联闭包、稳定排序/哈希、配额显式失败和不可信边界；这些证明模块本身安全，不表示当前会把源码发给 API。
- 集成层 Proxy 注册表回归：不直接枚举 Proxy，通过 `getSkillDefinition` 精确读取目标技能，快照 `available=true` 且无 diagnostics。
- 原版 AI 的收益评分只能作为提示输入，任何维护者都不得用它在模型回答后拒绝、替换或改写一个符合游戏规则的选择。

测试脚本位于当时的 Codex 工作区，不随正式扩展分发，因此新接手者若没有该工作区，应按当前模块接口重建小型 fixture，不能声称运行了不存在的测试。

## 18. 每次改版建议的回归矩阵

以后修改相关功能后，建议按下列矩阵收集证据：

1. API 连接成功，扩展加载日志显示 18/18 桥接完整。
2. 设置导出 JSON 不含 `apiKey`、聊天、行动记忆和日志；导入恶意附带的 `apiKey`、未知键、错误类型与更高 schema 版本时分别忽略或拒绝，合法数值经 `coerceConfig` 限幅。
3. 普通实体牌带目标：只出现一次模型行动决策，牌和目标均正确应用。
4. `chooseCardTarget`/`chooseButtonTarget`：同事件后继槽不再重复 API。
5. 动态有序双目标：返回完整顺序后逐项成功；缺第二项时干净回落原版 AI。
6. 模型返回 `action:give` 加明确 `cardIds`：能归一或安全回落，不出现未知 action 的结构性错误。
7. 聊天说自然话，例如“这回合别打我”或“这次别闪”：语义作用域正确，不靠固定口令。
8. 跨回合询问“你刚才为什么拆我”：聊天能关联时间线，不泄露未知牌。
9. 故意返回不存在 ID、非法顺序或过少目标：界面无残留选中，原版 AI 能继续。
10. 两槽之间切换相应类别的原版 AI 托管：旧 pending plan 被撤销，不继续操作。
11. `gainPlayerCard/discardPlayerCard/choosePlayerCard`：本体 `blank/infohidden` 按钮只能输出匿名按钮 ID 与“暗置牌”；不得从 `button.link`、技能规则收集、语义别名、日志或原版 AI 逐项评分泄露真实牌面。公开装备、判定牌、展示牌仍应显示。
12. 分别切换五个 `originalAITakeover*` 类别开关，覆盖主动出牌、响应/无懈/救援、资源整理、强制唯一项和普通技能事件；等待中的请求与 pending plan 不得越过新边界。
13. 太虚幻境完成一局：指示线清理不报错、不影响正常结算。
14. 对局结束、关闭扩展、清空记忆：请求、pending plan、时间线、聊天和日志生命周期正常。
15. 同一角色连续两次请求紧邻开始：旧 `finishAIDecisionUI` 不得删除新请求的 `llm-ai-thinking`；标签保持金色、单行，三个点不能换行。
16. 模型返回“当前牌→目标→后续牌→目标”：首动作完成后按 `game.delayx` 间隔续接；可映射步骤不再请求 API，非法步骤只修正剩余计划，不误点。
17. 把主动发言概率设为 100：成功模型行动只出现一次武将气泡/聊天记录，实时日志不重复显示 speech，完整 TXT 保留；失败或回落不发言。设为 0 时提示禁止 speech。
18. `@` 某武将聊天：请求中的推理档位、思考深度、Temperature、Top P 和最大输出均与设置一致，不再固定 low。

每次失败请保存：最新 `AI决策日志.txt`、`log.txt` 尾部、当时技能/牌/人物、是否有聊天指令、是否开启原版 AI 分流。不要只根据截图猜根因。

## 19. 常见症状与查找入口

| 症状 | 优先搜索/检查 |
|---|---|
| 扩展完全不接管 | `patchCoreForAsyncAI`、桥接元数据、18/18 日志、模块 readiness gate |
| 结果无法映射 | `candidateCardId/TargetId/ButtonId`、`parseChoiceDetailed`、候选日志 |
| 动态目标只看见第一人 | `buildOrderedTargetPlan`、提示中的有序完整后缀、live target 刷新 |
| 点牌后又请求一次目标 | `normalizeActionPlanResponse`、事件名门控、pending plan 建立/消费 |
| 装备技能触发后重新长篇思考 | `memoryData.actionGuidance`、`rememberSuccessfulModelDecision`、`actionMemorySystemMessage`、角色 ID/回合锚点 |
| 失败后界面仍选中 | 事务 baseline、`applyChoice` 异常路径、pending 回落 |
| 聊天命令不生效 | intent JSON、`normalizeSemanticIntent`、scope/target/decisionTypes、directive signature |
| 聊天泄露隐藏信息 | public WorldContext、timeline viewer、public skill source、event public rendering |
| 旧时间线复活/乱序 | maxRecords 裁剪、trimmed IDs、clear cutoff、globalHistory 实例变化 |
| 技能理解仍不对 | `activeSkillRules/dynamicSkillRules` 是否含中文名、中文效果和当前动态说明，extra event skill、关联闭包、运行时候选是否完整；不要以此为由直接恢复原始源码 |
| 技能说明出现“获得至……”等断句 | `compactRuleText` 是否先恢复 `noname-poptip` 引用；检查原说明中的关联技能/卡牌名是否被普通 HTML 清理误删 |
| 技能后按钮/选牌/目标仍从头长篇推理 | `nextIntent`、保存的原始 `skillName`、`skillStageContinuationText`、当前事件链 sourceSkill；不要放宽牌/目标槽的来源匹配 |
| 缓存命中低 | 先看系统契约和其他稳定消息是否变化、服务端 `cached_tokens`；不要为了缓存命中率恢复巨型技能源码目录 |
| “AI 思考中”突然变白/三个点换行 | `activeThinkingUIByPlayer` 所有权、旧状态延迟收尾、标签 CSS 是否仍直接匹配 `.player>.llm-ai-thinking-label` |
| 日志乱码 | `log.txt` 的历史编码；先看新追加内容和 UTF-8 决策日志，不要误判文件已废弃 |

## 20. 修改流程

1. 先复现或只读定位，不急着改。
2. 判断属于模型愚蠢、提示/数据缺失、映射问题、执行事务问题，还是本体兼容问题。
3. 若工作量达到中等：向用户说明“为什么复杂、最小方案、完整方案、风险”，等待用户选择。
4. 修改运行代码前，在扩展同级备份目录创建带时间和目的的 ZIP，并放入问题/要求说明。
5. 用最小补丁修改；保留用户已有改动，不做无关格式化或重写。
6. 至少运行三文件语法检查；修改模块时运行对应 fixture。
7. 复核失败路径：事件过期、控制权变化、非法 ID、少选、顺序错误、`game.check` 异常。
8. 前端验证由用户执行；维护者只能如实报告自己实际完成的自动检查，不能虚构前端结果。
9. 同步 `info.json`、扩展头部版本、README/两份说明，仅在确实发版时改版本。
10. 最后报告改了哪些文件、是否触碰本体、备份位置、自动检查结果和可能受影响的回归范围。

## 21. 接手时的最短检查清单

- [ ] 我读完了本文和最新用户使用说明。
- [ ] 我确认正式工作路径是 D 盘游戏目录，而不是旧工作区副本。
- [ ] 我读的是当前 `extension.js`，没有照搬旧行号。
- [ ] 我分清了模型犯傻与扩展程序错误。
- [ ] 我没有按牌名/技能名搞特殊。
- [ ] 如果是中等复杂度，我已经先告诉用户。
- [ ] 修改运行代码前已经备份并写说明。
- [ ] 我没有泄露 API Key、隐藏牌、暗将或私密技能。
- [ ] 我保留了实时合法性校验和原版 AI 回落。
- [ ] 我不会把静态检查说成前端已验证。

---

本扩展的核心不是“让模型永远正确”，而是：**给模型足够的规则、局面、历史和完整操作语义；让它一次作出合理计划；再由无名杀本体逐步验证，失败时干净地交回原版 AI。**
