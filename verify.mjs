#!/usr/bin/env node
/**
 * 安装后自检：补丁是否到位、签名是否正确、解析/凭据/配置校验是否符合预期。
 *
 * 全程使用假密钥，不读取真实 ~/.dsh/tencent-tokenplan.env，不发起真实网络请求。
 * 用法：node verify.mjs [--plugin <dir>]
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { options, pluginDir } from './lib/deployment.mjs'

const args = options()
if (args.help) { console.log('用法：node verify.mjs [--profile web] [--plugin <目录>]'); process.exit(0) }
const PLUGIN = pluginDir(args)

// 隔离真实密钥来源：任何用例都不得读到本机真实 env 文件。
process.env.TENCENT_TOKENPLAN_ENV_FILE = '/nonexistent/tencent-tokenplan.env'
for (const name of Object.keys(process.env)) {
  if (/^TENCENT/.test(name) && name !== 'TENCENT_TOKENPLAN_ENV_FILE') delete process.env[name]
}

// 假密钥运行时拼接，避免仓库出现形似真实密钥的字面量（防扫描器误报）。
const FAKE_ID = ['AKID', 'FAKE', 'FAKE', 'FAKE', '0'.repeat(20)].join('')
const FAKE_KEY = 'f'.repeat(32)
const CONFIG = {
  locale: 'zh',
  customBalance: {
    adapter: 'tencent-tokenplan', enabled: true, display: 'both', unit: 'CREDITS',
    label: '腾讯 Token Plan 个人版', request: { url: '', method: 'GET', headers: {} },
  },
}
const NO_CTX = { get: () => undefined }
const read = rel => readFileSync(join(PLUGIN, rel), 'utf8')

let passed = 0
const ok = name => { console.log('  ✓', name); passed++ }

if (!existsSync(join(PLUGIN, 'lib', 'tencent-token-plan.js'))) {
  console.error(`未找到 adapter：${join(PLUGIN, 'lib', 'tencent-token-plan.js')}\n请先运行 node install.mjs`)
  process.exit(1)
}
const { signTencentTokenPlanRequest, parseTencentTokenPlanCredit, queryTencentTokenPlan,
  TENCENT_TOKENPLAN_MONTHLY_CREDITS, TENCENT_TOKENPLAN_CREDENTIAL_VARS } =
  await import(join(PLUGIN, 'lib', 'tencent-token-plan.js'))

console.log(`插件: ${PLUGIN}@${JSON.parse(read('package.json')).version}\n`)

// 1. TC3 签名：独立重算比对，且 SecretKey 不出站。
{
  const payload = '{"ProductType":"personal"}'
  const ts = 1780000000
  const req = signTencentTokenPlanRequest(FAKE_ID, FAKE_KEY, { payload, timestamp: ts })
  assert.equal(req.method, 'POST')
  assert.equal(req.body, payload)
  assert.equal(req.redirect, 'manual')
  assert.equal(req.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(req.headers.host, 'tokenhub.tencentcloudapi.com')
  assert.equal(req.headers['x-tc-version'], '2026-03-22')
  assert.ok(!JSON.stringify(req).includes(FAKE_KEY), 'SecretKey 不得出现在请求里')

  const sha = text => createHash('sha256').update(text).digest('hex')
  const hm = (text, key, enc) => createHmac('sha256', key).update(text).digest(enc)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const ct = 'application/json; charset=utf-8'
  const canonical = ['POST', '/', '', `content-type:${ct}\nhost:tokenhub.tencentcloudapi.com\n`, 'content-type;host', sha(payload)].join('\n')
  const scope = `${date}/tokenhub/tc3_request`
  const toSign = ['TC3-HMAC-SHA256', ts, scope, sha(canonical)].join('\n')
  const signingKey = hm('tc3_request', hm('tokenhub', hm(date, 'TC3' + FAKE_KEY)))
  assert.equal(req.headers.authorization,
    `TC3-HMAC-SHA256 Credential=${FAKE_ID}/${scope}, SignedHeaders=content-type;host, Signature=${hm(toSign, signingKey, 'hex')}`)
  ok('TC3 签名与独立重算结果一致，SecretKey 未出站')
}

// 2. credit 解析：单值、字符串、自定义路径、真实响应形态、非法值。
{
  assert.equal(TENCENT_TOKENPLAN_MONTHLY_CREDITS, 1980)
  assert.deepEqual(TENCENT_TOKENPLAN_CREDENTIAL_VARS,
    ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'])
  const parse = parseTencentTokenPlanCredit
  assert.equal(parse({ Response: { credit: 1234 } }).credit, 1234)
  assert.equal(parse({ credit: '1234.5' }).credit, 1234.5)
  assert.equal(parse({ Response: { Data: { remainingCredit: 777 } } }, { creditPath: 'Response.Data.remainingCredit' }).credit, 777)
  const real = { Response: { ProductType: 'personal', PackageStatus: 'ACTIVE', TotalCredits: '1980',
    CycleCredits: '1980', TotalUsed: '555.99877936' } }
  const live = parse(real)
  assert.equal(live.source, 'TotalCredits - TotalUsed')
  assert.ok(Math.abs(live.credit - 1424.00122064) < 1e-9, '不能把 TotalCredits 误当成剩余值')
  assert.equal(parse({ Response: { credit: -1 } }), null)
  assert.equal(parse({}), null)
  assert.equal(parse({ Response: { TotalCredits: '1980' } }), null)
  assert.equal(parse({ Response: { TotalCredits: '1980', TotalUsed: 'bad' } }), null)
  assert.equal(parse({ Response: { TotalCredits: '1980', TotalUsed: -1 } }), null)
  assert.equal(parse({ Response: { TotalCredits: '1980', TotalUsed: '0' } }).credit, 1980)
  assert.equal(parse({ Response: { TotalCredits: '1980', TotalUsed: '2000' } }).credit, 0)
  assert.equal(parse(real, { creditPath: 'Response.missing' }), null)
  assert.equal(parse({ Response: { PromotionalCredit: 999 } }), null)
  ok('credit 解析：单值 / 字符串 / 自定义路径 / 真实形态 / 非法值拒绝')
}

// 3. 查询链路：Action、ProductType、签名头、1980 分母。
process.env.TENCENTCLOUD_SECRET_ID = FAKE_ID
process.env.TENCENTCLOUD_SECRET_KEY = FAKE_KEY
{
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({ Response: { credit: 1234 } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  assert.deepEqual(await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl }),
    { label: '腾讯 Token Plan 个人版', unit: 'CREDITS', remaining: 1234, maxBudget: 1980, spend: 746 })
  assert.equal(captured.url, 'https://tokenhub.tencentcloudapi.com/')
  assert.equal(captured.init.body, '{"ProductType":"personal"}')
  assert.equal(captured.init.headers['x-tc-action'], 'DescribeTokenPlanPersonalPackage')
  assert.ok(captured.init.headers.authorization.startsWith('TC3-HMAC-SHA256 '))
  ok('查询链路：个人版 Action / ProductType / 签名头 / 1980 分母 / spend=746')
}

// 4. 真实响应形态：浮点尾数清理，且与上游 TotalUsed 一致。
{
  const fetchImpl = async () => new Response(JSON.stringify({ Response: {
    TotalCredits: '1980', CycleCredits: '1980', TotalUsed: '555.99877936' } }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  const r = await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl })
  assert.equal(r.remaining, 1424.001221)
  assert.equal(r.spend, 555.998779)
  ok('真实响应：remaining/spend 去掉浮点尾数')
}

// 5. 分母可覆盖。
{
  process.env.TENCENT_TOKENPLAN_MONTHLY_CREDITS = '5980'
  const fetchImpl = async () => new Response(JSON.stringify({ Response: { credit: 4321 } }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  const r = await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl })
  assert.equal(r.maxBudget, 5980)
  assert.equal(r.spend, 1659)
  delete process.env.TENCENT_TOKENPLAN_MONTHLY_CREDITS
  ok('TENCENT_TOKENPLAN_MONTHLY_CREDITS 覆盖分母')
}

// 6. 凭据成对解析：半配置来源被跳过；sk- 形态当场识别且不发请求。
{
  // 形如推理 Key 的错误值（拼接，非真实密钥）。
  const BAD_ID = ['sk-', 'RANDOM', 'TOKENPLAN', 'KEY', '0'.repeat(32)].join('')
  const storeCtx = store => ({
    get: name => name === 'credentials' ? {
      resolve: async ref => {
        const key = String(typeof ref === 'string' ? ref : ref?.name ?? ref)
        if (key.includes('SECRET_ID') && store.id) return { value: store.id }
        if (key.includes('SECRET_KEY') && store.key) return { value: store.key }
        return undefined
      },
    } : undefined,
  })
  const okFetch = async () => new Response(JSON.stringify({ Response: { credit: 100 } }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal((await queryTencentTokenPlan(storeCtx({ id: BAD_ID }), CONFIG, { fetchImpl: okFetch })).remaining, 100)

  let called = false
  const savedId = process.env.TENCENTCLOUD_SECRET_ID
  process.env.TENCENTCLOUD_SECRET_ID = BAD_ID
  await assert.rejects(
    () => queryTencentTokenPlan(storeCtx({ id: BAD_ID, key: 'x'.repeat(32) }), CONFIG, {
      fetchImpl: async () => { called = true; throw new Error('should not fetch') } }),
    err => /AKID/.test(err.message) && /environment/.test(err.message) && err.soft === true)
  process.env.TENCENTCLOUD_SECRET_ID = savedId
  assert.equal(called, false, '形态错误时不应发起上游请求')
  ok('凭据成对解析：半配置来源被跳过；sk- 形态当场识别且不发请求')
}

// 7. 错误码映射：密钥配错与权限不足不能混为一谈。
{
  const withError = code => async () => new Response(JSON.stringify({ Response: { Error: { Code: code, Message: 'x' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  await assert.rejects(() => queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl: withError('AuthFailure.SecretIdNotFound') }),
    err => /SecretIdNotFound/.test(err.message) && err.upstreamCode === 'AuthFailure.SecretIdNotFound')
  await assert.rejects(() => queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl: withError('AuthFailure.UnauthorizedOperation') }),
    err => /查询权限/.test(err.message))
  ok('错误码映射：SecretIdNotFound 与权限不足分别提示')
}

// 8. GUI 保存：固定端点 adapter 免填 URL；普通自定义余额仍必须填。
{
  const { applyConfigPatch, defaultConfig } = await import(join(PLUGIN, 'lib', 'store.js'))
  const entry = { ...CONFIG.customBalance, labelEn: 'Tencent Token Plan (Personal)',
    dashboardUrl: 'https://console.cloud.tencent.com/tokenhub/tokenplan/common',
    refreshMinutes: 15, convertToDisplayCurrency: false, allowInsecureHttp: false,
    extract: {}, allowedHosts: [] }
  const saved = applyConfigPatch(defaultConfig(), { customBalances: [entry] })
  assert.deepEqual(saved.errors, [], '启用 + 空 url 不应被拒')
  assert.equal(saved.config.customBalances[0].adapter, 'tencent-tokenplan')
  assert.equal(saved.config.customBalances[0].unit, 'CREDITS')
  const rejected = applyConfigPatch(defaultConfig(), { customBalances: [{ ...entry, adapter: undefined }] })
  assert.ok(rejected.errors.length > 0 && /request\.url/.test(rejected.errors[0]), '普通 custom 仍要求非空 url')
  ok('GUI 保存：adapter 免填 URL 放行，普通自定义余额仍被拦')
}

// 9. 静态检查：补丁与清单是否都已到位。
{
  const checks = [
    ['lib/custom-balance.js', "from './tencent-token-plan.js'"],
    ['lib/custom-balance.js', "if (custom.adapter === 'tencent-tokenplan')"],
    ['lib/store.js', "'tencent-tokenplan'"],
    ['lib/typert.host.js', "z.enum(['custom', 'aliyun', 'tokenrhythm', 'tencent-tokenplan'])"],
    ['lib/ledger-writer-worker.js', '["aliyun","tokenrhythm","tencent-tokenplan"].includes(k.adapter)'],
    ['lib/client.js', 'k("tencent-tokenplan")'],
    ['lib/client.js', 'q=s.adapter==="tencent-tokenplan"'],
  ]
  for (const [file, needle] of checks) assert.ok(read(file).includes(needle), `${file} 缺少：${needle}`)
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.dshhub.permissions.network.includes('https://tokenhub.tencentcloudapi.com'), '网络白名单缺失')
  assert.ok(pkg.files.includes('docs/tencent-token-plan.md'), 'files 清单缺文档')
  ok('静态检查：adapter / 白名单 / 预设 / 网络权限 / 文档清单全部就位')
}

// env 文件及进程环境的凭据、Token 不得混用；文件配置无需写入凭据库。
{
  const dir = mkdtempSync(join(tmpdir(), 'tokenplan-test-'))
  const path = join(dir, 'test.env')
  const previousPath = process.env.TENCENT_TOKENPLAN_ENV_FILE
  try {
    process.env.TENCENT_TOKENPLAN_ENV_FILE = path
    writeFileSync(path, [
      `export TENCENTCLOUD_SECRET_ID="${FAKE_ID}" # file credentials`,
      `TENCENTCLOUD_SECRET_KEY='${FAKE_KEY}'`,
      'TENCENTCLOUD_TOKEN=file-token # same source',
      'TENCENT_TOKENPLAN_MONTHLY_CREDITS=2000',
      'TENCENTCLOUD_REGION=ap-shanghai',
    ].join('\n'), { mode: 0o600 })
    process.env.TENCENTCLOUD_SECRET_ID = 'sk-invalid-process-key'
    process.env.TENCENTCLOUD_TOKEN = 'wrong-process-token'
    let captured
    const fetchImpl = async (url, init) => {
      captured = init
      return new Response(JSON.stringify({ Response: { TotalCredits: 1980, TotalUsed: 601.571 } }))
    }
    const result = await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl })
    assert.equal(result.remaining, 1378.429)
    assert.equal(result.maxBudget, 2000)
    assert.equal(captured.headers['x-tc-token'], 'file-token')
    assert.equal(captured.headers['x-tc-region'], 'ap-shanghai')
    assert.equal(captured.headers['accept-encoding'], 'identity')
    writeFileSync(path, `TENCENTCLOUD_SECRET_ID=${FAKE_ID}\nTENCENTCLOUD_SECRET_KEY=${FAKE_KEY}`)
    const withoutToken = await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl })
    assert.equal(withoutToken.maxBudget, 1980)
    assert.equal(captured.headers['x-tc-token'], undefined)
    assert.equal(withoutToken.spend, 601.571)
    process.env.TENCENTCLOUD_SECRET_ID = FAKE_ID
    writeFileSync(path, `TENCENTCLOUD_SECRET_ID=${FAKE_ID}`)
    await queryTencentTokenPlan(NO_CTX, CONFIG, { fetchImpl })
    assert.equal(captured.headers['x-tc-token'], 'wrong-process-token')
    ok('env 文件优先、可选配置生效、凭据与临时 Token 同源、默认 1980 分母')
  } finally {
    process.env.TENCENT_TOKENPLAN_ENV_FILE = previousPath
    process.env.TENCENTCLOUD_SECRET_ID = FAKE_ID
    delete process.env.TENCENTCLOUD_TOKEN
    rmSync(dir, { recursive: true, force: true })
  }
}

// 配置错误在发送请求前报告，不静默回落到默认总额。
{
  let called = false
  process.env.TENCENT_TOKENPLAN_MONTHLY_CREDITS = 'invalid'
  await assert.rejects(() => queryTencentTokenPlan(NO_CTX, CONFIG, {
    fetchImpl: async () => { called = true; throw new Error('must not fetch') },
  }), /MONTHLY_CREDITS/)
  assert.equal(called, false)
  delete process.env.TENCENT_TOKENPLAN_MONTHLY_CREDITS
  const result = await queryTencentTokenPlan(NO_CTX, CONFIG, {
    fetchImpl: async () => new Response(JSON.stringify({ Response: { credit: 2000 } })),
  })
  assert.equal(result.remaining, 2000, '真实积分不应被显示分母截断')
  assert.equal(result.spend, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => queryTencentTokenPlan(NO_CTX, CONFIG, { signal: controller.signal }), error => error.name === 'AbortError')
  ok('非法总额提前失败、保留真实积分、取消请求即时生效')
}

console.log(`\n全部 ${passed} 组检查通过。`)
