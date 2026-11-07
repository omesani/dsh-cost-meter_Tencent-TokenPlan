#!/usr/bin/env node
/**
 * 把「腾讯 Token Plan 个人版」原生额度接入应用到已安装的 dsh-cost-meter。
 *
 * 用法：
 *   node install.mjs                 # 自动定位插件并应用
 *   node install.mjs --dry-run       # 只报告将要做什么，不写文件
 *   node install.mjs --plugin <dir>  # 指定插件目录
 *   node install.mjs --force         # 允许在非基线版本上尝试（锚点失败仍会报错）
 *
 * 幂等：重复执行只跳过已应用项。修改前会把原文件备份到
 * ~/.dsh/tencent-tokenplan-backups/<时间戳>/（不在本仓库内，避免误提交）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_PLUGIN_VERSION, NEW_FILES, PACKAGE_DOC_ENTRY, PACKAGE_NETWORK_HOST,
  SYNTAX_CHECK_FILES, TEXT_PATCHES,
} from './patches/patches.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const valueOf = name => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : ''
}
const DRY = flag('--dry-run')
const FORCE = flag('--force')

/** 定位插件目录：显式参数 → 环境变量 → $DSH_HOME/profiles/<name>/node_modules/dsh-cost-meter。 */
function locatePlugin() {
  const explicit = valueOf('--plugin') || process.env.DSH_COST_METER_DIR || ''
  if (explicit) {
    if (!existsSync(join(explicit, 'package.json'))) throw new Error(`不是 dsh-cost-meter 目录：${explicit}`)
    return resolve(explicit)
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = join(dshHome, 'profiles')
  const found = []
  if (existsSync(profiles)) {
    for (const name of ['web', 'desktop', 'tui', 'headless']) {
      const dir = join(profiles, name, 'node_modules', 'dsh-cost-meter')
      if (existsSync(join(dir, 'package.json'))) found.push(dir)
    }
  }
  if (found.length === 0) {
    throw new Error('未找到 dsh-cost-meter。请用 --plugin <目录> 指定，例如 '
      + '--plugin ~/.dsh/profiles/web/node_modules/dsh-cost-meter')
  }
  return resolve(found[0])
}

const pluginDir = locatePlugin()
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
console.log(`插件目录: ${pluginDir}`)
console.log(`插件版本: ${pluginPkg.name}@${pluginPkg.version}（基线 ${BASELINE_PLUGIN_VERSION}）`)
if (pluginPkg.version !== BASELINE_PLUGIN_VERSION && !FORCE) {
  console.log(`\n⚠️  版本与基线不同。仍会尝试应用；锚点不匹配的条目会明确报错。`)
  console.log(`   如确认要在这版上尝试，加 --force。\n`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tencent-tokenplan-backups', stamp)
const backedUp = new Set()
function backup(rel) {
  if (DRY || backedUp.has(rel)) return
  const abs = join(pluginDir, rel)
  if (!existsSync(abs)) return
  const dest = join(backupDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(abs, dest)
  backedUp.add(rel)
}

const report = []
const fail = []

// ── 1. 新增文件 ───────────────────────────────────────────────────────
for (const [from, to] of NEW_FILES) {
  const src = join(HERE, from)
  const dest = join(pluginDir, to)
  if (!existsSync(src)) { fail.push(`${to}: 源文件缺失 ${from}`); continue }
  const same = existsSync(dest) && readFileSync(src).equals(readFileSync(dest))
  if (same) { report.push(['skip', to, '已是最新']); continue }
  if (!DRY) {
    backup(to)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  report.push([existsSync(dest) ? 'update' : 'create', to, '复制'])
}

// ── 2. 字面量补丁 ─────────────────────────────────────────────────────
const touched = new Set()
for (const patch of TEXT_PATCHES) {
  const abs = join(pluginDir, patch.file)
  if (!existsSync(abs)) { fail.push(`${patch.id}: 文件不存在 ${patch.file}`); continue }
  let text = readFileSync(abs, 'utf8')
  const expected = patch.expect ?? 1
  // 跟目标文件的行尾保持一致：custom-balance.js 是 CRLF，其余是 LF。
  // 混用会让整段 diff 显示为「改了但看不出改了什么」。
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = eol === '\n' ? patch.replace : patch.replace.replace(/\r?\n/g, '\r\n')
  const existing = text.split(replacement).length - 1
  if (existing >= expected) { report.push(['skip', patch.id, '已应用']); continue }
  const hits = text.split(patch.find).length - 1
  if (hits !== expected) {
    fail.push(`${patch.id}: 锚点命中 ${hits} 次，期望 ${expected} 次（插件版本变化？）`)
    continue
  }
  text = patch.all ? text.split(patch.find).join(replacement) : text.replace(patch.find, replacement)
  if (!DRY) {
    backup(patch.file)
    writeFileSync(abs, text)
  }
  touched.add(patch.file)
  report.push(['apply', patch.id, `${expected} 处`])
}

// ── 3. package.json（结构化，不用正则）─────────────────────────────────
{
  const abs = join(pluginDir, 'package.json')
  const pkg = JSON.parse(readFileSync(abs, 'utf8'))
  let changed = false
  const network = pkg?.dshhub?.permissions?.network
  if (Array.isArray(network) && !network.includes(PACKAGE_NETWORK_HOST)) {
    network.push(PACKAGE_NETWORK_HOST)
    changed = true
    report.push(['apply', 'package.json/network', PACKAGE_NETWORK_HOST])
  }
  if (Array.isArray(pkg.files) && !pkg.files.includes(PACKAGE_DOC_ENTRY)) {
    pkg.files.push(PACKAGE_DOC_ENTRY)
    changed = true
    report.push(['apply', 'package.json/files', PACKAGE_DOC_ENTRY])
  }
  if (changed && !DRY) {
    backup('package.json')
    writeFileSync(abs, `${JSON.stringify(pkg, null, 2)}\n`)
    touched.add('package.json')
  } else if (!changed) {
    report.push(['skip', 'package.json', '已包含'])
  }
}

// ── 4. 语法自检 ───────────────────────────────────────────────────────
if (!DRY) {
  for (const rel of SYNTAX_CHECK_FILES) {
    const abs = join(pluginDir, rel)
    if (!existsSync(abs)) continue
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    if (r.status !== 0) fail.push(`语法检查失败 ${rel}: ${(r.stderr || '').split('\n')[0]}`)
  }
}

// ── 5. 报告 ───────────────────────────────────────────────────────────
const mark = { apply: '✅ 应用', update: '✅ 更新', create: '✅ 新建', skip: '⏭  跳过' }
console.log('')
for (const [kind, name, detail] of report) console.log(`${mark[kind]}  ${name}  ${detail}`)
if (fail.length > 0) {
  console.log('\n❌ 有未完成的项：')
  for (const line of fail) console.log(`   - ${line}`)
  console.log('\n常见原因：dsh-cost-meter 升级后压缩产物变化，锚点位移。')
  console.log('处理：用 `git pull` 更新本仓库；若仍失败，把插件版本与上面的报错提 issue。')
  process.exit(1)
}
if (backedUp.size > 0) console.log(`\n备份: ${backupDir}`)
console.log(DRY ? '\n(dry-run：未写入任何文件)' : '')
console.log('下一步：重启 DSH 宿主 → 刷新页面 → 设置 → 费用 → 额度 里点「+ 腾讯 Token Plan 个人版」并启用。')
