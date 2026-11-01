# install-skills — 把 skills / commands / agents 从 GitHub 装到 Claude Code

按一份 JSON 配置，把 GitHub 上的 skill、command、agent 下载并安装到 `~/.claude`（或项目的 `./.claude`）。
装完**本机目录与配置文件严格一致**：配置里没有的东西不会出现，配置里有的一个不少。

- 脚本：[`install-skills.mjs`](install-skills.mjs)
- 配置：[`install.config.json`](install.config.json) —— **唯一真源**，改这个文件就能换掉本机装的东西

---

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [命令行参数](#命令行参数)
- [配置文件](#配置文件)
- [它到底做了什么](#它到底做了什么)
- [验证报告怎么读](#验证报告怎么读)
- [hooks 与 settings.json](#hooks-与-settingsjson)
- [备份与恢复](#备份与恢复)
- [缓存](#缓存)
- [退出码](#退出码)
- [常见报错对照](#常见报错对照)
- [为什么不用 npm 安装器](#为什么不用-npm-安装器)
- [安全须知](#安全须知)

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **18 或更高**（用到全局 `fetch`、`AbortSignal.timeout`、`Readable.fromWeb`） |
| 解压工具 | Windows 自带的 `tar.exe`（Win10+ 自带 bsdtar，支持 zip）即可；macOS/Linux 用 `unzip` 或 `tar`；两者都没有时回落到 PowerShell `Expand-Archive` |
| 网络 | 需要能访问 `codeload.github.com`；直连失败会自动走代理（见 `--proxy`） |

无需 `npm install`，脚本零依赖。

---

## 快速开始

```bash
# 1. 看看会装什么（不写目标目录，但仍会真的下载）
node install-skills.mjs --dry-run

# 2. 正式安装
node install-skills.mjs

# 3. 重启 Claude Code —— 新 skill / command / agent 才会生效
```

输出长这样：

```
[install-skills] target   = claude (C:\Users\Administrator\.claude)
[install-skills] config   = C:\Users\Administrator\project\test123\install.config.json
[install-skills] skills    = 8 项
[install-skills] commands  = 1 项
[install-skills] agents    = 10 项
[install-skills] --- 准备 GitHub 检出 ---
[install-skills] 下载 affaan-m/ECC@v2.2.3: https://codeload.github.com/affaan-m/ECC/zip/refs/tags/v2.2.3
[install-skills] 检出就绪 affaan-m/ECC@v2.2.3 → ...\install-20261101-183000\ECC-v2.2.3-1762000000000.zip.d\ECC-2.2.3
[install-skills] --- 安装 skills ---
[install-skills] 备份现有 skills → C:\Users\Administrator\.claude\skills.backup-20261101-183000
[install-skills] install skills/agent-eval ← affaan-m/ECC@v2.2.3
...
```

---

## 命令行参数

```bash
node install-skills.mjs [选项]
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--config <path>` | 脚本同目录的 `install.config.json` | 配置文件路径，相对路径按**当前工作目录**解析 |
| `--target <id>` | `claude` | `claude` = 装到 `~/.claude`；`claude-project` = 装到**当前目录**的 `./.claude` |
| `--proxy <url>` | `https://proxy.vvvv.ee/` | GitHub 下载的备用代理。**直连全部失败后才会走它**。传空字符串 `""` 可完全禁用代理 |
| `--cache-dir <dir>` | `~/.claude/cache/skill-sources` | 下载的 zip 解压后放哪，相对路径按当前工作目录解析 |
| `--no-download` | 关 | 禁止联网。只要有组件需要从 GitHub 取就直接失败退出（`local` 全覆盖时不受影响） |
| `--no-clear` | 关 | **不清空**目标目录，直接覆盖安装。目录里配置之外的文件会保留下来 |
| `--no-skills` | 关 | 跳过 skills，只装 commands / agents |
| `--no-commands` | 关 | 跳过 commands |
| `--no-agents` | 关 | 跳过 agents |
| `--dry-run` | 关 | 只演练，**不写目标目录和 settings.json**。注意它**仍会真的下载**（见下） |
| `-h` / `--help` | — | 打印用法 |

三个 `--no-*` 分组开关可以叠加。三个都加上时不会动任何目录，但 **settings.json 仍会被重写**（hook 与 `PYTHONUTF8` 部分）。

> ⚠️ **`--dry-run` 仍然会联网下载**。它跳过的是「写目标目录」和「改 settings.json」，不是「准备检出」—— 因为校验报告需要拿来源做比对。ECC 检出解压后几百 MB，dry-run 一次也会下载这么多。dry-run 还会在缓存目录里留下一个 `install-<时间戳>` 目录（这个不会在 dry-run 结束时被清理）。

**代理是「前缀」不是「URL base」**。传 `https://proxy.vvvv.ee/` 时，脚本实际请求的是
`https://proxy.vvvv.ee/https://codeload.github.com/...`。末尾有没有 `/` 都行。

---

## 配置文件

`install.config.json` 有三个顶层键，对应三类组件。**三类互相独立**：某个键不存在或为空数组，就表示不装这一类。

```jsonc
{
  "$comment": [ "随便写的注释，脚本会忽略未知键" ],

  "skills": [
    { "id": "pptx", "repo": "anthropics/skills", "ref": "main", "path": "skills/pptx" }
  ],
  "commands": [
    { "id": "code-review", "repo": "affaan-m/ECC", "ref": "v2.2.3", "path": "commands/code-review.md" }
  ],
  "agents": [
    { "id": "code-reviewer", "repo": "affaan-m/ECC", "ref": "v2.2.3", "path": "agents/code-reviewer.md" }
  ]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 装到本机后的名字。skill 用作**目录名**，command/agent 用作**文件名**（自动补 `.md`） |
| `repo` | ✅ | `owner/name`，例如 `affaan-m/ECC` |
| `ref` | ✅ | tag / branch / commit SHA。按 **tag → branch → SHA** 依次尝试解析 |
| `path` | ✅ | 仓库内相对路径。skill 写目录，command/agent 写文件（`.md` 可省略） |
| `local` | ❌ | 本地覆盖，指向**配置文件所在目录**下的路径。存在时优先用它 |

### 校验规则（不通过就直接报错退出，一个文件都不会动）

**`id`**
- 只允许字母数字和 `.` `_` `-`，且必须以字母数字开头
- 不能以 `.` 或空格结尾
- 不能含路径分隔符 —— `id` 会被直接拼进 `~/.claude/<组>/<id>`，放开就等于允许写到目标目录之外
- 同一分组内不能重复（重复会互相覆盖）

**`path`**
- 必须是仓库内的**相对路径**：不能是绝对路径，不能以盘符开头（如 `C:/...`）
- 不能含 `..` 段 —— `path` 会拼进检出目录，越界就等于读检出目录之外的文件

**`repo`**
- 必须是 `owner/name` 形式

**`local`**
- **skill 的 `local` 必须是目录**（整棵目录树，会被拷进 `~/.claude/skills/<id>/`）
- **command / agent 的 `local` 必须是文件**
- 类型不对 → 直接报配置错误。拿一个文件当 skill 目录树拷贝会崩掉整个安装，静默退回远端更糟（你以为覆盖生效了，其实没有）
- `local` 指向的路径不存在 → **不算配置错误**，打一条警告后回退到从 GitHub 下载

### `local` 覆盖示例

给「官方版本 + 本地微调」留的口子。以 skill 为例，`local` 指向一个目录：

```jsonc
{
  "id": "pptx",
  "repo": "anthropics/skills",
  "ref": "main",
  "path": "skills/pptx",
  "local": "./local/pptx"          // 相对 install.config.json 所在目录
}
```

`local` 覆盖生效时**不会下载**这个仓库（其它条目还要下载的话照常下载），日志里来源标注为「本地覆盖」。

---

## 它到底做了什么

```
读配置 ──► 校验（id / path / repo / local 形态）
            │  校验不过 → 报错退出，不动任何文件
            ▼
准备检出 ──► 对每个 repo@ref 下载 zip（tag → branch → SHA；直连 → 代理）
            │  下载失败 → 整体中止，不动本机任何目录
            ▼
逐组安装 ──► skills / commands / agents 各来一遍：
            │    ① 备份现有目录 → <目录>.backup-<时间戳>
            │    ② 清空
            │    ③ 按配置逐个写入
            ▼
配置 hooks ──► 写 settings.json 的 observe.sh 钩子 + PYTHONUTF8=1
            ▼
校验 ──────► 逐个组件比对「装出来的」与「来源」，出表格
            ▼
收尾 ──────► 打印备份目录、清理旧检出缓存、提示重启
```

几个值得知道的行为：

- **下载全部在动手之前完成**。网络抖动不会把已经装好的 skills 掏空 —— 下载失败就直接退出，本机目录原样不动。
- **每个 `repo@ref` 只下载一次**。同一个仓库的多个条目共用一份检出。
- **skill 拷贝时会把 CRLF 规范化为 LF**。Windows 上 `core.autocrlf=true` 的检出会把 `*.sh` 变成 CRLF，直接拷会让 hooks 脚本报 `$'\r': command not found`。二进制文件（含 NUL 字节）保持字节原样。日志里会告诉你规范化了几个文件。
- **command / agent 按字节原样拷贝**，不规范化行尾。
- **每个分组是「先备份、再清空、再写回」**。所以目标目录最终与配置严格一致。

---

## 验证报告怎么读

每次运行结束都会打印一张表：

```
  SKILLS → C:\Users\Administrator\.claude\skills
  NAME                        STATUS  FILES  SOURCE     NOTES
  ----------------------------------------------------------------------
  agent-eval                  PASS        7  identical  ok
  continuous-learning-v2       PASS       11  identical  ok
  pptx                        PASS        9  identical* ok
  skill-creator               FAIL        0  differs    与来源内容不一致

  SOURCE: identical=字节一致  identical*=仅 CRLF/LF 行尾差异  differs=内容不一致  no-source=无可比对来源
```

**STATUS 列**

| 值 | 含义 |
|---|---|
| `PASS` | 装好了，且与来源一致 |
| `SKIP` | 只在 `--dry-run` 下出现：文件还没落盘，状态待实跑后校验 |
| `FAIL` | 有问题，`NOTES` 列写了具体原因 |

**SOURCE 列**（与来源的比对结果）

| 值 | 含义 |
|---|---|
| `identical` | 与来源字节一致 |
| `identical*` | 只有 CRLF/LF 行尾差异（目标文件被规范化过） |
| `differs` | 内容不一致 → `FAIL` |
| `no-source` | 没有可比对的来源 |

**校验的内容**

- skill：目录存在、`SKILL.md` 存在且非空、有 YAML frontmatter、`frontmatter.name` 存在**且等于 `id`**、`frontmatter.description` 存在、与来源逐文件一致
- agent：目标文件存在且非空、有 frontmatter、`frontmatter.name` 存在**且等于 `id`**、`description` 存在、与来源一致
- command：目标文件存在且非空、有 frontmatter、`description` 存在、与来源一致

另外，**目标目录里出现配置之外的文件**会额外打一条警告（点文件不算）：

```
[install-skills][WARN] skills 目标目录存在配置之外的文件: my-old-skill/SKILL.md
```

正常情况下不该出现 —— 出现了通常意味着这个目录不是本脚本清的，或者你用了 `--no-clear`。

---

## hooks 与 settings.json

脚本会幂等地改写 `<target>/settings.json`（默认 `~/.claude/settings.json`）：

**1. observe.sh 钩子**

给 `PreToolUse` 和 `PostToolUse` 各注册一条：

```jsonc
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.claude/skills/continuous-learning-v2/hooks/observe.sh" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.claude/skills/continuous-learning-v2/hooks/observe.sh" }] }]
  }
}
```

- **只有在 `continuous-learning-v2` 这个 skill 真的装上了（`hooks/observe.sh` 存在）时才注册**。skill 没装却留下钩子，指向的脚本不存在，每次工具调用都会报错。
- 之前残留的 observe 钩子会被**摘掉**，不会重复注册。
- 命令路径跟随 `--target`：
  - `--target claude` → `~/.claude/skills/continuous-learning-v2/hooks/observe.sh`（`~` 由 shell 展开）
  - `--target claude-project` → 该项目下 `.claude/skills/continuous-learning-v2/hooks/observe.sh` 的绝对路径（正斜杠）

**2. `PYTHONUTF8=1`**

写进 `settings.json` 的 `env`：

```jsonc
{ "env": { "PYTHONUTF8": "1" } }
```

`skill-creator` / `continuous-learning-v2` 里的 Python 脚本用 `read_text()` 不带 `encoding`，在非 UTF-8 locale 的 Windows 上默认按 GBK 解码 → `UnicodeDecodeError`。打开 `PYTHONUTF8` 让 Python 3.7+ 统一用 UTF-8。无副作用。

**3. 你自己写的配置不受影响**

脚本读入现有 `settings.json` → 只改 `hooks` 和 `env` → 其余键原样保留 → 写回（2 空格缩进）。
写回前会在同目录留一份 `settings.json.bak-<epoch 毫秒>`。

> ⚠️ 如果 `settings.json` 不是合法 JSON，**组件安装仍然成功**，但 hooks 这一步会失败并报 `配置 hooks 失败: ...`，退出码非 0。这种情况下 `settings.json` 不会被覆盖成空 —— 坏文件原样留着，备份目录提示和缓存清理也照常执行。

---

## 备份与恢复

每次清空前，旧内容会被**逐个子项 rename** 到备份目录（不是整目录 rename —— Windows 上父目录句柄常被占用，整体 rename 会 Permission denied）：

```
~/.claude/skills.backup-20261101-183000/
~/.claude/commands.backup-20261101-183000/
~/.claude/agents.backup-20261101-183000/
```

同一秒内跑两次不会互相覆盖，第二次是 `...-183000-1`。

**手动恢复：**

```bash
# 先看一眼备份里有什么
ls ~/.claude/skills.backup-20261101-183000

# 把整个目录换回去
mv ~/.claude/skills ~/.claude/skills.broken
mv ~/.claude/skills.backup-20261101-183000 ~/.claude/skills
```

> ⚠️ **备份目录不会被自动清理**，跑得多了会占磁盘。ECC 的检出解压后有几百 MB，备份目录虽然没有检出大，但也需要定期清理。
>
> ⚠️ 某个子项如果被进程占用移不动（脚本会警告 `无法移动 xxx（可能被占用），保留在原地`），**它会留在原目录里**，也就是不在备份中。

---

## 缓存

下载的 zip 解压到 `<cache-dir>/install-<时间戳>/`（默认 `~/.claude/cache/skill-sources/`）。

ECC 一个检出解压后有几百 MB，跑一次留一次很快会把磁盘塞满，所以**每次运行结束会清理旧缓存，只保留最近 2 次**（`KEEP_CACHE_RUNS = 2`）。

缓存只是本次运行的工作区 —— 每次运行都重新下载，不复用上次的检出。

---

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 全部成功，校验全过 |
| 非 `0` | 有失败。安装/配置失败是 `1`；**校验失败时退出码等于失败项的数量** |

---

## 常见报错对照

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `配置文件不存在: <path>` | `--config` 指错了 | 检查路径；相对路径按当前工作目录解析 |
| `配置文件不是合法 JSON (<path>): ...` | JSON 语法错（常见：尾逗号、注释、字符串里的中文引号） | 修 JSON。`$comment` 这类自定义键可以用，但值必须是合法 JSON |
| `配置项无效 (...): id 只能包含字母数字和 . _ -（收到 ...）` | `id` 含路径分隔符或空格 | 改成纯名字。skill 的 `id` 就是 `~/.claude/skills/` 下的目录名 |
| `配置项无效 (...): path 不能包含 .. 段（收到 ...）` | `path` 越出了仓库 | 改成仓库内相对路径 |
| `配置项无效 (...): path 必须是仓库内的相对路径（收到 ...）` | `path` 是绝对路径 | 去掉盘符和开头的 `/` |
| `配置项无效 (...): repo 应为 owner/name（收到 ...）` | `repo` 格式不对 | 写成 `owner/name` |
| `配置里 skills 的 id 重复: xxx` | 同一个 id 出现两次 | 改掉其中一个。重复会互相覆盖 |
| `local 对 skill 必须是目录（收到 ...）` | skill 的 `local` 指向了文件 | 改成目录；或删掉 `local` 走远端 |
| `local 对 commands 必须是文件（收到 ...）` | command/agent 的 `local` 指向了目录 | 改成文件；或删掉 `local` 走远端 |
| `local 不存在，回退到远端下载 (...)` | `local` 路径没找到 | 只是警告，会改从 GitHub 下载。想强制本地就把路径写对 |
| `未知参数: xxx` | 参数拼错了 | `--help` 看用法 |
| `选项 --config 缺少参数` | 参数后面没跟值 | 补上值 |
| `需要从 GitHub 下载，但指定了 --no-download` | 开了 `--no-download` 但有组件要走远端 | 去掉它，或给这些组件配 `local` |
| `下载 <repo>@<ref> 失败: ...` | 网络问题 / ref 不存在 | 确认 ref 拼写；`--proxy` 换代理；网络恢复后重跑 |
| `下载内容不是有效的 zip（可能被代理拦截）` | 代理返回的不是 zip | 换代理，或先断网让脚本走直连 |
| `解压失败：tar / unzip / Expand-Archive 均不可用` | 系统里没有能解 zip 的工具 | 装 `unzip`，或确认 Windows 的 `System32\tar.exe` 还在 |
| `在 <repo>@<ref> 里找不到 <path>` | `path` 在这个 ref 下不存在 | 核对仓库里的实际路径。command/agent 的 `.md` 可省略 |
| `目标路径越界，拒绝写入（<dir>）` | 目标路径算出到目录外面了 | 正常情况下不会触发，是 `id` 校验的第二道防线；检查 `id` |
| `无法移动 xxx（可能被占用），保留在原地` | 文件被别的进程锁着 | 关掉占用它的进程再跑一次 |
| `配置 hooks 失败: <settings.json> 不是合法 JSON: ...` | settings.json 坏了 | 组件已装好，只需修 settings.json 后重跑 |
| `<组> 目标目录存在配置之外的文件: ...` | 目录里有配置外的东西 | 通常是没用本脚本清的目录，或用了 `--no-clear`；手动清掉 |

---

## 为什么不用 npm 安装器

ECC 的 npm 安装器（`ecc-universal`）即使只装单个 skill，也会连带装入 `commands-core`，把 **90+ 个斜杠命令**写进 `~/.claude/commands`。Claude Code 会把命令当 skill 暴露出来，`/skills` 里冒出一堆并不需要的条目。

这个脚本的 commands 只来自配置文件 —— **装什么就是什么**。

---

## 安全须知

**已经做了什么防护**

- `id` 白名单校验 + 目标路径越界检查（第二道防线），杜绝「配置里写 `../../..` 就把用户目录递归删掉」这类路径穿越
- `path` 白名单校验，杜绝「读检出目录之外的文件」
- `local` 的形态按分组校验，杜绝「拿文件当目录树」把安装搞崩
- 下载内容校验 zip 魔数（`PK`），拦住代理返回的 HTML 错误页
- **配置校验发生在任何写盘之前**，配置有错时一个文件都不会动
- **下载全部在动手之前完成**，下载失败时本机目录原样不动
- hook 只在 `observe.sh` 真的存在时才注册，不留悬空引用

**仍需注意**

- **默认代理是第三方**（`https://proxy.vvvv.ee/`），直连失败会自动降级到它。代理能看到并篡改下载内容，而 zip 只校验了魔数，没有 checksum 校验。用 `--proxy ""` 关掉，或换成你信得过的。
- **ref 最好是固定版本**。`main` 这类分支 ref 是可变的，上游一次投毒就会静默进到本机。生产环境建议用 tag 或 commit SHA。
- 下载的 skill 里可能带 hooks（脚本本身就在注册 observe.sh），而 Claude Code 会执行它们 —— **装一个 skill 等于给它执行权限**。装之前先看一眼内容。
- `local` 允许指向配置目录之外的绝对路径（这是显式本地覆盖的用途）。想锁死在配置同目录内可以自己加约束。

---

## 常见任务速查

```bash
# 只装 agents（不动 skills / commands）
node install-skills.mjs --no-skills --no-commands

# 装到当前项目而不是全局
node install-skills.mjs --target claude-project

# 离线装（所有组件都有 local 覆盖时）
node install-skills.mjs --no-download

# 不走代理
node install-skills.mjs --proxy ""

# 只看不改
node install-skills.mjs --dry-run

# 保留目录里的旧文件，只覆盖安装
node install-skills.mjs --no-clear
```
# cc-develop
