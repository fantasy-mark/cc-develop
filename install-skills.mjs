#!/usr/bin/env node
/**
 * install-skills.mjs — 按配置文件把 skills / commands / agents 从 GitHub 安装到 ~/.claude。
 *
 * 用法
 *   node install-skills.mjs                # 按 install.config.json 全量安装（清空重装）
 *   node install-skills.mjs --dry-run      # 只演练，不写任何文件
 *   node install-skills.mjs --config <path>
 *
 * 参数
 *   --config <path>    配置文件，默认脚本同目录的 install.config.json
 *   --target <id>      claude（默认，装到 ~/.claude）| claude-project（装到 ./.claude）
 *   --proxy <url>      GitHub 下载的备用代理，默认 https://proxy.vvvv.ee/（直连失败时才用）
 *   --cache-dir <dir>  GitHub 检出解压后的存放目录，默认 ~/.claude/cache/skill-sources
 *   --no-download      禁止联网
 *   --no-clear         不清空目标目录，直接覆盖安装
 *   --no-skills        跳过 skills（只装 commands / agents）
 *   --no-commands      跳过 commands
 *   --no-agents        跳过 agents
 *   --dry-run          只演练，不写任何文件
 *
 * 配置文件：install.config.json 是唯一真源
 *   三类组件每条记录写明「从哪个仓库的哪个 ref 的哪个 path 取，装到本机叫什么」：
 *
 *   {
 *     "skills":   [{ "id": "pptx", "repo": "anthropics/skills", "ref": "main", "path": "skills/pptx" }],
 *     "commands": [{ "id": "code-review", "repo": "affaan-m/ECC", "ref": "v2.2.3", "path": "commands/code-review.md" }],
 *     "agents":   [{ "id": "code-reviewer", "repo": "affaan-m/ECC", "ref": "v2.2.3", "path": "agents/code-reviewer.md" }]
 *   }
 *
 *   id    装到本机后的名字：skills 用作目录名，commands/agents 用作文件名（自动补 .md）
 *         直接拼进 ~/.claude/<组>/<id>，只允许字母数字和 . _ -，不许带路径分隔符
 *   repo  owner/name
 *   ref   tag / branch / commit SHA（按 tag → branch → SHA 依次尝试）
 *   path  仓库内相对路径；skill 写目录，command/agent 写文件（.md 可省略）
 *         会拼进检出目录，不许带 .. 段或绝对路径
 *   local 可选。指向配置同目录下的本地路径，存在时优先用它 —— 给「官方版本 + 本地微调」留口子
 *         skill 的 local 必须是目录，command/agent 的 local 必须是文件；类型不对直接报配置错误
 *
 * 安装方式：全部来自 GitHub，本机不作为来源
 *   按 ref 下载仓库 zip，解压后按 path 拷贝。直连 GitHub 优先，失败再走代理；
 *   每次运行都重新下载，不复用本机缓存的检出目录，也不从历史备份还原。
 *
 *   不用 npm 安装器 —— ecc-universal 即使只装单个 skill，也会连带装入 commands-core，
 *   把 90+ 个斜杠命令写进 ~/.claude/commands。Claude Code 会把命令当 skill 暴露出来，
 *   /skills 里会冒出一堆并不需要的条目。现在 commands 来自配置，装什么就是什么。
 *
 * 清空重装
 *   skills / commands / agents 三个目录都是「先备份、再清空、再按配置写回」，
 *   保证本机目录与配置文件严格一致。备份留在 <目录>.backup-<时间戳>。
 *
 * 退出码：0 = 全部校验通过；1 = 有安装或校验失败。
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const DEFAULT_PROXY = 'https://proxy.vvvv.ee/';
const DEFAULT_CONFIG_FILE = 'install.config.json';

/** 组件分组：与配置文件的顶层键一一对应 */
const GROUPS = ['skills', 'commands', 'agents'];

/** commands / agents 都是 Markdown 文件 */
const COMPONENT_EXT = '.md';

/**
 * 组件 id 的合法形态。
 * id 会被直接拼进目标路径（~/.claude/skills/<id>），校验太松等于开了路径穿越的口子：
 * id = "../../.." 能让安装脚本递归删掉整个用户目录。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 单个组件的安装位置（相对 ~/.claude） */
const GROUP_DIRS = {
  skills: 'skills',
  commands: 'commands',
  agents: 'agents',
};

// ---------------------------------------------------------------------------
// 输出 helpers
// ---------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const log = (...args) => console.log(`${C.cyan}[install-skills]${C.reset}`, ...args);
const warn = (...args) => console.error(`${C.yellow}[install-skills][WARN]${C.reset}`, ...args);
const fail = (...args) => console.error(`${C.red}[install-skills][FAIL]${C.reset}`, ...args);
const ok = (...args) => console.log(`${C.green}[install-skills][OK]${C.reset}`, ...args);

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    target: 'claude',
    proxy: DEFAULT_PROXY,
    allowDownload: true,
    clear: true,
    dryRun: false,
    help: false,
    configPath: path.join(path.dirname(fileURLToPath(import.meta.url)), DEFAULT_CONFIG_FILE),
    cacheDir: path.join(os.homedir(), '.claude', 'cache', 'skill-sources'),
    groups: [...GROUPS],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        fail(`选项 ${arg} 缺少参数`);
        process.exit(1);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case '--config': options.configPath = path.resolve(next()); break;
      case '--target': options.target = next(); break;
      case '--proxy': options.proxy = next(); break;
      case '--cache-dir': options.cacheDir = path.resolve(next()); break;
      case '--no-download': options.allowDownload = false; break;
      case '--no-clear': options.clear = false; break;
      case '--no-skills': options.groups = options.groups.filter(g => g !== 'skills'); break;
      case '--no-commands': options.groups = options.groups.filter(g => g !== 'commands'); break;
      case '--no-agents': options.groups = options.groups.filter(g => g !== 'agents'); break;
      case '--dry-run': options.dryRun = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default:
        fail(`未知参数: ${arg}`);
        usage();
        process.exit(1);
    }
  }
  return options;
}

function usage() {
  console.log(`
用法
  node install-skills.mjs [--config <path>] [--target claude|claude-project]
                         [--proxy <url>] [--cache-dir <dir>] [--no-download]
                         [--no-clear] [--no-skills] [--no-commands] [--no-agents]
                         [--dry-run]

组件来源（全部来自 GitHub，本机不作为来源）
  ECC 5 个      github.com/affaan-m/ECC      @ v2.2.3
  官方 3 个     github.com/anthropics/skills @ main
  按 ref 下载仓库 zip → 解压 → 按 path 拷贝。直连优先，失败再走代理。
  不走 npm 安装器 —— 那会连带装入 commands-core，把 90+ 个 ECC 命令写进
  ~/.claude/commands，Claude Code 会把它们当 skill 展示，/skills 里全是多余的。

清空重装（先备份，再清空，再按配置写回）
  --config       配置文件，默认脚本同目录的 ${DEFAULT_CONFIG_FILE}
  --source-root  已废弃（组件不再从本机目录取）
  --no-skills    跳过 skills（只装 commands / agents）
  --no-commands  跳过 commands
  --no-agents    跳过 agents
  --no-clear     不清空目标目录，直接覆盖安装

其它
  --target       安装目标，默认 claude（~/.claude），可选 claude-project
  --proxy        GitHub 下载的备用代理，默认 ${DEFAULT_PROXY}（直连失败时才用）
  --cache-dir    GitHub 检出解压后的存放目录，默认 ~/.claude/cache/skill-sources
  --no-download  禁止联网（组件都要从 GitHub 下载，会直接失败）
  --dry-run      只演练，不写任何文件

退出码
  0 = 全部校验通过   1 = 有安装或校验失败
`);
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
const isDir = p => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = p => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * 把若干段拼到 base 下面，并确认结果仍在 base 内部。
 * 配置里的 id / path 已经过了白名单校验，这里是第二道防线：
 * 将来新增拼接分支时，也不会写到 base 外面去。越界时返回 ''，调用方按失败处理。
 */
function resolveInside(base, ...segments) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return '';
  return target;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function timestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

const sha256 = filePath =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const sha256Normalized = filePath =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

function listFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (isDir(root)) walk(root);
  return out;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return data;
}

/**
 * 递归拷贝目录树。
 * normalize=true 时把文本文件的 CRLF 规范化为 LF：Windows 上 core.autocrlf=true 的
 * 检出里 *.sh 是 CRLF，直接拷会让 hooks 脚本报 "$'\r': command not found"。
 * normalize=false 时保持字节原样（用于「还原」官方 skill）。
 * 返回被规范化的文件数。
 */
function copyTree(src, dest, { normalize = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  let normalized = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      normalized += copyTree(source, target, { normalize });
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (entry.isFile()) {
      const buffer = fs.readFileSync(source);
      if (!normalize || buffer.includes(0)) {
        fs.writeFileSync(target, buffer); // 二进制或不需要规范化：原样保留
      } else {
        // 用 latin1 做字节级替换，避免破坏非 UTF-8 序列
        const text = buffer.toString('latin1').replace(/\r\n/g, '\n');
        if (text.length !== buffer.length) normalized += 1;
        fs.writeFileSync(target, Buffer.from(text, 'latin1'));
      }
    }
  }
  return normalized;
}

/**
 * 比对两个文件：
 *   identical   字节一致
 *   identical*  仅 CRLF/LF 行尾差异
 *   differs     内容不一致
 *   no-source   没有可比对的来源
 */
function compareFiles(left, right) {
  if (!isFile(left) || !isFile(right)) return 'no-source';
  if (sha256(left) === sha256(right)) return 'identical';
  if (sha256Normalized(left) === sha256Normalized(right)) return 'identical*';
  return 'differs';
}

/**
 * 比对两棵目录树：
 *   identical   字节一致
 *   identical*  仅 CRLF/LF 行尾差异
 *   differs     内容不一致
 *   no-source   没有可比对的来源
 */
function compareTrees(left, right) {
  if (!left || !right || !isDir(left) || !isDir(right)) return 'no-source';
  const leftFiles = listFiles(left).map(f => path.relative(left, f)).sort();
  const rightFiles = listFiles(right).map(f => path.relative(right, f)).sort();
  if (leftFiles.join('|') !== rightFiles.join('|')) return 'differs';
  let crlfOnly = false;
  for (const rel of leftFiles) {
    const leftFile = path.join(left, rel);
    const rightFile = path.join(right, rel);
    if (sha256(leftFile) === sha256(rightFile)) continue;
    if (sha256Normalized(leftFile) === sha256Normalized(rightFile)) {
      crlfOnly = true;
      continue;
    }
    return 'differs';
  }
  return crlfOnly ? 'identical*' : 'identical';
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
/**
 * 读配置文件并归一化成一张「组件清单」表。
 *
 * 归一化做的事：
 *   - 校验 id / repo / ref / path 齐备，repo 必须是 owner/name
 *   - id 只允许字母数字和 . _ -，path 只允许仓库内的相对路径 —— 两者都会被拼进
 *     文件系统路径，放开就等于允许写到目标目录之外
 *   - path 统一成正斜杠相对路径；local 解析成绝对路径（相对配置文件所在目录）
 *   - local 的形态按分组校验：skill 要目录，command/agent 要文件
 *   - 同一分组内 id 重复直接报错 —— 两个条目装到同一个目标名会互相覆盖
 */
function loadConfig(configPath) {
  if (!isFile(configPath)) {
    fail(`配置文件不存在: ${configPath}`);
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    fail(`配置文件不是合法 JSON (${configPath}): ${error.message}`);
    return null;
  }

  const baseDir = path.dirname(configPath);
  const items = [];
  const seen = new Map();

  for (const group of GROUPS) {
    const list = Array.isArray(raw[group]) ? raw[group] : [];
    for (const entry of list) {
      const problems = [];
      if (!entry || typeof entry !== 'object') {
        fail(`${group} 配置项不是对象: ${JSON.stringify(entry)}`);
        return null;
      }
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const repo = typeof entry.repo === 'string' ? entry.repo.trim() : '';
      const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
      const relPath = typeof entry.path === 'string' ? entry.path.trim() : '';

      if (!id) problems.push('缺少 id');
      else if (!ID_RE.test(id)) {
        problems.push(`id 只能包含字母数字和 . _ -（收到 ${id}）`);
      } else if (/[. ]$/.test(id)) {
        problems.push(`id 不能以 . 或空格结尾（收到 ${id}）`);
      }

      if (!/^[^/\\]+\/[^/\\]+$/.test(repo)) problems.push(`repo 应为 owner/name（收到 ${repo}）`);
      if (!ref) problems.push('缺少 ref');
      if (!relPath) problems.push('缺少 path');
      else {
        if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
          problems.push(`path 必须是仓库内的相对路径（收到 ${relPath}）`);
        }
        if (relPath.split(/[\\/]+/).some(segment => segment === '..')) {
          problems.push(`path 不能包含 .. 段（收到 ${relPath}）`);
        }
      }

      // local 覆盖：形态按分组校验。skill 要整棵目录树，command/agent 要单个文件。
      // 类型不对必须报错 —— 拿一个文件当目录树拷贝会 ENOTDIR 崩掉整个安装，
      // 而静默退回远端更糟：用户以为覆盖生效了，其实没有。
      let local = '';
      let localUsable = false;
      if (typeof entry.local === 'string' && entry.local.trim()) {
        local = path.resolve(baseDir, entry.local.trim());
        if (isDir(local)) {
          if (group === 'skills') localUsable = true;
          else problems.push(`local 对 ${group} 必须是文件（收到 ${entry.local}）`);
        } else if (isFile(local)) {
          if (group === 'skills') problems.push(`local 对 skill 必须是目录（收到 ${entry.local}）`);
          else localUsable = true;
        } else {
          // 不存在不算配置错误：按文档「存在时优先用它」退回远端下载
          warn(`${group}/${id}: local 不存在，回退到远端下载 (${entry.local})`);
        }
      }

      if (problems.length > 0) {
        fail(`${group} 配置项无效 (${JSON.stringify(entry)}): ${problems.join('; ')}`);
        return null;
      }

      const key = `${group}:${id}`;
      if (seen.has(key)) {
        fail(`配置里 ${group} 的 id 重复: ${id}`);
        return null;
      }
      seen.set(key, true);

      items.push({
        kind: group,
        id,
        repo,
        ref,
        path: relPath.split(/[\\/]+/).join('/'),
        local,
        localUsable,
      });
    }
  }

  if (items.length === 0) {
    warn('配置文件里没有任何组件');
  }
  return { configPath, baseDir, items };
}

// ---------------------------------------------------------------------------
// GitHub 检出
// ---------------------------------------------------------------------------
/**
 * 仓库 ref → zip 下载地址候选（tag → branch → 原始 ref/SHA）。
 * 顺序有意义：tag 与 branch 重名时优先按 tag 解析。
 *
 * 走 codeload.github.com 而不是 github.com/.../archive：
 * Node 的 fetch 连 github.com 会 10 秒 connect timeout（curl 走同一条路却是通的，
 * 大概是解析/握手路径不同），codeload 没有这个问题。
 */
function archiveUrlCandidates(repo, ref) {
  return [
    `https://codeload.github.com/${repo}/zip/refs/tags/${ref}`,
    `https://codeload.github.com/${repo}/zip/refs/heads/${ref}`,
    `https://codeload.github.com/${repo}/zip/${ref}`,
  ];
}

/**
 * 下载地址候选：直连优先，全部失败再走代理。
 * 代理是「前缀」而不是 URL base —— 不能用 new URL(url, proxy)，绝对 URL 会直接丢掉 base。
 */
function downloadCandidates(urls, proxy) {
  const direct = [...urls];
  if (!proxy) return direct;
  const viaProxy = urls.map(url => `${proxy.replace(/\/+$/, '')}/${url}`);
  return [...direct, ...viaProxy];
}

/**
 * 解压 zip。Windows 自带的 bsdtar 支持 zip；其余平台用 unzip。
 * 两者都不可用时退回 PowerShell Expand-Archive。
 */
function extractZip(zipPath, destDir) {
  const attempts = [];

  if (process.platform === 'win32') {
    const systemTar = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'tar.exe',
    );
    if (isFile(systemTar)) {
      attempts.push({ command: systemTar, args: ['-xf', zipPath, '-C', destDir] });
    }
  }
  attempts.push({ command: 'unzip', args: ['-q', '-o', zipPath, '-d', destDir] });
  attempts.push({ command: 'tar', args: ['-xf', zipPath, '-C', destDir] });
  if (process.platform === 'win32') {
    attempts.push({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
    });
  }

  for (const attempt of attempts) {
    const result = run(attempt.command, attempt.args, { stdio: 'pipe' });
    if (result.status === 0) return true;
  }
  return false;
}

/** 下载仓库 zip 并解压，返回检出根目录 */
async function downloadRepoCheckout({ repo, ref, destParent, proxy }) {
  const errors = [];

  for (const url of downloadCandidates(archiveUrlCandidates(repo, ref), proxy)) {
    log(`下载 ${repo}@${ref}: ${url}`);
    let zipPath = '';
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const safeRef = ref.replace(/[^\w.-]+/g, '_');
      zipPath = path.join(destParent, `${repo.replace('/', '-')}-${safeRef}-${Date.now()}.zip`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));

      // zip magic: "PK"
      const magic = Buffer.alloc(2);
      const fd = fs.openSync(zipPath, 'r');
      fs.readSync(fd, magic, 0, 2, 0);
      fs.closeSync(fd);
      if (magic.toString('latin1') !== 'PK') {
        throw new Error('下载内容不是有效的 zip（可能被代理拦截）');
      }

      const extractDir = `${zipPath}.d`;
      fs.mkdirSync(extractDir, { recursive: true });
      if (!extractZip(zipPath, extractDir)) {
        throw new Error('解压失败：tar / unzip / Expand-Archive 均不可用');
      }
      fs.rmSync(zipPath, { force: true });

      // 归档顶层只有一个目录（repo-ref），它就是检出根
      const dirs = fs
        .readdirSync(extractDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory());
      if (dirs.length === 1) return path.join(extractDir, dirs[0].name);
      if (dirs.length === 0) throw new Error('解压后没有顶层目录');
      throw new Error(`解压后顶层目录数异常（${dirs.length}）`);
    } catch (error) {
      errors.push(`${url} → ${error.message}`);
      if (zipPath) fs.rmSync(zipPath, { force: true });
    }
  }

  throw new Error(errors.join('；'));
}

/**
 * 把清单涉及的仓库各下载一份，返回 { [repo@ref]: 检出根目录 }。
 *
 * 必须在动本机目录之前完成：下载失败就整体中止，
 * 免得网络抖动把已经装好的 skills 掏空。
 */
async function resolveCheckouts(items, options) {
  const needed = new Map();
  for (const item of items) {
    if (item.localUsable) continue; // 本地覆盖，不用下载
    const key = `${item.repo}@${item.ref}`;
    if (!needed.has(key)) needed.set(key, { repo: item.repo, ref: item.ref });
  }

  const destParent = path.join(options.cacheDir, `install-${timestamp()}`);
  fs.mkdirSync(destParent, { recursive: true });

  const checkouts = new Map();
  for (const [key, { repo, ref }] of needed) {
    try {
      const checkout = await downloadRepoCheckout({
        repo,
        ref,
        destParent,
        proxy: options.proxy,
      });
      log(`检出就绪 ${key} → ${checkout}`);
      checkouts.set(key, checkout);
    } catch (error) {
      fail(`下载 ${key} 失败: ${error.message}`);
      return null;
    }
  }
  return { checkouts, destParent };
}

/**
 * 找到条目在检出里的实际路径。
 * 目录（skill）按 path 原样；文件（command/agent）允许省略 .md。
 */
function resolveItemSource(item, checkout) {
  if (!checkout) return '';
  const base = resolveInside(checkout, ...item.path.split('/'));
  if (!base) return '';
  if (isFile(base)) return base;
  if (isFile(`${base}${COMPONENT_EXT}`)) return `${base}${COMPONENT_EXT}`;
  if (isDir(base) && isFile(path.join(base, 'SKILL.md'))) return base;
  return '';
}

// ---------------------------------------------------------------------------
// 备份 / 清空
// ---------------------------------------------------------------------------
/** 备份目录名去重：同一秒内跑两次不会互相覆盖 */
function uniqueBackupDir(base) {
  const stamp = timestamp();
  let candidate = `${base}.backup-${stamp}`;
  let n = 1;
  while (isDir(candidate)) {
    candidate = `${base}.backup-${stamp}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * 备份并清空一个目录。
 * 逐个子项 rename：Windows 上父目录句柄常被占用，整体 rename 会 Permission denied。
 */
function backupAndClearDir(dir, { dryRun, label }) {
  if (!isDir(dir)) {
    if (!dryRun) fs.mkdirSync(dir, { recursive: true });
    return '';
  }
  const backupDir = uniqueBackupDir(dir);
  if (dryRun) {
    log(`[dry-run] 将清空 ${dir} 并备份到 ${backupDir}`);
    return backupDir;
  }

  log(`备份现有 ${label} → ${backupDir}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const child of fs.readdirSync(dir)) {
    const from = path.join(dir, child);
    const to = path.join(backupDir, child);
    try {
      fs.renameSync(from, to);
    } catch {
      warn(`  无法移动 ${child}（可能被占用），保留在原地`);
    }
  }
  return backupDir;
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------
/** observe.sh 钩子随 continuous-learning-v2 这个 skill 一起装 */
const OBSERVE_SKILL_ID = 'continuous-learning-v2';
const OBSERVE_HOOK_REL = 'hooks/observe.sh';

const normalizeSlashes = p => p.replace(/\\/g, '/');

/**
 * 钩子命令。
 * 默认目标（~/.claude）保持原来的 ~ 写法 —— hook 命令由 shell 执行，~ 能被展开；
 * claude-project 目标没有 home 可用，给绝对路径（正斜杠，Git Bash / sh 都能跑）。
 */
function hookCommand(claudeHome) {
  const defaultHome = path.join(os.homedir(), '.claude');
  if (path.resolve(claudeHome) === path.resolve(defaultHome)) {
    return `~/.claude/${GROUP_DIRS.skills}/${OBSERVE_SKILL_ID}/${OBSERVE_HOOK_REL}`;
  }
  return normalizeSlashes(
    path.join(claudeHome, GROUP_DIRS.skills, OBSERVE_SKILL_ID, ...OBSERVE_HOOK_REL.split('/')),
  );
}

/**
 * 幂等地写入 observe.sh 钩子 + PYTHONUTF8=1。
 *
 * 只在 observe.sh 真的存在时才注册 —— skill 没装却留下钩子，指向的脚本不存在，
 * 每次工具调用都会报错。
 *
 * 解析失败抛错而不是 process.exit：settings.json 坏了不该把已经装好的组件打成半成品，
 * 也不该跳过收尾（备份目录提示 + 检出缓存清理）。
 */
function configureHooks(settingsFile, claudeHome) {
  const command = hookCommand(claudeHome);
  const observeScript = path.join(
    claudeHome,
    GROUP_DIRS.skills,
    OBSERVE_SKILL_ID,
    ...OBSERVE_HOOK_REL.split('/'),
  );
  const observeInstalled = isFile(observeScript);

  let settings = {};
  if (isFile(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      throw new Error(`${settingsFile} 不是合法 JSON: ${error.message}`);
    }
  }

  // 命令里可能有反斜杠（Windows 绝对路径），比对前统一成正斜杠
  const isObserveHook = entry =>
    typeof entry.command === 'string' &&
    normalizeSlashes(entry.command).includes(`${OBSERVE_SKILL_ID}/${OBSERVE_HOOK_REL}`);
  const strip = list =>
    (Array.isArray(list) ? list : []).filter(group => {
      if (!group || !Array.isArray(group.hooks)) return true;
      const kept = group.hooks.filter(hook => !isObserveHook(hook));
      if (kept.length === group.hooks.length) return true;
      group.hooks = kept;
      return kept.length > 0;
    });

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const before = JSON.stringify(settings.hooks || {});
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const groups = strip(hooks[event]);
    if (!observeInstalled) {
      // 没装 observe skill：把旧的 observe 钩子摘掉，别留悬空引用
      if (groups.length > 0) hooks[event] = groups;
      else delete hooks[event];
      continue;
    }
    groups.push({ matcher: '*', hooks: [{ type: 'command', command }] });
    hooks[event] = groups;
  }
  settings.hooks = hooks;

  // Python 脚本（skill-creator / continuous-learning-v2 等）用 read_text() 不带 encoding，
  // 在非 UTF-8 locale 的 Windows 上默认按 GBK 解码 → UnicodeDecodeError。
  // 打开 PYTHONUTF8 让 Python 3.7+ 统一用 UTF-8，无副作用。
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const hadPythonUtf8 = Object.prototype.hasOwnProperty.call(env, 'PYTHONUTF8');
  const beforePythonUtf8 = env.PYTHONUTF8;
  if (!hadPythonUtf8 || env.PYTHONUTF8 !== '1') env.PYTHONUTF8 = '1';
  settings.env = env;

  const after = JSON.stringify(settings.hooks || {});
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (isFile(settingsFile)) {
    fs.writeFileSync(`${settingsFile}.bak-${Date.now()}`, fs.readFileSync(settingsFile));
  }
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  if (!observeInstalled) {
    ok(`未安装 ${OBSERVE_SKILL_ID}，不注册 observe.sh 钩子`);
  } else if (before === after) {
    ok(`hooks 已存在且一致: ${command}`);
  } else {
    ok(`已注册 PreToolUse/PostToolUse → ${command}`);
  }
  if (hadPythonUtf8 && beforePythonUtf8 === '1') ok('PYTHONUTF8=1 已就位');
  else ok('已设置 PYTHONUTF8=1（修复 Windows 非 UTF-8 locale 下 Python 脚本的 GBK 解码错误）');
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
/**
 * 校验一个分组：每个配置项都应落到目标目录且与来源一致，
 * 目标目录里也不该出现配置之外的文件（清空重装后应与配置严格相等）。
 */
function verifyGroup(group, dir, groupItems, sources, { dryRun }) {
  const rows = [];
  let failed = 0;

  for (const item of groupItems) {
    const source = sources.get(item.id) || '';
    const problems = [];

    if (group === 'skills') {
      const target = path.join(dir, item.id);
      const skillFile = path.join(target, 'SKILL.md');
      if (!isDir(target)) problems.push('目录缺失');
      if (!isFile(skillFile)) problems.push('SKILL.md 缺失');

      if (isFile(skillFile)) {
        const text = fs.readFileSync(skillFile, 'utf8');
        if (!text.trim()) problems.push('SKILL.md 为空');
        const frontmatter = parseFrontmatter(text);
        if (!frontmatter) problems.push('缺少 YAML frontmatter');
        else {
          if (!frontmatter.name) problems.push('frontmatter 缺少 name');
          else if (frontmatter.name !== item.id) {
            problems.push(`frontmatter name=${frontmatter.name} 与 id ${item.id} 不一致`);
          }
          if (!frontmatter.description) problems.push('frontmatter 缺少 description');
        }
      }

      const sourceStatus = source ? compareTrees(source, target) : 'no-source';
      if (sourceStatus === 'differs') problems.push('与来源内容不一致');
      if (sourceStatus === 'no-source' && !dryRun) problems.push('无法比对来源');

      // dry-run 不写文件，「尚未落盘」属于预期状态，记为 SKIP 而非 FAIL
      const skipped = dryRun && !isDir(target);
      const status = skipped ? 'SKIP' : problems.length === 0 ? 'PASS' : 'FAIL';
      if (status === 'FAIL') failed += 1;
      rows.push({ id: item.id, status, count: listFiles(target).length, sourceStatus, problems });
    } else {
      const target = path.join(dir, `${item.id}${COMPONENT_EXT}`);
      const sourceStatus = compareFiles(source, target);
      if (!isFile(target)) problems.push('目标缺失');
      else if (sourceStatus === 'differs') problems.push('与来源内容不一致');

      if (isFile(target)) {
        const text = fs.readFileSync(target, 'utf8');
        if (!text.trim()) problems.push('文件为空');
        const frontmatter = parseFrontmatter(text);
        if (!frontmatter) problems.push('缺少 YAML frontmatter');
        else {
          if (group === 'agents') {
            if (!frontmatter.name) problems.push('frontmatter 缺少 name');
            else if (frontmatter.name !== item.id) {
              problems.push(`frontmatter name=${frontmatter.name} 与 id ${item.id} 不一致`);
            }
          }
          if (!frontmatter.description) problems.push('frontmatter 缺少 description');
        }
      }

      const skipped = dryRun && !isFile(target);
      const status = skipped ? 'SKIP' : problems.length === 0 ? 'PASS' : 'FAIL';
      if (status === 'FAIL') failed += 1;
      rows.push({ id: `${item.id}${COMPONENT_EXT}`, status, count: 1, sourceStatus, problems });
    }
  }

  // 目标目录里多出来的文件（点文件不算组件）
  const expected = new Set(
    groupItems.flatMap(item =>
      group === 'skills'
        ? listFiles(path.join(dir, item.id)).map(f => path.relative(dir, f))
        : [`${item.id}${COMPONENT_EXT}`],
    ),
  );
  const extras = isDir(dir)
    ? listFiles(dir)
        .map(file => path.relative(dir, file))
        .filter(rel => !expected.has(rel) && !path.basename(rel).startsWith('.'))
    : [];

  const width = Math.max(8, ...rows.map(row => row.id.length)) + 2;
  console.log('');
  console.log(`  ${group.toUpperCase()} → ${dir}`);
  console.log(`  ${'NAME'.padEnd(width)}STATUS  FILES  SOURCE     NOTES`);
  console.log(`  ${'-'.repeat(width + 42)}`);
  for (const row of rows) {
    let notes = row.problems.length ? row.problems.join('; ') : 'ok';
    if (row.status === 'SKIP') notes = 'dry-run 未写入，实跑后校验';
    const badge = row.status === 'PASS' ? 'PASS  ' : row.status === 'SKIP' ? 'SKIP  ' : 'FAIL  ';
    console.log(
      `  ${row.id.padEnd(width)}${badge}${String(row.count).padStart(5)}  ${row.sourceStatus.padEnd(10)}  ${notes}`,
    );
  }
  console.log('');

  if (extras.length > 0) {
    warn(`${group} 目标目录存在配置之外的文件: ${extras.join(' ')}`);
  }
  return failed;
}

/**
 * 清理旧的检出缓存：只留最近几次的目录。
 * ECC 检出解压后有几百 MB，跑一次留一次很快会把磁盘塞满。
 */
const KEEP_CACHE_RUNS = 2;

function pruneCache(cacheDir, { keep = KEEP_CACHE_RUNS } = {}) {
  if (!isDir(cacheDir)) return 0;
  const runs = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('install-'))
    .map(entry => entry.name)
    .sort();
  const stale = runs.slice(0, Math.max(0, runs.length - keep));
  for (const name of stale) {
    try {
      fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
    } catch (error) {
      warn(`无法清理缓存 ${name}: ${error.message}`);
    }
  }
  if (stale.length > 0) log(`清理旧检出缓存 ${stale.length} 个（保留最近 ${keep} 次）`);
  return stale.length;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (options.target !== 'claude' && options.target !== 'claude-project') {
    fail(`--target 只能是 claude 或 claude-project（收到: ${options.target}）`);
    return 1;
  }

  const claudeHome =
    options.target === 'claude'
      ? path.join(os.homedir(), '.claude')
      : path.join(process.cwd(), '.claude');
  const settingsFile = path.join(claudeHome, 'settings.json');

  log(`target   = ${options.target} (${claudeHome})`);
  log(`config   = ${options.configPath}`);

  // 1. 读配置
  const config = loadConfig(options.configPath);
  if (!config) return 1;

  const groups = GROUPS.filter(group => options.groups.includes(group));
  const items = config.items.filter(item => groups.includes(item.kind));
  for (const group of groups) {
    const count = items.filter(item => item.kind === group).length;
    log(`${group.padEnd(9)} = ${count} 项`);
  }

  // 2. 先把 GitHub 检出准备好 —— 下载失败就整体中止，不动本机任何目录
  let resolved = { checkouts: new Map(), destParent: '' };
  const needDownload = items.some(item => !item.localUsable);
  if (needDownload) {
    if (!options.allowDownload) {
      fail('需要从 GitHub 下载，但指定了 --no-download');
      return 1;
    }
    log('--- 准备 GitHub 检出 ---');
    resolved = await resolveCheckouts(items, options);
    if (!resolved) {
      fail('GitHub 检出准备失败，本机目录未做任何改动');
      return 1;
    }
  } else {
    log('--- 全部组件都有本地覆盖，无需下载 ---');
  }

  // 3. 逐组清空重装
  let installFailed = false;
  const sources = new Map();
  const backups = [];

  for (const group of groups) {
    const groupItems = items.filter(item => item.kind === group);
    const dir = path.join(claudeHome, GROUP_DIRS[group]);

    log(`--- 安装 ${group} ---`);
    if (options.clear) {
      const backupDir = backupAndClearDir(dir, { dryRun: options.dryRun, label: group });
      if (backupDir) backups.push(backupDir);
    } else {
      log(`[${options.dryRun ? 'dry-run ' : ''}]不清空 ${dir}，直接覆盖安装`);
    }

    for (const item of groupItems) {
      const checkout = resolved.checkouts.get(`${item.repo}@${item.ref}`);
      const source = item.localUsable ? item.local : resolveItemSource(item, checkout);
      if (!source) {
        fail(`${group}/${item.id}: 在 ${item.repo}@${item.ref} 里找不到 ${item.path}`);
        installFailed = true;
        continue;
      }
      sources.set(`${group}:${item.id}`, source);

      const origin = item.localUsable ? '本地覆盖' : `${item.repo}@${item.ref}`;
      // 目标路径必须落在本组目录内 —— id 已在配置校验里过了白名单，这里再兜一层
      const target =
        group === 'skills'
          ? resolveInside(dir, item.id)
          : resolveInside(dir, `${item.id}${COMPONENT_EXT}`);
      if (!target) {
        fail(`${group}/${item.id}: 目标路径越界，拒绝写入（${dir}）`);
        installFailed = true;
        continue;
      }

      if (options.dryRun) {
        log(`[dry-run] install ${group}/${item.id} ← ${origin}: ${source}`);
        continue;
      }

      if (group === 'skills') {
        fs.rmSync(target, { recursive: true, force: true });
        const normalized = copyTree(source, target, { normalize: true });
        log(`install ${group}/${item.id} ← ${origin}`);
        if (normalized > 0) log(`  行尾规范化：${normalized} 个文件 CRLF → LF`);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(source, target);
        log(`install ${group}/${item.id} ← ${origin}`);
      }
    }
  }

  // 4. hooks 设置
  log('--- 配置 hooks ---');
  let hooksFailed = false;
  if (options.dryRun) {
    log(
      `[dry-run] 将幂等地写入 ${settingsFile} 的 PreToolUse/PostToolUse observe.sh 钩子 + PYTHONUTF8=1（observe.sh 已安装时才注册）`,
    );
  } else {
    try {
      configureHooks(settingsFile, claudeHome);
    } catch (error) {
      // 不能在这里 exit：组件已经装好了，直接退出会跳过收尾（备份目录提示 + 检出缓存清理）
      fail(`配置 hooks 失败: ${error.message}`);
      hooksFailed = true;
    }
  }

  // 5. 校验
  log('--- 校验安装结果 ---');
  let verifyFailed = 0;
  for (const group of groups) {
    const groupItems = items.filter(item => item.kind === group);
    const dir = path.join(claudeHome, GROUP_DIRS[group]);
    const groupSources = new Map(
      groupItems.map(item => [item.id, sources.get(`${group}:${item.id}`) || '']),
    );
    verifyFailed += verifyGroup(group, dir, groupItems, groupSources, { dryRun: options.dryRun });
  }
  console.log('');
  console.log('  SOURCE: identical=字节一致  identical*=仅 CRLF/LF 行尾差异  differs=内容不一致  no-source=无可比对来源');
  console.log('');

  // 6. 收尾
  if (options.dryRun) {
    log('[dry-run] 结束，未写入任何文件');
    return verifyFailed || (installFailed || hooksFailed ? 1 : 0);
  }

  console.log('');
  if (backups.length) {
    log(`备份目录：${backups.join('  ')}`);
  }
  if (resolved.destParent) {
    log(`GitHub 检出缓存：${resolved.destParent}`);
    pruneCache(options.cacheDir);
  }
  log('下一步：重启 Claude Code 后新 skill / command / agent 才会生效');
  return verifyFailed || (installFailed || hooksFailed ? 1 : 0);
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    fail(error.stack || error.message);
    process.exitCode = 1;
  });
