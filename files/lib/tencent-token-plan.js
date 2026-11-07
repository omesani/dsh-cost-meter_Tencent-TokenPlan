/**
 * dsh-cost-meter adapter：腾讯云 TokenHub「通用 Token Plan 个人版」额度。
 *
 * 请求：POST tokenhub.tencentcloudapi.com，Action=DescribeTokenPlanPersonalPackage，
 * Version=2026-03-22，service=tokenhub，TC3-HMAC-SHA256 签名（SecretKey 仅本地派生，不出站）。
 * 企业版对照 Action=DescribeTokenPlan（需 TeamId，文档 132270）。
 *
 * 接口只返回用量/剩余积分，不返回百分比，因此按固定月总量自行计算完整比例：
 *   maxBudget = 1980（通用 Standard 档，可用 TENCENT_TOKENPLAN_MONTHLY_CREDITS 覆盖）
 *   remaining = credit
 *   spend     = maxBudget - credit
 * 由自定义余额框架按 remaining / maxBudget 渲染进度条与百分比。
 *
 * 文档：132270（企业版详情）、132269（套餐列表）、132283（公共参数）、
 * 132284（签名 v3）、130060（档位与积分）、133811（积分抵扣规则）。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { fetchWithRetry, readJsonBounded } from './net.js'
import { balanceHttpError } from './balance-retry.js'

const HOST = 'tokenhub.tencentcloudapi.com'
const SERVICE = 'tokenhub'
const VERSION = '2026-03-22'
const DEFAULT_REGION = 'ap-guangzhou'
const DEFAULT_ACTION = 'DescribeTokenPlanPersonalPackage'
const DEFAULT_PRODUCT_TYPE = 'personal'

export const TENCENT_TOKENPLAN_URL = `https://${HOST}/`
export const TENCENT_TOKENPLAN_MONTHLY_CREDITS = 1980
/** 设置页显示的凭据输入框（customVar:<NAME>），顺序即 UI 顺序。 */
export const TENCENT_TOKENPLAN_CREDENTIAL_VARS = [
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
  'TENCENT_TOKENPLAN_TEAM_ID',
]

const ID_NAMES = ['TENCENTCLOUD_SECRET_ID', 'TENCENT_TOKENPLAN_SECRET_ID', 'TENCENT_SECRET_ID']
const KEY_NAMES = ['TENCENTCLOUD_SECRET_KEY', 'TENCENT_TOKENPLAN_SECRET_KEY', 'TENCENT_SECRET_KEY']
const TOKEN_NAMES = ['TENCENTCLOUD_TOKEN', 'TENCENTCLOUD_SESSION_TOKEN']
const TEAM_NAMES = ['TENCENT_TOKENPLAN_TEAM_ID', 'TENCENTCLOUD_TOKENPLAN_TEAM_ID']

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()

/**
 * 生成 TC3-HMAC-SHA256 签名请求。纯函数（时间戳可注入），便于测试。
 * 注意：签名日期按 UTC 计算，东八区凌晨不能直接用本地日期。
 */
export function signTencentTokenPlanRequest(secretId, secretKey, {
  action = DEFAULT_ACTION,
  payload = '{}',
  region = DEFAULT_REGION,
  timestamp = Math.floor(Date.now() / 1000),
  token = '',
} = {}) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const contentType = 'application/json; charset=utf-8'
  const signedHeaders = 'content-type;host'
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n')
  const scope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), SERVICE), 'tc3_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  const headers = {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'content-type': contentType,
    host: HOST,
    'x-tc-action': action,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': VERSION,
    'x-tc-region': region,
    'user-agent': 'dsh-cost-meter/1.9 (DeepSeek Harness plugin)',
  }
  if (token) headers['x-tc-token'] = token
  return { method: 'POST', headers, body: payload, redirect: 'manual' }
}

const toNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : null
}
const atPath = (obj, path) => String(path).split('.').reduce(
  (cur, key) => (cur !== null && typeof cur === 'object' ? cur[key] : undefined), obj)

/** credit 语义的反向选择：这些词表示分母或已用量，不是「剩余」。 */
const NOT_REMAINING = /total|cycle|used|spent|consum|quota|limit|max|cap|alloc/i
const REMAINING = /remain|available|left|rest|balance/i
const CREDIT_PATHS = [
  'Response.Credit', 'Response.credit', 'Response.Credits', 'Response.credits',
  'Response.CreditBalance', 'Response.RemainCredit', 'Response.RemainingCredit',
  'Response.AvailableCredit', 'Response.PackageInfo.Credit', 'Credit', 'credit',
]

/** 有界递归查找 credit* 数值字段（层级上限防异常响应）。 */
function scanCredit(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return null
  const entries = Object.entries(node)
  let fallback = null
  for (const [key, raw] of entries) {
    if (!/credit/i.test(key) || NOT_REMAINING.test(key)) continue
    const value = toNumber(raw)
    if (value === null || value < 0) continue
    if (REMAINING.test(key)) return value
    fallback ??= value
  }
  if (fallback !== null) return fallback
  for (const [, value] of entries) {
    const hit = scanCredit(value, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 解析剩余 credit。顺序：显式路径 → 常见路径 → 有界递归 →
 * TotalCredits/CycleCredits - TotalUsed（当前个人版接口的实测形态）。
 * @returns {{ credit:number, source:string } | null}
 */
export function parseTencentTokenPlanCredit(data, { creditPath = '' } = {}) {
  if (data === null || typeof data !== 'object') return null
  for (const path of creditPath ? [creditPath] : CREDIT_PATHS) {
    const value = toNumber(atPath(data, path))
    if (value !== null && value >= 0) return { credit: value, source: path }
  }
  const scanned = scanCredit(data)
  if (scanned !== null) return { credit: scanned, source: 'credit field (auto-detected)' }
  const res = data.Response ?? data
  const total = toNumber(res?.TotalCredits) ?? toNumber(res?.CycleCredits)
    ?? toNumber(res?.PackageInfo?.CycleQuota) ?? toNumber(res?.PackageInfo?.TotalQuota)
  const used = toNumber(res?.TotalUsed) ?? toNumber(res?.PackageInfo?.TotalUsed) ?? 0
  if (total === null || total < 0 || used === null || used < 0) return null
  return { credit: Math.max(0, total - used), source: 'TotalCredits - TotalUsed' }
}

// ── 凭据 ────────────────────────────────────────────────────────────────
// 同一来源的 SecretId + SecretKey 才配对，绝不跨来源混搭：逐字段取优先级会拼出
// 一把不存在的密钥，上游只回 AuthFailure.SecretIdNotFound，极难定位。

const trim = value => (typeof value === 'string' ? value.trim() : '')
const envValue = names => names.map(name => trim(process.env[name])).find(Boolean) ?? ''

function localEnvFile() {
  const file = process.env.TENCENT_TOKENPLAN_ENV_FILE || join(homedir(), '.dsh', 'tencent-tokenplan.env')
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return {} }
  const values = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match && match[2]) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return values
}

async function storeValue(credentials, names) {
  if (credentials === undefined) return ''
  for (const name of names) {
    try {
      const hit = await credentials.resolve(credentialRef(name))
      if (trim(hit?.value)) return hit.value.trim()
    } catch { /* 换下一个候选名 */ }
  }
  return ''
}

/** 腾讯云 SecretId 形态：AKID + 20~80 位字母数字。 */
const isSecretId = value => /^AKID[A-Za-z0-9]{20,80}$/.test(value)

/**
 * 按来源成对解析：凭据库 → 进程环境变量 → 本地 env 文件，首个同时提供两者的来源胜出。
 * 支持把 "SecretId:SecretKey" 合并填在 SecretId 槽位。
 */
async function resolvePair(ctx) {
  const credentials = ctx?.get?.('credentials')
  const file = localEnvFile()
  const pick = names => names.map(name => file[name]).find(Boolean) ?? ''
  const sources = [
    ['credential store', await storeValue(credentials, ID_NAMES), await storeValue(credentials, KEY_NAMES)],
    ['environment', envValue(ID_NAMES), envValue(KEY_NAMES)],
    ['local env file', pick(ID_NAMES), pick(KEY_NAMES)],
  ]
  let haveId = false
  let haveKey = false
  for (const [source, rawId, rawKey] of sources) {
    let id = rawId
    let key = rawKey
    haveId ||= Boolean(id)
    haveKey ||= Boolean(key)
    if (id && !key && id.includes(':')) {
      const cut = id.indexOf(':')
      key = id.slice(cut + 1).trim()
      id = id.slice(0, cut).trim()
    }
    if (id && key) return { secretId: id, secretKey: key, source, haveId, haveKey }
  }
  return { secretId: '', secretKey: '', source: '', haveId, haveKey }
}

// ── 文案 ────────────────────────────────────────────────────────────────
const MESSAGES = {
  zh: {
    missing: '请填写腾讯云 API 的 SecretId 与 SecretKey（云 API 密钥，不是 sk- 推理 Key）；也可设置环境变量或 ~/.dsh/tencent-tokenplan.env。',
    missingOne: '凭据只配了一半：缺少 {missing}。SecretId 与 SecretKey 必须成对来自同一把云 API 密钥。',
    badSecretId: 'SecretId 形态不对（应以 AKID 开头）：来源 {source} 的值形如「{shape}」。sk- 开头的是 Token Plan 推理 Key，不能查额度；请到 https://console.cloud.tencent.com/capi 获取云 API 密钥。',
    secretIdNotFound: '上游不认识这把 SecretId（AuthFailure.SecretIdNotFound）：通常填成了 sk- 推理 Key，或两个值来自不同密钥对。当前来源：{source}。',
    signature: '签名校验失败（{code}）：SecretId 与 SecretKey 不配对，或本机时间偏差超过 5 分钟。当前来源：{source}。',
    auth: '腾讯 TokenHub 鉴权失败：需要主账号密钥，或已授予 TokenHub 管控面读取权限的 CAM 密钥。上游错误码：{code}。',
    http: '腾讯 TokenHub 额度接口返回 HTTP {status}。',
    api: '腾讯 TokenHub 返回错误：{code} {message}',
    network: '腾讯 TokenHub 额度查询网络失败，请稍后重试。',
    payload: '腾讯 TokenHub 响应无效或过大，请稍后重试。',
    credit: '未从响应中读到有效的 credit（剩余积分），未记为零余额。可用 TENCENT_TOKENPLAN_CREDIT_PATH 指定字段路径。',
  },
  en: {
    missing: 'Enter the Tencent Cloud API SecretId and SecretKey (cloud API keys, not an sk- inference key), or set env vars / ~/.dsh/tencent-tokenplan.env.',
    missingOne: 'Credentials are half configured: {missing} is missing. Both must come from the same cloud API key pair.',
    badSecretId: 'The SecretId must start with AKID; source {source} holds a "{shape}" value. sk-... is a Token Plan inference key and cannot query quotas. Create cloud API keys at https://console.cloud.tencent.com/capi.',
    secretIdNotFound: 'Tencent Cloud does not recognize this SecretId (AuthFailure.SecretIdNotFound): usually an sk- inference key, or values from different key pairs. Active source: {source}.',
    signature: 'Signature verification failed ({code}): the key pair does not match, or the clock is off by more than 5 minutes. Active source: {source}.',
    auth: 'Tencent TokenHub authentication failed: a root-account key, or a CAM key granted TokenHub control-plane read access, is required. Upstream code: {code}.',
    http: 'Tencent TokenHub returned HTTP {status}.',
    api: 'Tencent TokenHub error: {code} {message}',
    network: 'Tencent TokenHub quota request failed; please retry later.',
    payload: 'Tencent TokenHub response is invalid or too large; please retry later.',
    credit: 'No valid credit (remaining points) in the response; not treated as zero. Set TENCENT_TOKENPLAN_CREDIT_PATH to override the field path.',
  },
}

function failure(locale, key, vars = {}) {
  let text = MESSAGES[locale === 'en' ? 'en' : 'zh'][key]
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value))
  return new Error(text)
}

const softFailure = (locale, key, vars) => Object.assign(failure(locale, key, vars), { soft: true })
const configured = (name, fallback) => String(process.env[name] ?? '').trim() || fallback
const round6 = value => Math.round(value * 1e6) / 1e6

/**
 * 查询个人版额度，由 custom-balance.js 以 adapter 方式调用。
 * @returns {{ label:string, unit:'CREDITS', remaining:number, maxBudget:number, spend:number }}
 */
export async function queryTencentTokenPlan(ctx, config, { fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted()
  const locale = config?.locale
  const pair = await resolvePair(ctx)
  if (!pair.secretId || !pair.secretKey) {
    const missing = [pair.haveId ? '' : 'SecretId', pair.haveKey ? '' : 'SecretKey'].filter(Boolean).join(' / ')
    throw softFailure(locale, pair.haveId || pair.haveKey ? 'missingOne' : 'missing',
      pair.haveId || pair.haveKey ? { missing } : {})
  }
  if (!isSecretId(pair.secretId)) {
    const shape = /^sk-/.test(pair.secretId) ? 'sk-…（Token Plan 推理 Key）' : `${pair.secretId.slice(0, 3)}…`
    throw softFailure(locale, 'badSecretId', { source: pair.source, shape })
  }

  const action = configured('TENCENT_TOKENPLAN_ACTION', DEFAULT_ACTION)
  const region = configured('TENCENTCLOUD_REGION', configured('TENCENT_TOKENPLAN_REGION', DEFAULT_REGION))
  const file = localEnvFile()
  const sideValue = async names => await storeValue(ctx?.get?.('credentials'), names)
    || envValue(names) || (names.map(name => file[name]).find(Boolean) ?? '')
  const teamId = await sideValue(TEAM_NAMES)
  if (action === 'DescribeTokenPlan' && !teamId) throw softFailure(locale, 'missing')
  const payload = action === 'DescribeTokenPlan'
    ? JSON.stringify({ TeamId: teamId })
    : JSON.stringify({ ProductType: configured('TENCENT_TOKENPLAN_PRODUCT_TYPE', DEFAULT_PRODUCT_TYPE) })
  const token = await sideValue(TOKEN_NAMES)

  let response
  try {
    // 每次重试重新生成时间戳与签名；请求固定为只读套餐查询。
    response = await fetchWithRetry(TENCENT_TOKENPLAN_URL, { signal }, {
      attempts: 2, timeoutMs: 15000,
      fetchImpl: (url, init) => fetchImpl(url, {
        ...signTencentTokenPlanRequest(pair.secretId, pair.secretKey, { action, payload, region, token }),
        signal: init.signal,
      }),
    })
  } catch {
    signal?.throwIfAborted()
    throw failure(locale, 'network')
  }
  if (!response.ok) {
    try { await response.body?.cancel?.() } catch { /* 清理失败不掩盖 HTTP 错误 */ }
    if (response.status === 401 || response.status === 403) throw failure(locale, 'auth', { code: response.status })
    throw balanceHttpError(failure(locale, 'http', { status: response.status }).message, response)
  }

  let data
  try { data = await readJsonBounded(response, 262144, { signal }) }
  catch { signal?.throwIfAborted(); throw failure(locale, 'payload') }
  if (data === null || typeof data !== 'object') throw failure(locale, 'payload')

  const apiError = data.Response?.Error ?? data.Error
  if (apiError) {
    const code = String(apiError.Code ?? apiError.code ?? '')
    const message = String(apiError.Message ?? apiError.message ?? '')
    // 鉴权类错误必须分清：SecretIdNotFound / 签名失败是「密钥配错」，与权限无关。
    const key = /SecretIdNotFound|InvalidSecretId/i.test(code) ? 'secretIdNotFound'
      : /Signature/i.test(code) ? 'signature'
        : /AuthFailure|UnauthorizedOperation|NotAuthorized/i.test(code) ? 'auth'
          : null
    if (key !== null) throw Object.assign(softFailure(locale, key, { code, source: pair.source }), { upstreamCode: code })
    throw failure(locale, 'api', { code, message })
  }

  const parsed = parseTencentTokenPlanCredit(data, { creditPath: configured('TENCENT_TOKENPLAN_CREDIT_PATH', '') })
  if (parsed === null) throw failure(locale, 'credit')
  const monthly = Number(configured('TENCENT_TOKENPLAN_MONTHLY_CREDITS', ''))
  const maxBudget = Number.isFinite(monthly) && monthly > 0 ? monthly : TENCENT_TOKENPLAN_MONTHLY_CREDITS
  const remaining = round6(Math.max(0, Math.min(maxBudget, parsed.credit)))
  return {
    label: config?.customBalance?.label || '腾讯 Token Plan 个人版',
    unit: 'CREDITS',
    remaining,
    maxBudget,
    spend: round6(Math.max(0, maxBudget - remaining)),
  }
}
