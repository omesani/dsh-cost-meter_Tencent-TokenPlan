#!/usr/bin/env node
/**
 * 从最近一次安装备份还原 dsh-cost-meter。
 * 用法：node uninstall.mjs [--backup <目录>] [--list]
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(dshHome, 'tencent-tokenplan-backups')

if (args.includes('--list')) {
  if (!existsSync(root)) { console.log('没有备份。'); process.exit(0) }
  for (const name of readdirSync(root).sort().reverse()) console.log(name)
  process.exit(0)
}

const pluginArg = args.includes('--plugin') ? args[args.indexOf('--plugin') + 1] : ''
const pluginDir = resolve(pluginArg || join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-cost-meter'))
if (!existsSync(root)) { console.error('没有备份可还原。'); process.exit(1) }
const backups = readdirSync(root).sort().reverse()
if (backups.length === 0) { console.error('备份目录为空。'); process.exit(1) }
const latest = join(root, backups[0])

console.log(`还原备份: ${latest}`)
console.log(`目标插件: ${pluginDir}`)
cpSync(latest, pluginDir, { recursive: true, force: true })
console.log('已还原。注意：新增文件 lib/tencent-token-plan.js 与 docs/tencent-token-plan.md 不会被删除，')
console.log('如需彻底移除，请手动删除这两个文件，然后重启 DSH 宿主。')
