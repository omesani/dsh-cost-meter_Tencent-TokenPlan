import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { NEW_FILES, PACKAGE_DOC_ENTRY, PACKAGE_NETWORK_HOST, SYNTAX_CHECK_FILES, TEXT_PATCHES } from '../patches/patches.mjs'

export const projectDir = fileURLToPath(new URL('../', import.meta.url))
export const dshHome = () => resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
export const backupDir = () => join(dshHome(), 'tencent-tokenplan-backups')
export const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex')
export const read = path => {
  try { return readFileSync(path, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export function options(extra = {}) {
  return parseArgs({ options: {
    plugin: { type: 'string' }, profile: { type: 'string' }, help: { type: 'boolean' }, ...extra,
  } }).values
}
export function pluginDir(args = {}) {
  if (args.plugin || process.env.DSH_COST_METER_DIR) return resolve(args.plugin || process.env.DSH_COST_METER_DIR)
  const profile = args.profile || 'web'
  if (!/^[\w-]+$/.test(profile)) throw new Error('profile 名称只能包含字母、数字、下划线和连字符')
  return join(dshHome(), 'profiles', profile, 'node_modules', 'dsh-cost-meter')
}
export function packageInfo(dir) {
  const content = read(join(dir, 'package.json'))
  if (content === null) throw new Error(`未找到插件：${dir}。请先安装 dsh-cost-meter，或用 --profile / --plugin 指定位置。`)
  const pkg = JSON.parse(content)
  if (pkg.name !== 'dsh-cost-meter') throw new Error(`目标不是 dsh-cost-meter：${dir}`)
  return pkg
}
export function inside(root, path) {
  const dest = resolve(root, path)
  const rel = relative(root, dest)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径超出目标目录：${path}`)
  return dest
}
export function atomicWrite(path, content) {
  if (content === null) { rmSync(path, { force: true }); return }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  let mode = 0o600
  try { mode = statSync(path).mode & 0o777 } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { writeFileSync(temp, content, { mode }); renameSync(temp, path) }
  finally { rmSync(temp, { force: true }) }
}

// 计划阶段只读目标文件；任一锚点或语法失败，都不进入写入阶段。
export function planInstall(dir) {
  const pkg = packageInfo(dir)
  const original = new Map(), planned = new Map(), errors = []
  const get = path => {
    if (!original.has(path)) original.set(path, read(inside(dir, path)))
    return planned.has(path) ? planned.get(path) : original.get(path)
  }
  const put = (path, text) => { get(path); planned.set(path, text) }
  for (const [src, dest] of NEW_FILES) put(dest, readFileSync(join(projectDir, src), 'utf8'))
  for (const patch of TEXT_PATCHES) {
    const text = get(patch.file)
    if (text === null) { errors.push(`${patch.id}：缺少 ${patch.file}`); continue }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const normalize = value => value.replace(/\r?\n/g, eol)
    const find = patch.find instanceof RegExp ? patch.find : normalize(patch.find)
    const replacement = typeof patch.replace === 'string' ? normalize(patch.replace) : patch.replace
    const count = value => value instanceof RegExp ? [...text.matchAll(value)].length : text.split(value).length - 1
    const expected = patch.expect ?? 1
    const installed = count(patch.installed ?? replacement)
    if (installed === expected || patch.accept?.every(value => text.includes(value))) {
      continue
    }
    if (installed || count(find) !== expected) {
      errors.push(`${patch.id}（${patch.file}）：锚点命中 ${count(find)} 次，期望 ${expected} 次`); continue
    }
    put(patch.file, find instanceof RegExp ? text.replace(find, replacement) : text.split(find).join(replacement))
  }
  const network = pkg?.dshhub?.permissions?.network
  if (!Array.isArray(network)) errors.push('package.json：缺少 network 清单')
  else if (!network.includes(PACKAGE_NETWORK_HOST)) network.push(PACKAGE_NETWORK_HOST)
  if (!Array.isArray(pkg.files)) errors.push('package.json：缺少 files 清单')
  else if (!pkg.files.includes(PACKAGE_DOC_ENTRY)) pkg.files.push(PACKAGE_DOC_ENTRY)
  // 没有结构变化时保持原格式，避免仅因 JSON 缩进而更新。
  if (JSON.stringify(pkg) !== JSON.stringify(JSON.parse(get('package.json')))) put('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  for (const path of SYNTAX_CHECK_FILES) {
    const text = get(path)
    if (text === null) continue
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' })
    if (result.status !== 0) errors.push(`${path}：语法校验失败\n${result.stderr || result.error?.message || ''}`)
  }
  return { dir, version: pkg.version, errors,
    changes: [...planned].filter(([path, after]) => after !== original.get(path))
      .map(([path, after]) => ({ path, before: original.get(path), after })) }
}

// 使用内容校验避免覆盖并行升级；中途失败仅回退本次已经写入的文件。
export function commitChanges(dir, changes) {
  for (const file of changes) {
    if (read(inside(dir, file.path)) !== file.before) throw new Error(`文件已变化，请重新运行：${file.path}`)
  }
  const written = []
  try {
    for (const file of changes) {
      if (read(inside(dir, file.path)) !== file.before) throw new Error(`文件已变化：${file.path}`)
      atomicWrite(inside(dir, file.path), file.after)
      written.push(file)
    }
  } catch (error) {
    const failures = []
    for (const file of written.reverse()) {
      try {
        if (read(inside(dir, file.path)) !== file.after) throw new Error('已被其他进程修改，保留当前内容')
        atomicWrite(inside(dir, file.path), file.before)
      } catch (rollback) { failures.push(`${file.path}: ${rollback.message}`) }
    }
    throw new Error([error.message, ...failures.map(line => `回退未完成：${line}`)].join('\n'))
  }
}
export function saveBackup(plan) {
  const dest = join(backupDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dest, { recursive: true })
  for (const file of plan.changes) if (file.before !== null) atomicWrite(inside(dest, file.path), file.before)
  atomicWrite(join(dest, 'manifest.json'), `${JSON.stringify({ format: 1, pluginDir: plan.dir, version: plan.version,
    files: plan.changes.map(file => ({ path: file.path, beforeHash: hash(file.before), afterHash: hash(file.after) })),
  }, null, 2)}\n`)
  return dest
}
export async function run(main) {
  try { await main() }
  catch (error) { console.error(`失败：${error.message}`); process.exitCode = 1 }
}
