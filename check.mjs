#!/usr/bin/env node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { options, pluginDir, planInstall, dshHome, read, run } from './lib/deployment.mjs'

await run(async () => {
  const args = options({ live: { type: 'boolean' } })
  if (args.help) { console.log('用法：node check.mjs [--profile web] [--plugin <目录>] [--live]'); return }
  const dir = pluginDir(args), plan = planInstall(dir)
  console.log(`dsh-cost-meter ${plan.version}\n目录：${dir}`)
  if (plan.errors.length) throw new Error(`补丁结构不兼容：\n${plan.errors.join('\n')}\n未修改任何文件。`)
  if (plan.changes.length) throw new Error('补丁缺失或源码已有更新；请先运行 node install.mjs，再重启 DSH。')
  console.log('✓ 磁盘代码：补丁完整、语法通过')
  let ready = true
  const warn = message => { ready = false; console.log(`待处理：${message}`) }
  const envPath = process.env.TENCENT_TOKENPLAN_ENV_FILE || join(dshHome(), 'tencent-tokenplan.env')
  console.log(`凭据文件：${read(envPath) === null ? '未找到（也可使用进程环境变量或原有凭据库）' : '已找到，未输出内容'}`)
  const ledger = read(join(dshHome(), 'storages/cost-meter/ledger.json'))
  if (ledger === null) warn('未找到费用账本；首次启动后在网页添加腾讯个人版条目。')
  else {
    const config = JSON.parse(ledger).config ?? {}
    const entries = (config.customBalances ?? []).filter(entry => entry.adapter === 'tencent-tokenplan')
    if (entries.length !== 1) warn(`找到 ${entries.length} 个腾讯专用条目；请在费用 → 额度保留一个启用的腾讯个人版条目。升级丢失 adapter 时可用腾讯预设重建。`)
    else if (!entries[0].enabled || !['both', 'sidebar'].includes(entries[0].display)) warn('请启用腾讯条目并选择在侧栏显示。')
    else console.log('✓ 账本配置：腾讯条目已启用并在侧栏显示')
    if (!config.balance?.showProgressBar || config.sidebarTextOnly) warn('费用 → 显示：关闭“仅文字”，打开“余额进度条”。')
    else console.log('✓ 账本配置：进度条已开启')
  }
  if (args.live) {
    // 独立进程只验证 env/进程凭据与腾讯接口，不代表运行中宿主已刷新缓存。
    const { queryTencentTokenPlan } = await import(pathToFileURL(join(dir, 'lib/tencent-token-plan.js')))
    const result = await queryTencentTokenPlan({ get: () => undefined }, { locale: 'zh' }, { signal: AbortSignal.timeout(35000) })
    console.log(`✓ 真实查询：剩余 ${result.remaining} / ${result.maxBudget} Credits，已用 ${result.spend}，剩余 ${(result.remaining / result.maxBudget * 100).toFixed(2)}%`)
  } else console.log('未发起网络查询。用 --live 验证现有 env / 进程密钥与腾讯接口。')
  console.log('页面验收：重启 DSH 并刷新网页，在腾讯条目点“刷新”，确认侧栏数字和进度条；命令行不能替代此步骤。')
  if (!ready) process.exitCode = 1
})
