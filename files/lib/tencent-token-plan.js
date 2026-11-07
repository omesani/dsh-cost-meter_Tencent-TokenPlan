/**
 * dsh-cost-meter「腾讯 Token Plan 个人版」额度查询 adapter（原生接入）。
 *
 * 官方资料:
 *  - 套餐详情(企业版 DescribeTokenPlan): https://cloud.tencent.com/document/product/1823/132270
 *  - 套餐列表(企业版 DescribeTokenPlanList): https://cloud.tencent.com/document/product/1823/132269
 *  - 公共参数 / 地域 / service=tokenhub: https://cloud.tencent.com/document/api/1823/132283
 *  - 签名方法 v3(TC3-HMAC-SHA256): https://cloud.tencent.com/document/api/1823/132284
 *  - 个人版档位(通用 Standard = 1980 积分/订阅月): https://cloud.tencent.com/document/product/1823/130060
 *  - 个人版积分抵扣规则: https://cloud.tencent.com/document/product/1823/133811
 *
 * 个人版实际调用 DescribeTokenPlanPersonalPackage(与 132270 同域名 / 同 Version /
 * 同签名,不需要 TeamId,以 ProductType 区分通用版 personal 与 Hy 版 personal-hunyuan)。
 * 也可用 TENCENT_TOKENPLAN_ACTION=DescribeTokenPlan + TENCENT_TOKENPLAN_TEAM_ID 切到
 * 132270 文档口径的企业版接口。
 *
 * 接口只回传用量/剩余积分,没有百分比。完整比例由本模块自行计算:
 *   maxBudget = 1980(月积分总量,可由 TENCENT_TOKENPLAN_MONTHLY_CREDITS 覆盖)
 *   spend     = maxBudget - credit
 *   remaining = credit
 * 由 dsh-cost-meter 的自定义余额框架按 remaining / maxBudget 渲染进度条与百分比。
 *
 * 密钥只用于本地 TC3 HMAC 派生,SecretKey 绝不出站;SecretId 只出现在
 * Authorization 的 Credential 里。不读取、不回传响应中的账户身份字段。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { fetchWithRetry, readJsonBounded } from './net.js'
import { balanceHttpError } from './balance-retry.js'

export const TENCENT_TOKENPLAN_HOST = 'tokenhub.tencentcloudapi.com'
export const TENCENT_TOKENPLAN_URL = `https://${TENCENT_TOKENPLAN_HOST}/`
export const TENCENT_TOKENPLAN_SERVICE = 'tokenhub'
export const TENCENT_TOKENPLAN_VERSION = '2026-03-22'
export const TENCENT_TOKENPLAN_DEFAULT_REGION = 'ap-guangzhou'
export const TENCENT_TOKENPLAN_MONTHLY_CREDITS = 1980

/** 自定义余额卡片里显示的凭据输入框(customVar:<NAME>),顺序即 UI 顺序。 */
export const TENCENT_TOKENPLAN_CREDENTIAL_VARS = [
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
  'TENCENT_TOKENPLAN_TEAM_ID',
]

const SECRET_ID_NAMES = ['TENCENTCLOUD_SECRET_ID', 'TENCENT_TOKENPLAN_SECRET_ID', 'TENCENT_SECRET_ID']
const SECRET_KEY_NAMES = ['TENCENTCLOUD_SECRET_KEY', 'TENCENT_TOKENPLAN_SECRET_KEY', 'TENCENT_SECRET_KEY']
const TOKEN_NAMES = ['TENCENTCLOUD_TOKEN', 'TENCENTCLOUD_SESSION_TOKEN']
const TEAM_ID_NAMES = ['TENCENT_TOKENPLAN_TEAM_ID', 'TENCENTCLOUD_TOKENPLAN_TEAM_ID']

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()

/**
 * 生成腾讯云 API 3.0 TC3-HMAC-SHA256 签名请求。
 * 纯函数(时间戳可注入),便于单元测试。
 */
export function signTencentTokenPlanRequest(secretId, secretKey, {
  action = 'DescribeTokenPlanPersonalPackage',
  payload = '{}',
  region = TENCENT_TOKENPLAN_DEFAULT_REGION,
  timestamp = Math.floor(Date.now() / 1000),
  token = '',
} = {}) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10) // UTC,不是东八区
  const contentType = 'application/json; charset=utf-8'
  const signedHeaders = 'content-type;host'
  const canonicalHeaders = `content-type:${contentType}\nhost:${TENCENT_TOKENPLAN_HOST}\n`
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n')
  const credentialScope = `${date}/${TENCENT_TOKENPLAN_SERVICE}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256hex(canonicalRequest)].join('\n')
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, TENCENT_TOKENPLAN_SERVICE)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')
  const headers = {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'content-type': contentType,
    host: TENCENT_TOKENPLAN_HOST,
    'x-tc-action': action,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': TENCENT_TOKENPLAN_VERSION,
    'x-tc-region': region,
    'user-agent': 'dsh-cost-meter/1.9 (DeepSeek Harness plugin)',
  }
  if (token) headers['x-tc-token'] = token
  return { method: 'POST', headers, body: payload, redirect: 'manual' }
}

const number = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const getPath = (obj, path) => String(path).split('.').reduce(
  (cur, key) => cur !== null && typeof cur === 'object' ? cur[key] : undefined, obj)

/**
 * 递归查找名为 credit* 的数值字段(有界,避免异常响应导致深递归)。
 * 优先「剩余」语义的键,其次任意 credit 键;同名多取值第一个有限非负数。
 */
function findCreditField(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return null
  const rows = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node)
  const named = []
  for (const [key, value] of rows) {
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
      // TotalCredits / CycleCredits / UsedCredits 是分母或已用量，不是「剩余 credit」。
      if (/credit/i.test(key) && !/total|cycle|used|spent|consum|quota|limit|max|cap|alloc/i.test(key)) {
        named.push([key, number(value)])
      }
    }
  }
  const prefer = named.find(([key, value]) => /remain|available|left|rest|balance/i.test(key) && value !== null && value >= 0)
  if (prefer) return prefer[1]
  const any = named.find(([, value]) => value !== null && value >= 0)
  if (any) return any[1]
  for (const [, value] of rows) {
    if (value !== null && typeof value === 'object') {
      const hit = findCreditField(value, depth + 1)
      if (hit !== null) return hit
    }
  }
  return null
}

const DEFAULT_CREDIT_PATHS = [
  'Response.Credit', 'Response.credit', 'Response.Credits', 'Response.credits',
  'Response.CreditBalance', 'Response.RemainCredit', 'Response.RemainingCredit',
  'Response.AvailableCredit', 'Response.PackageInfo.Credit', 'Response.PackageInfo.CreditBalance',
  'Credit', 'credit', 'Credits', 'credits',
]

/**
 * 从响应里解析【剩余 credit】。纯函数,可单测。
 * 优先用户配置的 creditPath;其次常见 credit 字段路径;再次递归查找;
 * 最后兼容官方 CLI 口径的 TotalCredits / CycleCredits - TotalUsed。
 * @returns {{ credit:number, source:string } | null}
 */
export function parseTencentTokenPlanCredit(data, { creditPath = '' } = {}) {
  if (data === null || typeof data !== 'object') return null
  const paths = creditPath ? [creditPath] : DEFAULT_CREDIT_PATHS
  for (const path of paths) {
    const value = number(getPath(data, path))
    if (value !== null && value >= 0) return { credit: value, source: path }
  }
  const scanned = findCreditField(data)
  if (scanned !== null) return { credit: scanned, source: 'credit field (auto-detected)' }
  const response = data.Response ?? data
  const total = number(response?.TotalCredits) ?? number(response?.CycleCredits)
    ?? number(response?.PackageInfo?.CycleQuota) ?? number(response?.PackageInfo?.TotalQuota)
  const used = number(response?.TotalUsed) ?? number(response?.PackageInfo?.TotalUsed) ?? 0
  if (total !== null && total >= 0 && used !== null && used >= 0) {
    return { credit: Math.max(0, total - used), source: 'TotalCredits - TotalUsed' }
  }
  return null
}

/** 归一化单个配置数值(环境变量 / 本地 env 文件都可能是字符串)。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 读取可选的本地 env 文件里的全部键值(密钥不落进 config,只在查询时读取)。 */
function readLocalEnvFile() {
  const file = process.env.TENCENT_TOKENPLAN_ENV_FILE || join(homedir(), '.dsh', 'tencent-tokenplan.env')
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return {} }
  const values = {}
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const value = match[2].replace(/^['"]|['"]$/g, '').trim()
    if (value) values[match[1]] = value
  }
  return values
}

const pickFrom = (values, names) => {
  for (const name of names) if (values[name]) return values[name]
  return ''
}

/** 本地 env 文件里成对的 SecretId/SecretKey。 */
function readLocalEnvPairs() {
  const values = readLocalEnvFile()
  return { id: pickFrom(values, SECRET_ID_NAMES), key: pickFrom(values, SECRET_KEY_NAMES) }
}

/** 腾讯云 SecretId 形态:AKID 开头、长度 32~64 的字母数字。 */
const looksLikeSecretId = value => typeof value === 'string' && /^AKID[A-Za-z0-9]{20,80}$/.test(value.trim())

/** 从 DSH 凭据库按候选名取第一个非空值。 */
async function resolveFromStore(credentials, names) {
  if (credentials === undefined) return ''
  for (const name of names) {
    try {
      const hit = await credentials.resolve(credentialRef(name))
      if (typeof hit?.value === 'string' && hit.value.trim()) return hit.value.trim()
    } catch { /* 尝试下一个候选名 */ }
  }
  return ''
}

const resolveFromEnv = names => {
  for (const name of names) {
    const value = String(process.env[name] ?? '').trim()
    if (value) return value
  }
  return ''
}

/**
 * 凭据按【来源成对】解析,绝不跨来源混搭 SecretId 与 SecretKey。
 *
 * 逐字段取优先级会把「凭据库里的 SecretId」和「env 文件里的 SecretKey」拼成一把
 * 不存在的密钥,上游只回 AuthFailure.SecretIdNotFound,极难定位。这里改为:依次考察
 * 凭据库 → 进程环境变量 → 本地 env 文件,第一个同时提供两者的来源胜出。
 *
 * 另支持把 "SecretId:SecretKey" 合并填在 SecretId 槽位的形态。
 */
async function resolveCredentialPair(ctx) {
  const credentials = ctx?.get?.('credentials')
  const storeId = await resolveFromStore(credentials, SECRET_ID_NAMES)
  const storeKey = await resolveFromStore(credentials, SECRET_KEY_NAMES)
  const envId = resolveFromEnv(SECRET_ID_NAMES)
  const envKey = resolveFromEnv(SECRET_KEY_NAMES)
  const fileValues = readLocalEnvPairs()
  const candidates = [
    { source: 'credential store', secretId: storeId, secretKey: storeKey },
    { source: 'environment', secretId: envId, secretKey: envKey },
    { source: 'local env file', secretId: fileValues.id, secretKey: fileValues.key },
  ]
  // 合并形态 "SecretId:SecretKey" 在各自来源内拆开（只有缺 Key 时才拆）。
  for (const candidate of candidates) {
    if (!candidate.secretKey && candidate.secretId.includes(':')) {
      const idx = candidate.secretId.indexOf(':')
      const id = candidate.secretId.slice(0, idx).trim()
      const key = candidate.secretId.slice(idx + 1).trim()
      if (id && key) {
        candidate.secretId = id
        candidate.secretKey = key
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.secretId && candidate.secretKey) {
      return { secretId: candidate.secretId, secretKey: candidate.secretKey, source: candidate.source,
        partial: { id: true, key: true } }
    }
  }
  return { secretId: '', secretKey: '', source: '',
    partial: { id: Boolean(storeId || envId || fileValues.id), key: Boolean(storeKey || envKey || fileValues.key) } }
}

const messages = {
  zh: {
    missing: '请填写腾讯云 API 的 SecretId 与 SecretKey（云 API 密钥，不是 sk-tp- 推理 Key）；也可设置环境变量或 ~/.dsh/tencent-tokenplan.env。',
    network: '腾讯 TokenHub 额度查询网络失败，请稍后重试。',
    http: '腾讯 TokenHub 额度接口返回 HTTP {status}。',
    auth: '腾讯 TokenHub 鉴权失败：请确认使用主账号密钥，且已授予 TokenHub 管控面读取权限（子账号常见 AuthFailure.UnauthorizedOperation）。上游错误码：{code}。',
    secretIdNotFound: '腾讯 TokenHub 不认识这把 SecretId（AuthFailure.SecretIdNotFound）：通常是 SecretId 填成了 Token Plan 的推理 API Key（sk- 开头），或 SecretId 与 SecretKey 来自不同密钥对。请填云 API 密钥（AKID 开头，https://console.cloud.tencent.com/capi）。当前生效来源：{source}。',
    badSecretId: 'SecretId 形态不对（应以 AKID 开头，是云 API 密钥）：当前生效来源 {source} 里是「{shape}」形式的值。sk- 开头的是 Token Plan 推理 Key，不能用于额度查询；请到 https://console.cloud.tencent.com/capi 建/取云 API 密钥。',
    missingOne: '凭据只配了一半：{missing} 缺失。SecretId 与 SecretKey 必须成对来自同一把云 API 密钥。',
    signature: '签名校验失败（{code}）：SecretId 与 SecretKey 不是同一把密钥，或本机时间偏差超过 5 分钟。当前生效来源：{source}。',
    api: '腾讯 TokenHub 返回错误：{code} {message}',
    payload: '腾讯 TokenHub 响应无效或过大，请稍后重试。',
    credit: '未从腾讯 TokenHub 响应中读取到有效的 credit（剩余积分），未将其记为零余额。可设置 TENCENT_TOKENPLAN_CREDIT_PATH 指定字段路径。',
  },
  en: {
    missing: 'Enter the Tencent Cloud API SecretId and SecretKey (cloud API keys, not the sk-tp- inference key), or set env vars / ~/.dsh/tencent-tokenplan.env.',
    network: 'Tencent TokenHub quota request failed; please retry later.',
    http: 'Tencent TokenHub returned HTTP {status}.',
    auth: 'Tencent TokenHub authentication failed: use a root-account key with TokenHub control-plane read permission (sub-accounts commonly get AuthFailure.UnauthorizedOperation). Upstream code: {code}.',
    secretIdNotFound: 'Tencent TokenHub does not recognize this SecretId (AuthFailure.SecretIdNotFound): the SecretId is usually a Token Plan inference key (sk-...) instead of a cloud API key, or SecretId and SecretKey come from different key pairs. Enter cloud API keys (AKID..., https://console.cloud.tencent.com/capi). Active source: {source}.',
    badSecretId: 'The SecretId does not look like a cloud API key (must start with AKID). Active source {source} holds a "{shape}" value; sk-... is a Token Plan inference key and cannot query quotas. Create cloud API keys at https://console.cloud.tencent.com/capi.',
    missingOne: 'Credentials are only half configured: {missing} is missing. SecretId and SecretKey must come as a pair from the same cloud API key.',
    signature: 'Signature verification failed ({code}): SecretId and SecretKey are not the same key pair, or the local clock is off by more than 5 minutes. Active source: {source}.',
    api: 'Tencent TokenHub error: {code} {message}',
    payload: 'Tencent TokenHub response is invalid or too large; please retry later.',
    credit: 'No valid credit (remaining points) in the Tencent TokenHub response; not treated as zero. Set TENCENT_TOKENPLAN_CREDIT_PATH to override the field path.',
  },
}
const failure = (locale, key, vars = {}) => {
  let text = messages[locale === 'en' ? 'en' : 'zh'][key]
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value))
  return new Error(text)
}

/**
 * 查询腾讯 Token Plan 个人版额度。由 custom-balance.js 以 adapter 方式调用。
 * @returns {{ label:string, unit:'CREDITS', remaining:number, maxBudget:number, spend:number }}
 */
export async function queryTencentTokenPlan(ctx, config, { fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted()
  const locale = config?.locale
  // 成对解析:同一来源的 SecretId + SecretKey 才配对,绝不跨来源混搭。
  const pair = await resolveCredentialPair(ctx)
  const { secretId, secretKey, source } = pair
  if (!secretId || !secretKey) {
    const error = pair.partial.id || pair.partial.key
      ? failure(locale, 'missingOne', { missing: [pair.partial.id ? '' : 'SecretId', pair.partial.key ? '' : 'SecretKey'].filter(Boolean).join(' / ') })
      : failure(locale, 'missing')
    error.soft = true
    throw error
  }
  // 形态先自检:把 sk- 推理 Key 误填进 SecretId 时给出可操作的提示,而不是让上游回 SecretIdNotFound。
  if (!looksLikeSecretId(secretId)) {
    const shape = /^sk-/.test(secretId) ? 'sk-…（Token Plan 推理 Key）'
      : /^AKID/.test(secretId) ? 'AKID…（长度异常）' : secretId.slice(0, 3) + '…'
    const error = failure(locale, 'badSecretId', { source, shape })
    error.soft = true
    throw error
  }

  const action = String(process.env.TENCENT_TOKENPLAN_ACTION ?? '').trim() || 'DescribeTokenPlanPersonalPackage'
  const productType = String(process.env.TENCENT_TOKENPLAN_PRODUCT_TYPE ?? '').trim() || 'personal'
  const region = String(process.env.TENCENTCLOUD_REGION ?? process.env.TENCENT_TOKENPLAN_REGION ?? '').trim()
    || TENCENT_TOKENPLAN_DEFAULT_REGION
  // TeamId / 临时密钥 token 与主密钥同源解析(成对来源,不跨来源混搭)。
  const sideCredentials = ctx?.get?.('credentials')
  const teamId = await resolveFromStore(sideCredentials, TEAM_ID_NAMES)
    || resolveFromEnv(TEAM_ID_NAMES) || pickFrom(readLocalEnvFile(), TEAM_ID_NAMES)
  const token = await resolveFromStore(sideCredentials, TOKEN_NAMES)
    || resolveFromEnv(TOKEN_NAMES) || pickFrom(readLocalEnvFile(), TOKEN_NAMES)
  const payload = action === 'DescribeTokenPlan'
    ? JSON.stringify({ TeamId: teamId })
    : JSON.stringify({ ProductType: productType })
  if (action === 'DescribeTokenPlan' && !teamId) {
    const error = failure(locale, 'missing')
    error.soft = true
    throw error
  }

  let response
  try {
    // 每次重试重新生成时间戳/签名;URL、Action、body 均为固定只读查询。
    response = await fetchWithRetry(TENCENT_TOKENPLAN_URL, { signal }, {
      attempts: 2, timeoutMs: 15000,
      fetchImpl: (url, init) => fetchImpl(url, {
        ...signTencentTokenPlanRequest(secretId, secretKey, { action, payload, region, token }),
        signal: init.signal,
      }),
    })
  } catch {
    signal?.throwIfAborted()
    throw failure(locale, 'network')
  }
  if (!response.ok) {
    try { await response.body?.cancel?.() } catch {}
    if (response.status === 401 || response.status === 403) throw failure(locale, 'auth', { code: response.status })
    throw balanceHttpError(failure(locale, 'http', { status: response.status }).message, response)
  }
  let data
  try { data = await readJsonBounded(response, 262144, { signal }) }
  catch { signal?.throwIfAborted(); throw failure(locale, 'payload') }
  if (data === null || typeof data !== 'object') throw failure(locale, 'payload')
  const apiError = data?.Response?.Error ?? data?.Error
  if (apiError) {
    const code = String(apiError.Code ?? apiError.code ?? '')
    const message = String(apiError.Message ?? apiError.message ?? '')
    // 401/403 一类错误要拆开说清楚,否则用户永远只看到「请确认主账号权限」——
    // 而 SecretIdNotFound / 签名失败其实是「密钥配错/串台」,与权限无关。
    const kind = /SecretIdNotFound|InvalidSecretId/i.test(code) ? 'secretIdNotFound'
      : /Signature|SignatureExpire/i.test(code) ? 'signature'
      : /AuthFailure|UnauthorizedOperation|NotAuthorized/i.test(code) ? 'auth'
      : null
    if (kind !== null) {
      const error = failure(locale, kind, { code, source })
      error.soft = true
      error.upstreamCode = code
      throw error
    }
    throw failure(locale, 'api', { code, message })
  }
  const parsed = parseTencentTokenPlanCredit(data, {
    creditPath: String(process.env.TENCENT_TOKENPLAN_CREDIT_PATH ?? '').trim(),
  })
  if (parsed === null) throw failure(locale, 'credit')

  const maxBudget = positiveNumber(process.env.TENCENT_TOKENPLAN_MONTHLY_CREDITS, TENCENT_TOKENPLAN_MONTHLY_CREDITS)
  // 上游已用量带 8 位小数，去掉浮点运算产生的 ...0002 尾数再展示。
  const round6 = value => Math.round(value * 1e6) / 1e6
  const remaining = round6(Math.max(0, Math.min(maxBudget, parsed.credit)))
  return {
    label: config?.customBalance?.label || '腾讯 Token Plan 个人版',
    unit: 'CREDITS',
    remaining,
    maxBudget,
    spend: round6(Math.max(0, maxBudget - remaining)),
  }
}
