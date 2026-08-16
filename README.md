# SWE-bench Pro 分层最小集评测框架

依据《SWE-bench Pro 分层抽取最小集快速评测框架 方案设计 v1.0》实现的可运行测试框架:
通过 Web 页面输入推理 Provider 的 **Base URL + Model**(OpenAI 兼容接口),对分层抽取的
最小任务集(Smoke-6 / Core-12 / Confirm-24)执行**单模型独立评测**。
每个模型/Provider 单独跑完一套固定任务后,可在“对比”页面对两次独立运行进行事后对比,
并以图表形式可视化结果(Resolved、成对矩阵、成本/速度)。

> 📖 **详细的分步操作说明见 [评测操作指南.md](评测操作指南.md)**
> (每一步操作及其作用、字段含义、报告解读、等效 REST API、FAQ)。

## 快速开始

```bash
npm install
npm run build                 # 编译到 dist/
npm start                     # 默认 http://127.0.0.1:8765,可用 PORT 环境变量或参数指定端口
# 开发模式（自动重启）:
npm run dev
```

代码位于 `src/`，入口为 `src/server.ts`。

打开浏览器访问 `http://127.0.0.1:8765`:

1. **新建评测** — 填写 Provider 的 Base URL、Model ID、API Key 与采样参数;
   选择固定测试套件后启动。每次运行只评测一个模型/Provider。
2. **运行监控** — 实时进度条、阶段徽章、顶部实时汇总平均 token/s、缓存命中率、
   输入/输出 tokens 与花费;点击实例可实时查看流式输出,每任务 PASS/FAIL 网格。
3. **结果报告** — 单次运行的汇总卡片、分难度 Resolved 对比图、Token/吞吐/成本图、
   每任务明细(可展开查看失败轨迹与补丁)。
4. **对比** — 选择两个已完成且使用同一套件的独立运行,查看 Resolved 对比、
   成对结果矩阵、每任务两运行状态与成本/速度差异。
5. **实例与套件** — 浏览预置的 27 个官方套件实例(难度分/经验分/分层标签)、
   查看固定套件(由 `src/data/fixed_suites.json` 维护)并查看难度/语言/任务类型/仓库构成环形图;
   固定套件可直接点“运行”一键复用。

## 评测方式

默认采用**多轮 Agent scaffold**(对齐官方 SWE-Agent 形态的最小本地实现):模型通过
`bash` / `view_file` / `edit_file` / `submit` 四个工具在每任务专属工作区内迭代解题
(工作区以 TASK.md 种子并建立 git 基线),`submit` 或轮次预算(默认 50)耗尽后,
以工作区文件变更的 `git diff` 作为补丁交给评测器;流式记录每轮 TTFT / decode tok/s / usage,
429/5xx 自动重试。评测仅支持多轮 Agent 模式(单轮补丁模式已删除)。

Resolved 由官方 Docker 测试环境判定（真实退出码）。建议先用 Smoke-6 验证连通性。

> ⚠️ 隔离性:Agent 与测试均在官方 Docker 容器内执行;bash 工具在容器内运行
> （每命令超时 + 输出截断）。设 `SBP_AGENT_BASH=0` 可禁用 bash 工具,
> `SBP_AGENT_BASH_TIMEOUT` 调整超时。

## 使用官方 SWE-bench Pro 数据集

当前框架**不再内置演示种子，也不需要配置数据集路径**。固定测试套件
（Smoke-6 / Core-12 / Confirm-24）所需的官方实例已预置在仓库中：

- `src/data/fixed_suites.json`：三个固定套件的实例 ID
- `src/data/suite_instances.json`：这三个套件引用的 27 个官方实例完整数据

打开 Web 后直接选择套件即可运行，无需填写任何 JSON 路径。评测设置中仍显示
Smoke-6 / Core-12 / Confirm-24 三个套件层级，仅注明测试数据来源于官方数据集。

如需重新从官方数据集构造/更新预置数据（可选）：

1. **导出完整官方数据集**
   ```bash
   pip install datasets duckdb
   python scripts/export_official_dataset.py \
     --revision <commit_sha> \
     --output runs/official_swebench_pro.json
   ```
   若没有安装 `datasets`，脚本会自动回退到 DuckDB 读取官方 parquet。

2. **重新生成固定套件与预置实例**
   ```bash
   python scripts/build_fixed_suites.py \
     --dataset runs/official_swebench_pro.json \
     --output src/data/fixed_suites.json
   ```
   脚本会同时输出 `src/data/fixed_suites.json` 和 `src/data/suite_instances.json`。

3. **运行要求**
   - Docker daemon 已启动
   - 官方镜像已存在或可拉取（`docker_image` 字段，例如 `jefzda/sweap-images:<dockerhub_tag>`）
   - 镜像内仓库默认位于 `/testbed`，可用 `SBP_OFFICIAL_REPO_DIR` 覆盖

4. **判定方式**
   - Agent 在 Docker 容器内的真实仓库中工作
   - 评测时另起一次性容器，应用 agent patch 与官方 `test_patch`
   - 逐个运行 `fail_to_pass` / `pass_to_pass`，以真实退出码判定
   - `resolved = fail_to_pass 全通过 && pass_to_pass 不回归`

> 该模式是“最小官方环境”：使用官方 Docker 镜像与测试用例，但没有接入 `swebench` Python harness 的全部细节。若需要完全官方复现，可在此基础上把 `src/evaluator.ts` 的 `evaluateOfficialDocker` 替换为调用官方 `swebench.harness.run_evaluation`。

## 独立运行与事后对比

本框架**不再内置 A/B 双端同跑、基线复用或分歧复测**。每次评测只跑一个模型/Provider，
之后在“对比”页选择两次已完成运行进行事后比较：

| 方式 | 说明 |
|---|---|
| **单模型运行** | 新建评测时只填写一个 Provider,对所选套件完整跑一遍并生成报告 |
| **事后对比** | 在“对比”页选择两个已完成且使用同一套件的运行,查看 Resolved、成对矩阵、每任务差异、成本/速度 |

对比仅基于两次独立运行的报告,不会自动触发任何复测,也不会给出 GREEN/YELLOW/RED 切换决策。
若要得到更稳定的结论,建议对同一模型/Provider 使用相同套件和参数多次独立运行后再人工判断。

## 与设计文档的对应关系

| 设计文档章节 | 实现 |
|---|---|
| §5 数据冻结 | `scripts/export_official_dataset.py` 导出固定 revision；`src/data/fixed_suites.json` 记录 `official-v1` |
| §7 难度评分 | `src/difficulty.ts`:`D_struct = 0.40F+0.35L+0.15T+0.10S`、`D_emp = 1-p_hist`、`D_total = 0.6D_emp+0.4D_struct`、InfoScore |
| §8 最小集定义 | `src/data/fixed_suites.json`:固定 Smoke-6 / Core-12 / Confirm-24 题目，不再随机抽样 |
| §9 抽样算法 | 已取消随机抽样；固定套件由 `scripts/build_fixed_suites.py` 从官方数据集构造，也可直接编辑 `src/data/fixed_suites.json` 中的 `instance_ids` |
| §10 公平性控制 | 单次运行使用同一 prompt / 参数 / 套件;对比时要求两次运行使用同一套件;API key 仅进程内保存,落盘脱敏,端点记哈希 |
| §11 指标体系 | `src/analyzer.ts`:Resolved、分难度统计、每任务明细、成本/速度、Cost per Solved Task |
| §14 报告产物 | `runs/<run_id>/`:`run_manifest.json`、`suite_manifest.json`、`per_run.jsonl`、`eval_results.csv`、`report.json`、`report.md`、`trajectories/`(仅失败任务) |
| §15 示例候选 | 固定套件全部来自官方 `ScaleAI/SWE-bench_Pro` 真实实例，不再使用演示种子 |

## REST API(前端即基于此)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 候选池统计(语言/类型/仓库/难度分布)，使用预置套件实例 |
| GET | `/api/instances?language=&task_type=&difficulty_band=&repo=&q=` | 带评分标注的实例列表 |
| GET | `/api/suites` | 固定套件列表（由 `src/data/fixed_suites.json` 维护） |
| POST | `/api/suites` `{level, seed}` | 兼容保留：返回对应固定套件，不再随机抽样 |
| GET | `/api/suites[/{suite_id}]` | 套件列表 / 详情 |
| POST | `/api/runs` | 创建并启动单模型评测;请求体使用 `provider` 单端配置 |
| GET | `/api/runs[/{id}/state]` | 运行列表 / 实时状态与进度 |
| GET | `/api/runs/{id}/report` | 完整分析报告 |
| POST | `/api/compare` `{run_a, run_b}` | 对两次已完成独立运行做事后对比 |
| POST | `/api/runs/{id}/cancel`、`/artifact` | 取消运行 / 读取产物与轨迹 |
| DELETE | `/api/runs/{id}` | 删除运行 |

## 项目结构

```
├── package.json             # npm 依赖与脚本
├── tsconfig.json
├── src/
│   ├── server.ts            # Express 入口 + REST API + 静态页托管
│   ├── schemas.ts           # TS 类型 + zod 校验
│   ├── dataset.ts           # 预置套件实例加载 / 官方 JSON 高级加载
│   ├── difficulty.ts        # 难度评分
│   ├── sampler.ts           # 固定套件生成/读取
│   ├── provider.ts          # OpenAI 兼容流式客户端
│   ├── workspace.ts         # Agent 工作区工具
│   ├── evaluator.ts         # Docker 官方测试判定
│   ├── runner.ts            # 单模型 Runner + Agent 循环
│   ├── analyzer.ts          # 指标 / 统计 / 单次报告 / 事后对比
│   ├── store.ts             # runs/ 产物存储
│   ├── live.ts              # 实时输出缓冲
│   └── data/
│       ├── fixed_suites.json      # 固定 Smoke-6 / Core-12 / Confirm-24(官方数据集构造)
│       └── suite_instances.json   # 固定套件引用的 27 个官方实例(预置数据)
├── scripts/
│   ├── export_official_dataset.py # 从 HF/parquet 导出完整官方数据集 JSON
│   └── build_fixed_suites.py      # 从官方数据集构造 fixed_suites.json
├── web/                     # 前端(原生 HTML/CSS/JS,自绘 SVG 图表,无构建依赖)
└── runs/                    # 运行产物(运行时生成;完整官方数据集导出可选)
```

## 已知限制(与正式评测的差距)

1. **Scaffold**:仅支持多轮 Agent 工具循环(OpenAI function-calling,轮次预算默认 50);
   Agent 在官方 Docker 镜像内的真实仓库中工作，但仍是本地最小实现，未完全复刻官方 swebench harness。
2. **评测判定**:Resolved 由官方 Docker 测试环境判定（真实退出码），但仍是最小官方环境，未完全复刻官方 swebench harness。
3. **实例数据**:仓库预置了固定套件引用的 27 个官方实例
   （`src/data/suite_instances.json`）；如需更换题目，可重新运行
   `scripts/export_official_dataset.py` + `scripts/build_fixed_suites.py` 更新。
4. **对比结论**:事后对比仅基于两次独立运行的结果，不包含分歧复测或统计显著性判断;
   样本较小时应把对比结果当作诊断信号而非严格统计结论。
