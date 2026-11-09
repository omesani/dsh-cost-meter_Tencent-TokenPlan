#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { options, pluginDir, packageInfo, backupDir, read, hash, inside, commitChanges, run } from './lib/deployment.mjs'

await run(() => {
  const args = options({ backup: { type: 'string' }, list: { type: 'boolean' } })
  if (args.help) { console.log('用法：node uninstall.mjs --list | --backup <目录> [--profile web] [--plugin <目录>]'); return }
  if (args.list) {
    console.log(existsSync(backupDir()) ? readdirSync(backupDir()).sort().reverse().join('\n') : '没有备份。')
    return
  }
  if (!args.backup) throw new Error('请先用 --list 查看，再用 --backup <目录> 明确选择要回退的安装。')
  const backup = resolve(args.backup)
  const manifest = JSON.parse(read(join(backup, 'manifest.json')) || 'null')
  if (manifest?.format !== 1 || !Array.isArray(manifest.files)) throw new Error('此备份缺少新版校验记录；请按 README 的旧备份说明处理。')
  const dir = args.plugin || args.profile || process.env.DSH_COST_METER_DIR ? pluginDir(args) : resolve(manifest.pluginDir)
  if (packageInfo(dir).version !== manifest.version) throw new Error('插件版本已变化，不能把旧版本文件覆盖到新版本；请重新安装当前版本的 dsh-cost-meter。')
  const changes = manifest.files.map(file => {
    const before = read(inside(dir, file.path))
    if (hash(before) !== file.afterHash) throw new Error(`安装后文件已变化，停止回退：${file.path}`)
    const after = file.beforeHash === null ? null : read(inside(backup, file.path))
    if (hash(after) !== file.beforeHash) throw new Error(`备份内容缺失或已变化：${file.path}`)
    return { path: file.path, before, after }
  })
  commitChanges(dir, changes)
  console.log('已回退所选安装。env 与账本未修改；请重启 DSH 并刷新网页。')
})
