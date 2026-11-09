// 腾讯 Token Plan 个人版额度：TC3 签名查询，积分交给现有余额组件显示。
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
export const TENCENT_TOKENPLAN_CREDENTIAL_VARS = [
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
]

const ID_NAMES = ['TENCENTCLOUD_SECRET_ID', 'TENCENT_TOKENPLAN_SECRET_ID', 'TENCENT_SECRET_ID']
const KEY_NAMES = ['TENCENTCLOUD_SECRET_KEY', 'TENCENT_TOKENPLAN_SECRET_KEY', 'TENCENT_SECRET_KEY']
const TOKEN_NAMES = ['TENCENTCLOUD_TOKEN', 'TENCENTCLOUD_SESSION_TOKEN']

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()

// TC3 日期必须使用 UTC，与本机时区无关。
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

const CREDIT_PATHS = [
  'Response.Credit', 'Response.credit', 'Response.Credits', 'Response.credits',
  'Response.CreditBalance', 'Response.RemainCredit', 'Response.RemainingCredit',
  'Response.AvailableCredit', 'Response.PackageInfo.Credit', 'Credit', 'credit',
]

// 明确的剩余字段优先；个人版响应用 TotalCredits - TotalUsed。缺字段时不猜测余额。
export function parseTencentTokenPlanCredit(data, { creditPath = '' } = {}) {
  if (data === null || typeof data !== 'object') return null
  for (const path of creditPath ? [creditPath] : CREDIT_PATHS) {
    const value = toNumber(atPath(data, path))
    if (value !== null && value >= 0) return { credit: value, source: path }
  }
  if (creditPath) return null
  const res = data.Response ?? data
  const total = toNumber(res?.TotalCredits) ?? toNumber(res?.CycleCredits)
    ?? toNumber(res?.PackageInfo?.CycleQuota) ?? toNumber(res?.PackageInfo?.TotalQuota)
  const used = toNumber(res?.TotalUsed) ?? toNumber(res?.PackageInfo?.TotalUsed)
  if (total === null || total < 0 || used === null || used < 0) return null
  return { credit: Math.max(0, total - used), source: 'TotalCredits - TotalUsed' }
}

const trim = value => (typeof value === 'string' ? value.trim() : '')
const envValue = names => names.map(name => trim(process.env[name])).find(Boolean) ?? ''

function localEnvFile() {
  const file = process.env.TENCENT_TOKENPLAN_ENV_FILE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tencent-tokenplan.env')
  let text = ''
  try { text = readFileSync(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`无法读取腾讯密钥文件（${error.code}）：${file}`)
  }
  const values = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const raw = match[2]
    const quoted = raw.match(/^(["'])(.*?)\1\s*(?:#.*)?$/)
    values[match[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim()
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

const isSecretId = value => /^AKID[A-Za-z0-9]{20,80}$/.test(value)

// 按来源惰性读取；密钥对与临时 Token 始终同源。
async function resolvePair(ctx, file) {
  const pick = names => names.map(name => trim(file[name])).find(Boolean) ?? ''
  const credentials = ctx?.get?.('credentials')
  const sources = [
    ['local env file', names => pick(names)],
    ['environment', names => envValue(names)],
    ['credential store', names => storeValue(credentials, names)],
  ]
  for (const [source, get] of sources) {
    const secretId = await get(ID_NAMES), secretKey = await get(KEY_NAMES)
    if (secretId && secretKey) return { secretId, secretKey, token: await get(TOKEN_NAMES), source }
  }
  return null
}

const MESSAGES = {
  zh: {
    missing: '未找到完整的腾讯云 API 密钥对；请检查 tencent-tokenplan.env 中的 SecretId / SecretKey。不能使用 sk-tp- 推理 Key。',
    badSecretId: 'SecretId 应以 AKID 开头，请检查来源 {source}。sk-tp- 推理 Key 不能查询额度。',
    secretIdNotFound: '腾讯云未识别此 SecretId（AuthFailure.SecretIdNotFound），请检查密钥是否有效。当前来源：{source}。',
    signature: '签名校验失败（{code}）：SecretId 与 SecretKey 不配对，或本机时间偏差超过 5 分钟。当前来源：{source}。',
    auth: '腾讯 TokenHub 鉴权失败（{code}），请检查密钥是否有效及是否具有套餐查询权限。',
    http: '腾讯 TokenHub 额度接口返回 HTTP {status}。',
    api: '腾讯 TokenHub 返回错误：{code}。',
    network: '腾讯 TokenHub 额度查询网络失败，请稍后重试。',
    payload: '腾讯 TokenHub 响应无效或过大，请稍后重试。',
    credit: '未从响应中读到有效的 credit（剩余积分），未记为零余额。可用 TENCENT_TOKENPLAN_CREDIT_PATH 指定字段路径。',
  },
  en: {
    missing: 'Enter the Tencent Cloud API SecretId and SecretKey (cloud API keys, not an sk- inference key), or set env vars / ~/.dsh/tencent-tokenplan.env.',
    badSecretId: 'SecretId must start with AKID; check source {source}. An sk-tp- inference key cannot query quotas.',
    secretIdNotFound: 'Tencent Cloud does not recognize this SecretId (AuthFailure.SecretIdNotFound). Check that the key is valid. Active source: {source}.',
    signature: 'Signature verification failed ({code}): the key pair does not match, or the clock is off by more than 5 minutes. Active source: {source}.',
    auth: 'Tencent TokenHub authentication failed ({code}); check key validity and package query permissions.',
    http: 'Tencent TokenHub returned HTTP {status}.',
    api: 'Tencent TokenHub error: {code}.',
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
const round6 = value => Math.round(value * 1e6) / 1e6

export async function queryTencentTokenPlan(ctx, config, { fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted()
  const locale = config?.locale
  const file = localEnvFile()
  const configured = (name, fallback) => trim(process.env[name]) || trim(file[name]) || fallback
  const pair = await resolvePair(ctx, file)
  if (!pair) throw softFailure(locale, 'missing')
  if (!isSecretId(pair.secretId)) throw softFailure(locale, 'badSecretId', { source: pair.source })

  const action = DEFAULT_ACTION
  const region = configured('TENCENTCLOUD_REGION', DEFAULT_REGION)
  const product = configured('TENCENT_TOKENPLAN_PRODUCT_TYPE', DEFAULT_PRODUCT_TYPE)
  if (!['personal', 'personal-hunyuan'].includes(product)) throw new Error('TENCENT_TOKENPLAN_PRODUCT_TYPE 应为 personal 或 personal-hunyuan')
  const maxBudget = Number(configured('TENCENT_TOKENPLAN_MONTHLY_CREDITS', String(TENCENT_TOKENPLAN_MONTHLY_CREDITS)))
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) throw new Error('TENCENT_TOKENPLAN_MONTHLY_CREDITS 必须是大于零的数字')
  const payload = JSON.stringify({ ProductType: product })
  const token = pair.token

  let response
  try {
    // 每次重试重新生成时间戳与签名；请求固定为只读套餐查询。
    response = await fetchWithRetry(TENCENT_TOKENPLAN_URL, { signal }, {
      attempts: 2, timeoutMs: 15000,
      fetchImpl: (url, init) => {
        const request = signTencentTokenPlanRequest(pair.secretId, pair.secretKey, { action, payload, region, token })
        return fetchImpl(url, { ...request, headers: { ...init.headers, ...request.headers }, signal: init.signal })
      },
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
    // 只回传错误码，避免上游正文含有账户信息。
    const key = /SecretIdNotFound|InvalidSecretId/i.test(code) ? 'secretIdNotFound'
      : /Signature/i.test(code) ? 'signature'
        : /AuthFailure|UnauthorizedOperation|NotAuthorized/i.test(code) ? 'auth'
          : null
    if (key !== null) throw Object.assign(softFailure(locale, key, { code, source: pair.source }), { upstreamCode: code })
    throw failure(locale, 'api', { code })
  }

  const parsed = parseTencentTokenPlanCredit(data, { creditPath: configured('TENCENT_TOKENPLAN_CREDIT_PATH', '') })
  if (parsed === null) throw failure(locale, 'credit')
  const remaining = round6(parsed.credit)
  return {
    label: config?.customBalance?.label || '腾讯 Token Plan 个人版',
    unit: 'CREDITS',
    remaining,
    maxBudget,
    spend: round6(Math.max(0, maxBudget - remaining)),
  }
}
