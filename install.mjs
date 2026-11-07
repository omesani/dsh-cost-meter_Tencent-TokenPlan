#!/usr/bin/env node
/**
 * 把「腾讯 Token Plan 个人版」原生额度接入应用到已安装的 dsh-cost-meter。
 *
 *   node install.mjs                 自动定位插件并应用（幂等，可重复执行）
 *   node install.mjs --dry-run       只预览
 *   node install.mjs --plugin <dir>  指定插件目录
 *   node install.mjs --force         非基线版本也尝试
 *
 * 被改文件先备份到 ~/.dsh/tencent-tokenplan-backups/<时间戳>/（不在本仓库内）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_PLUGIN_VERSION, NEW_FILES, PACKAGE_DOC_ENTRY,
  PACKAGE_NETWORK_HOST, SYNTAX_CHECK_FILES, TEXT_PATCHES } from './patches/patches.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? '' : '')
const DRY = flag('--dry-run')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 显式参数 → 环境变量 → $DSH_HOME/profiles/<name>/node_modules/dsh-cost-meter。 */
function locatePlugin() {
  const explicit = option('--plugin') || process.env.DSH_COST_METER_DIR || ''
  if (explicit) {
    const dir = resolve(explicit)
    if (!existsSync(join(dir, 'package.json'))) throw new Error(`不是 dsh-cost-meter 目录：${dir}`)
    return dir
  }
  for (const name of ['web', 'desktop', 'tui', 'headless']) {
    const dir = join(DSH_HOME, 'profiles', name, 'node_modules', 'dsh-cost-meter')
    if (existsSync(join(dir, 'package.json'))) return resolve(dir)
  }
  throw new Error('未找到 dsh-cost-meter，请用 --plugin <目录> 指定')
}

const pluginDir = locatePlugin()
const pkgPath = join(pluginDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
console.log(`插件目录: ${pluginDir}`)
console.log(`插件版本: ${pkg.name}@${pkg.version}（基线 ${BASELINE_PLUGIN_VERSION}）`)
if (pkg.version !== BASELINE_PLUGIN_VERSION && !flag('--force')) console.log('\n⚠️  版本与基线不同：仍会尝试，锚点不匹配的条目会报错。\n')

const backupRoot = join(DSH_HOME, 'tencent-tokenplan-backups', new Date().toISOString().replace(/[:.]/g, '-'))
const backedUp = new Set()
function backup(rel) {
  if (DRY || backedUp.has(rel)) return
  const abs = join(pluginDir, rel)
  if (!existsSync(abs)) return
  const dest = join(backupRoot, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(abs, dest)
  backedUp.add(rel)
}

const report = []
const failures = []

// 1. 新增文件
for (const [from, to] of NEW_FILES) {
  const src = join(HERE, from)
  const dest = join(pluginDir, to)
  if (!existsSync(src)) { failures.push(`${to}: 源文件缺失 ${from}`); continue }
  const existed = existsSync(dest)
  if (existed && readFileSync(src).equals(readFileSync(dest))) { report.push(['skip', to, '已是最新']); continue }
  if (!DRY) { backup(to); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest) }
  report.push([existed ? 'update' : 'create', to, '复制'])
}

// 2. 字面量补丁
for (const patch of TEXT_PATCHES) {
  const abs = join(pluginDir, patch.file)
  if (!existsSync(abs)) { failures.push(`${patch.id}: 文件不存在 ${patch.file}`); continue }
  let text = readFileSync(abs, 'utf8')
  // 跟随目标文件换行（custom-balance.js 是 CRLF），避免混合行尾。
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = eol === '\n' ? patch.replace : patch.replace.replace(/\r?\n/g, '\r\n')
  const expected = patch.expect ?? 1
  if ((text.split(replacement).length - 1) >= expected) { report.push(['skip', patch.id, '已应用']); continue }
  const hits = text.split(patch.find).length - 1
  if (hits !== expected) { failures.push(`${patch.id}: 锚点命中 ${hits} 次，期望 ${expected} 次（插件版本变化？）`); continue }
  text = patch.all ? text.split(patch.find).join(replacement) : text.replace(patch.find, replacement)
  if (!DRY) { backup(patch.file); writeFileSync(abs, text) }
  report.push(['apply', patch.id, `${expected} 处`])
}

// 3. package.json（结构化，不用正则）
{
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
  if (changed && !DRY) { backup('package.json'); writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`) }
  if (!changed) report.push(['skip', 'package.json', '已包含'])
}

// 4. 语法自检
if (!DRY) {
  for (const rel of SYNTAX_CHECK_FILES) {
    const abs = join(pluginDir, rel)
    if (!existsSync(abs)) continue
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    if (r.status !== 0) failures.push(`语法检查失败 ${rel}: ${(r.stderr || '').split('\n')[0]}`)
  }
}

// 5. 报告
const mark = { apply: '✅ 应用', update: '✅ 更新', create: '✅ 新建', skip: '⏭  跳过' }
console.log('')
for (const [kind, name, detail] of report) console.log(`${mark[kind]}  ${name}  ${detail}`)
if (failures.length > 0) {
  console.log('\n❌ 未完成的项：')
  for (const line of failures) console.log(`   - ${line}`)
  console.log('\n常见原因：dsh-cost-meter 升级后压缩产物变化导致锚点位移。')
  console.log('处理：git pull 更新本仓库；仍失败请带着插件版本和上述报错提 issue。')
  process.exit(1)
}
if (backedUp.size > 0) console.log(`\n备份: ${backupRoot}`)
if (DRY) console.log('\n(dry-run：未写入任何文件)')
console.log('下一步：重启 DSH 宿主 → 刷新页面 → 设置 → 费用 → 额度 点「+ 腾讯 Token Plan 个人版」并启用。')
