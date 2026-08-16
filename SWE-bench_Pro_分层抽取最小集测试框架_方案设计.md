# SWE-bench Pro 分层抽取最小集快速评测框架

## 详细方案设计文档

目标：以尽可能低的 API 成本，快速判断同一模型在不同推理提供商上的真实 Code Agent 能力是否存在系统性差异

| **项目**   | **内容**                                            |
|------------|-----------------------------------------------------|
| 文档版本   | v1.0                                                |
| 日期       | 2026-08-16                                          |
| 适用基准   | SWE-bench Pro Public Set                            |
| 推荐用途   | 同模型跨 Provider A/B；模型版本回归；推理栈变更回归 |
| 核心最小集 | Smoke-6 → Core-12 → Confirm-24（按需扩展）          |

> **一句话结论**
>
> 推荐采用“分层 Core-12 + 分歧任务定向复测”的自适应方案。第一轮只跑 6 题做烟雾验证；若无明显差异扩展到 12 题；只对两端结果不一致的任务重复 2 次。该方案的目标不是复刻官方排行榜，而是以最小成本发现 Provider 级别的系统性能力回退。

# 目录

- 1\. 背景与设计依据
- 2\. 目标、非目标与适用边界

- 3\. 评测对象与威胁模型
- 4\. 总体架构

- 5\. 数据冻结与质量门禁
- 6\. 分层抽样模型

- 7\. 难度评分与信息增益
- 8\. 最小集定义：Smoke-6 / Core-12 / Confirm-24

- 9\. 抽样算法与候选池构建
- 10\. 执行环境与公平性控制

- 11\. 指标体系与统计判定
- 12\. 自适应复测与停止规则

- 13\. 成本控制模型
- 14\. 报告与产物规范

- 15\. 示例候选任务
- 16\. 实施步骤

- 17\. 风险、局限与后续演进
- 附录A. 运行清单 Schema

- 附录B. 推荐配置模板
- 参考资料

# 1. 背景与设计依据

**SWE-bench Pro** 面向长时程、真实软件工程任务：给定完整代码库与问题描述，由 Agent 生成补丁并通过任务相关测试与回归测试。公开集当前包含 731 个实例，来自 11 个开源仓库；参考解平均修改约 107.4 行、4.1 个文件。官方评测使用可复现的 Docker 环境，并以 Resolve Rate 作为主要指标。

- 公开数据字段包含 repo、instance_id、base_commit、gold patch、test patch、problem_statement、requirements、interface、repo_language、fail_to_pass、pass_to_pass、selected_test_files_to_run、dockerhub_tag 等。
- 官方论文显示：随着修改文件数、修改代码量增加，模型通过率明显下降；跨 3 个以上文件后，不同能力层级模型之间的差距更加明显。

- 官方复现实验采用 SWE-Agent scaffold、统一 prompt、最多 50 turns；因此“Agent 框架”和“模型/Provider”必须被严格解耦。

> **设计含义**
>
> 最小集不能简单随机抽 6～12 题。随机抽样很容易被仓库偏置、任务类型偏置和难度偏置淹没。必须分层，并优先选择“区分度高”的中等/中高难度任务，同时保留少量简单与极难锚点。

# 2. 目标、非目标与适用边界

## 2.1 目标

- 用最小 API 花费快速发现：同一模型在两个 Provider 上是否存在稳定的 Code Agent 能力差异。
- 区分“随机采样差异”与“系统性 Provider 回退”，特别关注推理精度、上下文处理、tool calling、reasoning budget、截断等因素。

- 形成可版本化、可重复、可增量扩展的小型 SWE-bench Pro 子集，适合作为日常回归测试。
- 将成本、速度、成功率统一到“每解决一个真实软件工程任务的成本（Cost per Solved Task）”上。

## 2.2 非目标

- 不用于替代 SWE-bench Pro 官方 731 题排行榜分数；Core-12 的统计置信度不足以声称“模型总体能力提升/下降 X%”。
- 不用于比较完全不同的 Agent scaffold；本框架要求 scaffold、prompt、工具、环境、turn limit 全部固定。

- 不以 gold patch 相似度作为得分；最终只以测试是否满足 fail-to-pass 且不破坏 pass-to-pass 为核心判定。

# 3. 评测对象与威胁模型

| **潜在差异来源**                | **可能表现**                             | **本框架如何捕获**                                |
|---------------------------------|------------------------------------------|---------------------------------------------------|
| 权重/二次量化/数值精度          | 复杂任务成功率下降、边界 case 增多       | 中高难度跨文件任务 + 稳定复测                     |
| reasoning budget / 输出截断     | 长任务中途停止、未完成测试循环           | 记录 finish_reason、输出长度、turn 数、未提交比例 |
| tool calling / chat template    | 工具格式错误、错误文件修改、循环读取     | 记录 tool errors、轨迹末 20 turns、失败分类       |
| 上下文窗口/缓存实现             | 长上下文丢失、重复读取、context overflow | 长仓库任务 + context/usage 监控                   |
| sampling / server-side 默认参数 | 同题随机性明显不同                       | 显式锁定参数；分歧任务重复 3 次                   |
| 速度/排队/限流                  | 能力相同但实际效率不同                   | 单独记录 TTFT、decode tok/s、wall time、429/5xx   |

# 4. 总体架构

```text
SWE-bench Pro Public (冻结 revision)
│
├─ 质量门禁：环境可复现 / gold patch 可过 / 无已知坏例 / 防 git 泄漏
│
├─ 元数据解析：repo / language / category / files / LOC / tests / spec
│
├─ 难度评分：结构难度 + 可选的历史经验难度
│
├─ 分层抽样器
│ ├─ Smoke-6
│ ├─ Core-12
│ └─ Confirm-24
│
├─ A/B Runner（同 scaffold，仅切换 Provider）
│ ├─ Provider A
│ └─ Provider B
│
├─ 官方 evaluator：fail-to-pass + pass-to-pass
│
└─ Analyzer：成对分歧 / 稳定复测 / 成本 / 速度 / 失败模式
```

> **核心原则**
>
> “抽样器”和“执行器”分离。抽样阶段可以读取 gold patch 计算难度，但 gold patch、test patch 和隐藏测试不得进入 Agent 提示词或工作目录可见区域。

# 5. 数据冻结与质量门禁

## 5.1 版本冻结

- 记录 Hugging Face dataset revision/commit SHA；不得使用不带 revision 的“latest”作为长期可比较基线。
- 记录 SWE-bench_Pro-os evaluator commit SHA、SWE-Agent/mini-SWE-Agent commit SHA、Docker image tag 与镜像 digest。

- 每次修改最小集之前生成 suite_version，例如 sbp-mini-2026.08-r1。

## 5.2 质量门禁（必须全部通过）

| **Gate**     | **检查**                                                            | **失败动作**       |
|--------------|---------------------------------------------------------------------|--------------------|
| G1 环境      | 容器启动、依赖与测试命令可执行                                      | 剔除/修复镜像      |
| G2 Gold 可解 | 应用 gold patch 后 fail-to-pass 与 pass-to-pass 均满足              | 立即剔除           |
| G3 Base 确认 | 未应用 patch 时至少一个 fail-to-pass 真实失败                       | 立即剔除           |
| G4 稳定性    | gold 测试重复 2～3 次无 flaky                                       | 剔除或进入观察名单 |
| G5 泄漏防护  | Agent 无法通过未来 git history / remote /隐藏文件读取 gold solution | 重建 sandbox       |
| G6 已知坏例  | 不在官方 issue/内部 denylist 中                                     | 剔除，等待修复     |
| G7 资源可控  | 单题安装/测试时长在预算上限内                                       | 换同层候选题       |

**特别建议：**对 Provider A/B 比较，优先使用“代码快照 + 新初始化 git 仓库”的方式，而不是保留完整未来历史。官方仓库 2026 年已有关于 future git history mining 的 reward-hacking 报告；最小集若长期使用，更应避免答案泄漏。

# 6. 分层抽样模型

最小集采用四个主维度分层，另设两个约束维度。

| **维度**         | **分层建议**                                     | **作用**                           |
|------------------|--------------------------------------------------|------------------------------------|
| 难度             | Easy / Medium / Hard                             | 确保有基础锚点、主要区分区、压力区 |
| 任务类型         | Bug / Feature / Refactor / Infra-Security-Perf   | 覆盖日常软件工程任务形态           |
| 语言             | Python / Go / JavaScript / TypeScript            | 减少语言偏置                       |
| 仓库             | Core-12 每仓最多 2 题                            | 减少 repository-specific bias      |
| 修改规模（约束） | 1–2 / 3–5 / 6+ 文件；中/高 LOC                   | 显式覆盖多文件长时程任务           |
| 知识域（约束）   | backend / web / full-stack / infra / security 等 | 避免只测单一技术栈                 |

> **为什么中等难度占比最高**
>
> 同模型跨 Provider A/B 最需要“可区分但不是必输”的任务。过简单时两边都会 PASS；过难时两边都会 FAIL。通过概率接近 30%～70% 的任务对发现 Provider 回退最有信息量。

# 7. 难度评分与信息增益

## 7.1 结构难度分数 D_struct

建议从 gold patch 和任务元数据计算结构难度，仅用于离线选题：

F = clamp(log2(1 + files_changed) / log2(11), 0, 1)  
L = clamp(log10(1 + changed_LOC) / log10(501), 0, 1)  
T = clamp(log2(1 + fail_to_pass_count) / log2(33), 0, 1)  
S = normalized(spec_length + interface_length)  
  
D_struct = 0.40\*F + 0.35\*L + 0.15\*T + 0.10\*S

**权重理由：**官方分析明确显示文件数与代码改动规模与通过率高度相关，因此 files_changed 与 LOC 是主特征；测试数与规格长度作为次级代理。阈值应基于当前 731 题的分位数重新拟合，而不是永久写死。

## 7.2 经验难度 D_emp（可选但推荐）

若可获得官方/公开轨迹的逐题结果，则计算代表性模型面板的历史通过率 p_hist：

D_emp = 1 - p_hist  
D_total = 0.6\*D_emp + 0.4\*D_struct

- Easy：D_total 位于低分位，且至少有多个参考模型能稳定解决。
- Medium：历史通过率约 0.3～0.7，优先作为 Provider 区分题。

- Hard：高分位；要求 6+ 文件、较大 LOC 或高知识域复杂度之一，且不能是“所有模型几乎都 0%”的无信息题。

## 7.3 区分度优先级

InfoScore = 0.45 \* 4\*p_hist\*(1-p_hist)  
+ 0.25 \* diversity_gain  
+ 0.20 \* D_struct  
+ 0.10 \* runtime_efficiency

**说明：**4p(1-p) 在 p=0.5 时最大，确保选到“最可能拉开差异”的题；diversity_gain 用于奖励尚未覆盖的语言、仓库、任务类型；runtime_efficiency 用于在同等信息量下优先选择执行成本更低的实例。

# 8. 最小集定义：Smoke-6 / Core-12 / Confirm-24

## 8.1 Smoke-6：首轮快速排雷

| **层** | **数量** | **建议组成**                         | **目的**                         |
|--------|----------|--------------------------------------|----------------------------------|
| Easy   | 2        | 基础 Bug/局部 Feature；至少 2 个仓库 | 检查接口、工具、环境是否正常     |
| Medium | 2        | 跨文件 Feature/Refactor              | 主要区分 Provider                |
| Hard   | 2        | Infra/复杂业务/6+ 文件之一           | 检查长程推理与 context/tool 能力 |

**停止条件：**若 6 题中出现 ≥2 个“官方/基线端 PASS、候选端 FAIL”，立即进入分歧复测，不必先扩到 12；若结果基本一致，则扩展 Core-12。

## 8.2 Core-12：推荐的最小可信套件

| **约束** | **Core-12 配额**                                                |
|----------|-----------------------------------------------------------------|
| 难度     | Easy 2；Medium 6；Hard 4                                        |
| 语言     | 四类语言原则上各 3 题；若数据分布/运行成本不允许，至少每类 2 题 |
| 任务类型 | Bug ≥3；Feature ≥3；Refactor ≥2；Infra/Security/Perf ≥2         |
| 仓库     | 每仓库最多 2 题；至少覆盖 7 个仓库                              |
| 规模     | 至少 6 题为 3+ 文件；至少 3 题为 6+ 文件或高 LOC                |
| 知识域   | 至少覆盖 backend、web/full-stack、infra/security 三类           |

> **Core-12 的定位**
>
> 它不是“12 题就能估计官方总分”，而是一个用于 Provider 回归/同模型 A/B 的高信息量诊断套件。最重要的输出不是 8/12 vs 7/12，而是哪些任务发生了方向一致且可复现的 Provider-only failure。

## 8.3 Confirm-24：需要更强结论时

- 在 Core-12 基础上增加 12 个不重复任务，优先补齐语言/仓库/任务类型的空白。
- 中等难度仍占一半左右；避免把扩展集全部塞成极难题。

- 若目标是生产上线决策，Confirm-24 + 分歧复测通常比盲目跑 100 题更经济。

# 9. 抽样算法与候选池构建

1.  加载固定 revision 的 731 题 public set，并解析 gold patch 的 files_changed、LOC added/deleted、文件扩展名。

2.  运行质量门禁，过滤环境不稳定、gold 不可解、已知坏例、疑似泄漏、运行时间异常实例。

3.  为每题计算 D_struct；若有历史逐题成绩则计算 D_emp / p_hist。

4.  为每题生成标准化标签：difficulty、task_type、language_family、repo、knowledge_domain、runtime_class。

5.  按 Core-12 配额建立空槽位；每轮从候选池选择 InfoScore 最高且能增加多样性的任务。

6.  若两个候选 InfoScore 相近，优先运行耗时短、镜像小、测试稳定的任务，以降低成本。

7.  输出 suite_manifest.json，并记录 dataset/evaluator/scaffold/image 版本指纹。

```text
# 伪代码
selected = []
while not quotas_satisfied(selected):
    candidates = quality_passed - selected
    for x in candidates:
        score[x] = info_score(x) + diversity_gain(x, selected) - cost_penalty(x)
    x = argmax(score subject to repo/language/type constraints)
    selected.append(x)
return selected
```

# 10. 执行环境与公平性控制

| **必须锁定**   | **要求**                                                                          |
|----------------|-----------------------------------------------------------------------------------|
| Agent scaffold | 同一 SWE-Agent/mini-SWE-Agent 版本、同一工具定义                                  |
| Prompt         | problem_statement + requirements + interface 组成完全一致                         |
| Turn limit     | 统一，建议先对齐官方 50 turns；若为快速版改小，两个 Provider 必须一致             |
| 模型参数       | temperature、top_p、reasoning_effort、max output 显式设置，不依赖 Provider 默认值 |
| 上下文限制     | 以两个 Provider 的较小上限为准；超过则判为“不可比”而非直接算模型失败              |
| 容器           | 同一 image digest、base_commit、测试命令、CPU/内存限制                            |
| 网络           | 默认禁用或同等开放；严禁一端可联网一端不可联网                                    |
| 并发           | A/B 使用同等并发；速度测试与能力测试最好分开跑                                    |
| 重试           | HTTP 429/5xx 等基础设施错误可重试，但模型逻辑失败不得自动重试掩盖                 |

> **同一模型 Provider A/B 的特殊要求**
>
> 只允许变化 endpoint、API key 和 provider-specific model identifier。任何 server-side 默认参数都应尽量通过请求显式覆盖；无法覆盖的差异必须写入报告“不可控变量”。

# 11. 指标体系与统计判定

## 11.1 一级指标

| **指标**                          | **定义**                                  | **优先级** |
|-----------------------------------|-------------------------------------------|------------|
| Resolved                          | fail-to-pass 全通过且 pass-to-pass 不回归 | P0         |
| Paired Disagreement               | 同一任务 A/B 成功状态不一致               | P0         |
| Official-only / Baseline-only win | 基线 PASS、候选 FAIL                      | P0         |
| Candidate-only win                | 候选 PASS、基线 FAIL                      | P0         |
| Stable Disagreement               | 分歧题重复后多数结果仍同方向              | P0         |

## 11.2 二级指标

| **指标**                   | **用途**                    |
|----------------------------|-----------------------------|
| 总 wall-clock              | 真实开发体验                |
| TTFT / decode tok/s        | 拆分排队与解码速度          |
| Input/Cached/Output tokens | 成本与 context 行为         |
| Tool calls / turns         | Agent 效率与循环行为        |
| 未提交率                   | reasoning/工具/截断问题信号 |
| API 错误率                 | 服务稳定性                  |
| Cost per Solved Task       | 最终性价比核心指标          |

## 11.3 成对统计

n10 = Baseline PASS, Candidate FAIL  
n01 = Baseline FAIL, Candidate PASS  
  
paired_delta = (n01 - n10) / N  
disagreement_rate = (n10 + n01) / N

**Core-12 阶段不建议把 p-value 当作主要决策依据。**样本太小；应把“稳定方向分歧”作为核心证据。进入 Confirm-24 或更大样本后，可附加 exact McNemar test 与 Wilson 区间。

# 12. 自适应复测与停止规则

| **阶段**      | **触发**                       | **动作**                                               |
|---------------|--------------------------------|--------------------------------------------------------|
| S0 环境校验   | 开始前                         | 每题 gold patch 1 次；随机抽 1～2 题 base failure 校验 |
| S1 Smoke-6    | 默认                           | 每 Provider 每题 1 次                                  |
| S2 分歧复测   | 任一 A/B 不一致                | 只对分歧题每端再跑 2 次，形成 3-run majority           |
| S3 Core-12    | Smoke 无明显回退或需提高置信   | 补足 6 题；同样只复测分歧                              |
| S4 Confirm-24 | Core 出现边界结论/准备生产切换 | 再补 12 题 + 复测分歧                                  |
| S5 深挖       | 稳定分歧 ≥3 或集中于同一类别   | 保存完整 trajectory，做 failure-mode analysis          |

> **建议决策阈值（诊断而非学术显著性）**
>
> GREEN：Core-12 中稳定 baseline-only failure ≤1，且无同一类别集中回退；YELLOW：稳定 baseline-only failure 为 2，或明显集中在长上下文/tool use；RED：稳定 baseline-only failure ≥3，或某关键任务类型连续 0/3 vs 3/3。RED 时不建议仅凭更低价格切换 Provider。

# 13. 成本控制模型

成本控制的重点不是把每题 token 压到最低，而是减少“没有新增信息”的重复运行。

Cost_run = uncached_input_M \* P_in  
+ cached_input_M \* P_cache  
+ output_M \* P_out  
  
Cost_suite = Σ Cost_run + sandbox_compute  
Cost_per_solved = Cost_suite / solved_tasks

- 第一轮只跑 Smoke-6，不预付 Core-12 的成本。
- 重复运行仅针对 disagreement，不重复“双 PASS / 双 FAIL”任务。

- 抽样时引入 runtime_efficiency，同等信息量优先选择测试时长短的实例。
- 能力评测与速度评测分开：能力测试可串行/低并发；速度测试另做固定 prompt，避免排队噪声混入能力判断。

- 每次报告使用实际 usage/billing 数据，不把公开价硬编码到 suite。

# 14. 报告与产物规范

| **产物**              | **内容**                                                      |
|-----------------------|---------------------------------------------------------------|
| suite_manifest.json   | 实例 ID、分层标签、难度分数、镜像 digest、版本指纹            |
| run_manifest.json     | Provider、模型、参数、scaffold、时间、并发、API endpoint 哈希 |
| per_run.jsonl         | 每次 run 的状态、tokens、耗时、tool calls、错误、patch 路径   |
| eval_results.csv      | 每题 fail2pass/pass2pass/Resolved                             |
| paired_report.html/md | A/B 成对矩阵、分歧题、成本、速度、结论                        |
| trajectories/         | 仅保存失败与分歧任务的完整轨迹，减少存储                      |

**推荐摘要表**

| Task | Stratum | Baseline | Candidate | Stable? | Cost A | Cost B | Wall A | Wall B |
|---|---|---|---|---|---:|---:|---:|---:|
| ... | ... | ... | ... | ... | ... | ... | ... | ... |

# 15. 示例候选任务

以下 6 题可作为 Smoke-6 的**初始候选池**，但难度标签不是 SWE-bench Pro 官方标签。正式 suite 应由第 7～9 节的评分器在固定 dataset revision 上重新计算后确定。

| **建议层** | **仓库 / 任务摘要**                                | **主要能力**                    | **实例 ID（缩写）**     |
|------------|----------------------------------------------------|---------------------------------|-------------------------|
| Easy       | qutebrowser：Qt warning filtering 迁移/重构        | 定位、引用迁移、回归测试        | ...f91ace...-v059c6...  |
| Easy-Med   | OpenLibrary：Wikidata get_statement_values         | 局部 API、数据结构理解          | ...4a5d2a...-v136425... |
| Medium     | Navidrome：LastFM/ListenBrainz/Spotify client 封装 | Go、多 package、重构            | ...7073d1...            |
| Med-Hard   | NodeBB：.well-known/webfinger                      | 路由、controller、权限、Feature | ...51d8f3...-vf2cf3...  |
| Hard       | NodeBB：Email validation / DB mget                 | 业务状态、DB 抽象、多 backend   | ...049989...-vnan       |
| Hard       | Teleport：kubectl exec session uploader            | Go、Kubernetes、审计/基础设施   | ...3fa690...-v626ec...  |

> **候选池使用方式**
>
> 首次落地可先使用这 6 题验证执行链路；随后用自动评分从 731 题中替换掉“过易、过难、运行太慢或与其他题高度重复”的实例，使 Core-12 逐步演化为稳定内部基线。

# 16. 实施步骤

## 16.1 MVP（1 个工作日内可完成）

1. 冻结 dataset/evaluator/scaffold 版本，准备 6 个候选实例与官方 Docker 镜像。

2. 实现 suite_manifest 与最简单的 A/B wrapper：同一任务顺序执行 Provider A/B。

3. 接入官方 evaluator，输出每题 Resolved 与基本 token/耗时。

4. 实现“只复测 disagreement”逻辑。

5. 跑 Smoke-6，验证端到端流程与日志字段。

## 16.2 稳定版（建议）

1. 实现 gold patch 解析、结构难度评分与分层抽样。

2. 补充经验难度：导入官方/公开逐题结果或自建 reference model panel。

3. 加 anti-leak sandbox、已知坏例 denylist、镜像 digest 校验。

4. 生成 Core-12 并锁定为 sbp-mini-YYYY.MM-rN。

5. 增加 HTML/Markdown 对比报告与失败轨迹分类。

# 17. 风险、局限与后续演进

| **风险/局限**           | **影响**                      | **应对**                                                            |
|-------------------------|-------------------------------|---------------------------------------------------------------------|
| 样本太小                | 无法代表完整 731 题总体分数   | 明确定位为 Provider 回归检测；必要时扩到 Confirm-24/48              |
| 公开题污染              | 高分可能含记忆成分            | 优先新 revision；长期可加入私有真实任务或 DeepSWE 类原创任务        |
| 测试器假阴性            | 正确替代实现可能被拒绝        | 使用官方 human-augmented requirements/interface；对稳定分歧人工复核 |
| 仓库/语言标签偏差       | 分层不准                      | 从 gold patch 文件扩展名与变更路径二次推断                          |
| Provider 隐藏默认值     | A/B 非完全同参                | 显式锁参；报告不可控变量；必要时向 Provider 确认                    |
| Agent scaffold 影响过大 | 把 Agent 差异误判为模型差异   | 固定 scaffold；升级 scaffold 时新建 suite run series                |
| 速度与能力混杂          | 高并发排队导致超时/能力假下降 | 能力与吞吐分离评测                                                  |

**后续演进建议：**在 Core-12 稳定后，可将你自己的真实历史 bug/feature 任务做成 private mini-SWE 集，与 SWE-bench Pro 最小集并行。公共基准负责可比性，私有任务负责贴合你的真实 Code Agent 工作负载。

# 附录A. 运行清单 Schema

```json
{
  "suite_version": "sbp-mini-2026.08-r1",
  "dataset_revision": "<hf_commit_sha>",
  "evaluator_revision": "<git_sha>",
  "scaffold_revision": "<git_sha>",
  "instances": [
    {
      "instance_id": "instance_...",
      "repo": "...",
      "language_family": "go|python|js|ts",
      "task_type": "bug|feature|refactor|infra",
      "difficulty": "easy|medium|hard",
      "d_struct": 0.00,
      "d_emp": 0.00,
      "files_changed": 0,
      "loc_changed": 0,
      "docker_image": "...",
      "docker_digest": "sha256:..."
    }
  ]
}
```

# 附录B. 推荐配置模板

```yaml
evaluation:
  max_turns: 50
  retries_infra_only: 2
  repeat_disagreements: 2 # 首次 + 2 次 = 3 次 majority
  network: disabled
  expose_gold_patch: false
  expose_test_patch: false
model_common:
  temperature: <显式值>
  top_p: <显式值>
  reasoning_effort: <显式值>
  max_output_tokens: <两个 Provider 的共同上限>
provider_a:
  base_url: <baseline>
  model: <id>
provider_b:
  base_url: <candidate>
  model: <id>
```

# 参考资料

\[1\] Scale AI：SWE-Bench Pro Public Leaderboard / Methodology — [https://labs.scale.com/leaderboard/swe_bench_pro_public](https://labs.scale.com/leaderboard/swe_bench_pro_public)

\[2\] ScaleAI/SWE-bench_Pro：Hugging Face Dataset — [https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro](https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro)

\[3\] scaleapi/SWE-bench_Pro-os：官方评测代码与复现说明 — [https://github.com/scaleapi/SWE-bench_Pro-os](https://github.com/scaleapi/SWE-bench_Pro-os)

\[4\] Deng et al.：SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks? — [https://arxiv.org/abs/2509.16941](https://arxiv.org/abs/2509.16941)

\[5\] 官方仓库 Issue \#93：Git Reward Hacking in SWEBench Pro OSS — [https://github.com/scaleapi/SWE-bench_Pro-os/issues/93](https://github.com/scaleapi/SWE-bench_Pro-os/issues/93)

**文档说明：**本文中的 Smoke-6 / Core-12 / Confirm-24、D_struct、InfoScore 等是为“低成本 Provider A/B”提出的工程化方案，不是 SWE-bench Pro 官方协议。
