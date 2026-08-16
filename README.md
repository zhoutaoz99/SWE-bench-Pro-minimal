# SWE-bench Pro 分层最小集评测框架

依据《SWE-bench Pro 分层抽取最小集快速评测框架 方案设计 v1.0》实现的可运行测试框架:
通过 Web 页面输入推理 Provider 的 **Base URL + Model**(OpenAI 兼容接口),对分层抽取的
最小任务集(Smoke-6 / Core-12 / Confirm-24)执行 **Provider A/B 对比评测**,
并以图表形式可视化查看结果(成对矩阵、分歧任务、成本/速度、GREEN/YELLOW/RED 决策)。

> 📖 **详细的分步操作说明见 [评测操作指南.md](评测操作指南.md)**
> (每一步操作及其作用、字段含义、报告解读、等效 REST API、FAQ)。

## 快速开始

```bash
pip install -r requirements.txt
python run_server.py          # 默认 http://127.0.0.1:8765,可指定端口:python run_server.py 9000
```

打开浏览器访问 `http://127.0.0.1:8765`:

1. **新建评测** — 填写 Provider A(基线端)/ Provider B(候选端,可选)的 Base URL、
   Model ID、API Key 与采样参数;基线来源可选"本次填写"或"复用已完成基线"(只实跑候选端);
   选择套件层级后启动。
2. **运行监控** — 实时进度条、阶段徽章(S1 主评测 / S2 分歧复测 / 分析汇总)、
   每任务 A/B 双端 PASS/FAIL 网格。
3. **结果报告** — 汇总卡片、分难度 Resolved 对比图、成对结果矩阵、Token/吞吐/成本图、
   每任务明细(可展开查看失败轨迹与补丁)、GREEN/YELLOW/RED 决策与建议。
4. **实例与套件** — 浏览 36 题候选池(难度分/经验分/分层标签)、
   生成分层套件并查看难度/语言/任务类型/仓库构成环形图。

## 评测方式

默认采用**多轮 Agent scaffold**(对齐官方 SWE-Agent 形态的最小本地实现):模型通过
`bash` / `view_file` / `edit_file` / `submit` 四个工具在每任务专属工作区内迭代解题
(工作区以 TASK.md 种子并建立 git 基线),`submit` 或轮次预算(默认 200,对齐官方)耗尽后,
以工作区文件变更的 `git diff` 作为补丁交给评测器;流式记录每轮 TTFT / decode tok/s / usage,
429/5xx 自动重试。评测设置中可切回旧版**单轮补丁生成**(两端必须同 scaffold,复用基线时强校验)。

Resolved 为补丁结构启发式判定。建议先用 Smoke-6 验证连通性。

> ⚠️ 隔离性:官方评测在 Docker 容器内执行命令;本框架的 bash 工具在**宿主机**工作区
> 目录内直接执行(仅 cwd 限定 + 超时 + 输出截断),只应在可信评测环境下使用。
> 设 `SBP_AGENT_BASH=0` 可禁用 bash 工具,`SBP_AGENT_BASH_TIMEOUT` 调整超时。

## 基线与候选端独立运行 / 基线复用

基线端一般跑过一次后不会经常更新,因此支持三种运行方式:

| 方式 | 配置 | 说明 |
|---|---|---|
| **基线单端运行** | 仅 Provider A(不勾选"启用 A/B 对比") | 跑一次基线并存档;完成后自动进入可复用基线列表 |
| **复用基线 + 候选端** | 基线来源选"复用已完成基线",只填 Provider B | 基线记录(含成本/耗时/轨迹)原样导入,本次**只实跑候选端**;S2 分歧复测也仅补跑候选端 |
| **传统 A/B 双端** | A、B 都填写 | 两端同跑(原有行为) |

复用约束(服务端校验):基线运行必须已完成且为单端实跑;套件必须与基线运行完全一致(未指定时自动沿用)。报告与 manifest 会标注 `baseline_reused_from`,运行列表以 🔗 标记。

> ⚠️ **正式结论需接入官方 evaluator**:真实的 fail-to-pass / pass-to-pass 判定必须在
> Docker 中执行任务测试套件(参考 [scaleapi/SWE-bench_Pro-os](https://github.com/scaleapi/SWE-bench_Pro-os),
> 设计文档 §5 质量门禁 G1–G7)。本框架的 `app/evaluator.py` 预留了替换点。

## 与设计文档的对应关系

| 设计文档章节 | 实现 |
|---|---|
| §5 数据冻结 | `dataset.py`:seed 池版本指纹 `seed-demo-v1`;`load_hf_dataset(revision)` 支持 HF 固定 revision 加载 |
| §7 难度评分 | `difficulty.py`:`D_struct = 0.40F+0.35L+0.15T+0.10S`、`D_emp = 1-p_hist`、`D_total = 0.6D_emp+0.4D_struct`、InfoScore |
| §8 最小集定义 | `sampler.py`:Smoke-6(2/2/2)、Core-12(E2/M6/H4、每仓≤2、≥7 仓库)、Confirm-24(Core-12 + 12 补充,Medium 约半) |
| §9 抽样算法 | 贪心选择 `InfoScore + diversity_gain + 任务类型缺口加成`,仓库上限与相邻带漂移放宽均记录进 manifest |
| §10 公平性控制 | 两端同 prompt / 同参数 / 同套件;API key 仅进程内保存,落盘脱敏,端点记哈希 |
| §11 指标体系 | `analyzer.py`:Resolved、Paired Disagreement、n10/n01、paired_delta、精确 McNemar、Wilson 参考、二级速度/成本指标、Cost per Solved Task |
| §12 自适应复测 | `runner.py`:S1 首轮 → 仅对分歧题 S2 每端补跑 `repeat_disagreements` 次 → 3-run majority → 稳定分歧 → GREEN(≤1 且无集中)/ YELLOW(=2 或集中)/ RED(≥3 或类别扫荡) |
| §13 成本控制 | 只复测分歧;价格可按端配置($/1M tokens,输入/缓存/输出三档) |
| §14 报告产物 | `runs/<run_id>/`:`run_manifest.json`、`suite_manifest.json`、`per_run.jsonl`、`eval_results.csv`、`report.json`、`paired_report.md`、`trajectories/`(仅失败与分歧任务) |
| §15 示例候选 | 36 题种子池含文档给出的 6 个候选(qutebrowser Qt warning、OpenLibrary Wikidata、Navidrome scrobbler、NodeBB webfinger/email、Teleport uploader) |

## REST API(前端即基于此)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 候选池统计(语言/类型/仓库/难度分布) |
| GET | `/api/instances?language=&task_type=&difficulty_band=&repo=&q=` | 带评分标注的实例列表 |
| POST | `/api/suites` `{level, seed}` | 生成分层套件清单 |
| GET | `/api/suites[/{suite_id}]` | 套件列表 / 详情 |
| GET | `/api/baselines` | 可复用的基线运行列表(已完成、单端实跑) |
| POST | `/api/runs` | 创建并启动评测;`provider_a`+`provider_b` 双端,仅 `provider_a` 基线单端,或 `baseline_run_id`+`provider_b` 复用基线只跑候选端 |
| GET | `/api/runs[/{id}/state]` | 运行列表 / 实时状态与进度 |
| GET | `/api/runs/{id}/report` | 完整分析报告 |
| POST | `/api/runs/{id}/cancel`、`/artifact` | 取消运行 / 读取产物与轨迹 |
| DELETE | `/api/runs/{id}` | 删除运行 |

## 项目结构

```
├── run_server.py            # 启动入口
├── app/
│   ├── schemas.py           # Pydantic 模型(Provider 配置 / 实例 / 运行记录)
│   ├── dataset.py           # 种子池加载 + HF 真实数据集加载(可选拓展)
│   ├── difficulty.py        # D_struct / D_emp / InfoScore / 难度分带
│   ├── sampler.py           # 分层抽样器(Smoke-6 / Core-12 / Confirm-24)
│   ├── provider.py          # OpenAI 兼容客户端(流式 TTFT;agent_step 工具调用)
│   ├── env.py               # Agent 工作区(bash/查看/编辑/submit 工具 + git 补丁提取)
│   ├── evaluator.py         # fail-to-pass / pass-to-pass 判定(补丁结构启发式)
│   ├── runner.py            # A/B Runner:S1 → S2 分歧复测 → 分析;支持基线复用(只实跑候选端)
│   ├── analyzer.py          # 指标 / 成对统计 / 决策 / Markdown 报告
│   ├── store.py             # runs/ 产物存储(manifest / jsonl / csv / 轨迹)
│   ├── main.py              # FastAPI API + 静态页托管
│   └── data/seed_instances.json   # 36 题演示实例池
├── web/                     # 前端(原生 HTML/CSS/JS,自绘 SVG 图表,无构建依赖)
└── runs/                    # 运行产物(运行时生成)
```

## 已知限制(与正式评测的差距)

1. **Scaffold**:默认为多轮 Agent 工具循环(OpenAI function-calling,轮次预算对齐官方 200),
   但工作区为 TASK.md 种子的空仓库,**不含真实代码库**;官方在 Docker 内挂载真实 repo。
   与官方分数不可比,但两端对比公平性成立。
2. **评测判定**:Resolved 为补丁结构启发式判定。正式结论需接官方 Docker evaluator。
3. **实例数据**:36 题为演示种子(元数据按公开集仓库结构构造),正式使用应
   `pip install datasets` 后从 `ScaleAI/SWE-bench_Pro` 固定 revision 加载并跑质量门禁。
4. **统计置信度**:Core-12 阶段以"稳定方向分歧"为核心证据,p-value 仅作参考(文档 §11.3)。
