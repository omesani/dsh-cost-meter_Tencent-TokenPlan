#!/usr/bin/env node
import { options, pluginDir, planInstall, saveBackup, commitChanges, run } from './lib/deployment.mjs'
import { TESTED_PLUGIN_VERSIONS } from './patches/patches.mjs'

await run(() => {
  const args = options({ 'dry-run': { type: 'boolean' } })
  if (args.help) {
    console.log('用法：node install.mjs [--profile web] [--plugin <目录>] [--dry-run]')
    return
  }
  const plan = planInstall(pluginDir(args))
  console.log(`dsh-cost-meter ${plan.version}\n目录：${plan.dir}`)
  if (!TESTED_PLUGIN_VERSIONS.includes(plan.version)) console.log('提示：此版本尚未实测，将按实际文件结构进行预检。')
  if (plan.errors.length) throw new Error(`预检未通过，未修改插件。\n${plan.errors.join('\n')}\n请保留版本号与上述失败项，更新补丁后重试。`)
  console.log(`预检通过：${plan.changes.length} 个文件需要更新。`)
  if (args['dry-run']) { console.log('仅预览，未写入。'); return }
  if (!plan.changes.length) { console.log('补丁已是最新，无需写入。'); return }
  const backup = saveBackup(plan)
  console.log(`备份：${backup}`)
  commitChanges(plan.dir, plan.changes)
  console.log('代码安装完成；运行中的宿主尚需重启。\n下一步：重启 DSH → 刷新网页 → node check.mjs --live。')
})
