/**
 * 针对 dsh-cost-meter 的声明式补丁集（锚点为字面量，逐条可校验）。
 *
 * 设计取舍：
 *  - 不改插件原有逻辑，只做「插入 / 扩白名单 / 加预设」这类最小改动；
 *  - 每条补丁带 guard：已打过就跳过，可重复执行；
 *  - 锚点找不到时明确报错（通常是插件升级改了压缩产物），而不是静默半应用。
 *
 * 基线版本：dsh-cost-meter 1.9.58
 */

export const BASELINE_PLUGIN_VERSION = '1.9.58'

/** 新增文件：直接从 files/ 复制到插件同名路径。 */
export const NEW_FILES = [
  ['files/lib/tencent-token-plan.js', 'lib/tencent-token-plan.js'],
  ['files/docs/tencent-token-plan.md', 'docs/tencent-token-plan.md'],
]

/** 字面量替换补丁：file 内 find → replace。已存在 replace 即视为已应用。 */
export const TEXT_PATCHES = [
  // ── custom-balance.js：注册 adapter ──────────────────────────────────
  {
    id: 'custom-balance/import',
    file: 'lib/custom-balance.js',
    find: "import { TOKENRHYTHM_BALANCE_CREDENTIAL_VARS, queryTokenRhythmBalance } from './tokenrhythm-balance.js'",
    replace: "import { TOKENRHYTHM_BALANCE_CREDENTIAL_VARS, queryTokenRhythmBalance } from './tokenrhythm-balance.js'\n"
      + "import { TENCENT_TOKENPLAN_CREDENTIAL_VARS, queryTencentTokenPlan } from './tencent-token-plan.js'",
  },
  {
    id: 'custom-balance/credential-vars',
    file: 'lib/custom-balance.js',
    find: "  if (entry?.adapter === 'tokenrhythm') return [...TOKENRHYTHM_BALANCE_CREDENTIAL_VARS]",
    replace: "  if (entry?.adapter === 'tokenrhythm') return [...TOKENRHYTHM_BALANCE_CREDENTIAL_VARS]\n"
      + "  if (entry?.adapter === 'tencent-tokenplan') return [...TENCENT_TOKENPLAN_CREDENTIAL_VARS]",
  },
  {
    id: 'custom-balance/dispatch',
    file: 'lib/custom-balance.js',
    find: "  if (custom.adapter === 'tokenrhythm') return queryTokenRhythmBalance(ctx, config, { signal })",
    replace: "  if (custom.adapter === 'tokenrhythm') return queryTokenRhythmBalance(ctx, config, { signal })\n"
      + "  if (custom.adapter === 'tencent-tokenplan') return queryTencentTokenPlan(ctx, config, { signal })",
  },

  // ── store.js：校验与落盘白名单 + 固定端点 adapter 免填 URL ──────────────
  {
    id: 'store/adapter-message-zh',
    file: 'lib/store.js',
    find: "customBalanceAdapter: 'customBalance.adapter 必须是 custom / aliyun / tokenrhythm',",
    replace: "customBalanceAdapter: 'customBalance.adapter 必须是 custom / aliyun / tokenrhythm / tencent-tokenplan',",
  },
  {
    id: 'store/adapter-message-en',
    file: 'lib/store.js',
    find: "customBalanceAdapter: 'customBalance.adapter must be custom / aliyun / tokenrhythm',",
    replace: "customBalanceAdapter: 'customBalance.adapter must be custom / aliyun / tokenrhythm / tencent-tokenplan',",
  },
  {
    id: 'store/adapter-allowlist',
    file: 'lib/store.js',
    find: "!['custom', 'aliyun', 'tokenrhythm'].includes(entry.adapter)",
    replace: "!['custom', 'aliyun', 'tokenrhythm', 'tencent-tokenplan'].includes(entry.adapter)",
  },
  {
    id: 'store/adapter-sanitize',
    file: 'lib/store.js',
    find: "...(['aliyun', 'tokenrhythm'].includes(entry.adapter) ? { adapter: entry.adapter } : {}),",
    replace: "...(['aliyun', 'tokenrhythm', 'tencent-tokenplan'].includes(entry.adapter) ? { adapter: entry.adapter } : {}),",
  },
  {
    // 固定端点 adapter 的 URL 由 adapter 决定，设置页也不显示该输入框；
    // 原校验要求「启用时 url 非空」，会让这类条目一启用就报
    // 「customBalance.request.url 必须是非空字符串」。
    id: 'store/self-resolving-url',
    file: 'lib/store.js',
    find: "    const request = entry.request\n"
      + "    // url 仅在启用时必填:默认禁用状态下不能阻断其它配置项的保存。\n"
      + "    if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.url !== 'string' || (entry.enabled === true && request.url.length === 0)) {",
    replace: "    const request = entry.request\n"
      + "    // 固定端点 adapter(aliyun / tokenrhythm / tencent-tokenplan)在 queryCustomBalance 里\n"
      + "    // 早于 request.url 分支返回,URL 由 adapter 自己决定,不需要用户填,也不能用空串卡住保存。\n"
      + "    const selfResolving = ['aliyun', 'tokenrhythm', 'tencent-tokenplan'].includes(entry.adapter)\n"
      + "    // url 仅在启用时必填:默认禁用状态下不能阻断其它配置项的保存。\n"
      + "    if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.url !== 'string' || (entry.enabled === true && request.url.length === 0 && !selfResolving)) {",
  },

  // ── typert.host.js：RPC 配置 schema（两处）────────────────────────────
  {
    id: 'typert/adapter-enum',
    file: 'lib/typert.host.js',
    find: "z.enum(['custom', 'aliyun', 'tokenrhythm']).optional()",
    replace: "z.enum(['custom', 'aliyun', 'tokenrhythm', 'tencent-tokenplan']).optional()",
    all: true,
    expect: 2,
  },

  // ── ledger-writer-worker.js：生成的 worker 内嵌副本 ────────────────────
  {
    id: 'worker/adapter-allowlist',
    file: 'lib/ledger-writer-worker.js',
    find: '["aliyun","tokenrhythm"].includes(k.adapter)',
    replace: '["aliyun","tokenrhythm","tencent-tokenplan"].includes(k.adapter)',
  },

  // ── client.js：设置页白名单、预设按钮、凭据输入框（压缩产物，锚点唯一）──
  {
    id: 'client/adapter-allowlist',
    file: 'lib/client.js',
    find: '["aliyun","tokenrhythm"].includes(s.adapter)?{adapter:s.adapter}:{}',
    replace: '["aliyun","tokenrhythm","tencent-tokenplan"].includes(s.adapter)?{adapter:s.adapter}:{}',
  },
  {
    id: 'client/self-resolving-flag',
    file: 'lib/client.js',
    find: 'u=s.adapter==="aliyun",d=s.adapter==="tokenrhythm",m=u||d,[g,b]=L(!1)',
    replace: 'u=s.adapter==="aliyun",d=s.adapter==="tokenrhythm",q=s.adapter==="tencent-tokenplan",m=u||d||q,[g,b]=L(!1)',
  },
  {
    id: 'client/credential-vars',
    file: 'lib/client.js',
    find: ':d?["TOKENRHYTHM_COOKIE"]:[...new Set(Object.values(s.request?.headers??{})',
    replace: ':d?["TOKENRHYTHM_COOKIE"]:q?["TENCENTCLOUD_SECRET_ID","TENCENTCLOUD_SECRET_KEY","TENCENT_TOKENPLAN_TEAM_ID"]:[...new Set(Object.values(s.request?.headers??{})',
  },
  {
    id: 'client/config-note',
    file: 'lib/client.js',
    find: 'a(d?"tokenRhythmBalanceNote":u?"aliyunBalanceNote":"customBalanceConfigNote")',
    replace: 'q?(H(w)==="en"?"Queries Tencent Cloud TokenHub directly with TC3 signing. Enter the cloud API SecretId/SecretKey below. The endpoint returns only the remaining credit; used points and the percentage are computed against the 1,980 monthly total.":"插件以 TC3 签名直连腾讯云 TokenHub 查询；在下方填写云 API 的 SecretId/SecretKey。接口只返回剩余 credit（积分），已用与完整比例按月总量 1980 积分自行计算。") :a(d?"tokenRhythmBalanceNote":u?"aliyunBalanceNote":"customBalanceConfigNote")',
  },
  {
    // 积分单位不做汇率换算，隐藏「折算成显示货币」开关与说明。
    id: 'client/hide-convert-toggle',
    file: 'lib/client.js',
    find: '),!d&&n("label",{className:"cm-check"},n("input",{type:"checkbox",checked:s.convertToDisplayCurrency===!0',
    replace: '),!d&&!q&&n("label",{className:"cm-check"},n("input",{type:"checkbox",checked:s.convertToDisplayCurrency===!0',
  },
  {
    id: 'client/hide-convert-note',
    file: 'lib/client.js',
    find: '),!d&&n("p",{className:"cm-note"},a("customBalanceConvertNote"))',
    replace: '),!d&&!q&&n("p",{className:"cm-note"},a("customBalanceConvertNote"))',
  },
  {
    id: 'client/credential-label',
    file: 'lib/client.js',
    find: 'n("label",null,d?"Token Rhythm Cookie":a("customBalanceCredentialsTitle"))',
    replace: 'n("label",null,q?(H(w)==="en"?"Tencent Cloud API keys (SecretId / SecretKey)":"腾讯云 API 密钥 (SecretId / SecretKey)"):d?"Token Rhythm Cookie":a("customBalanceCredentialsTitle"))',
  },
  {
    id: 'client/credential-placeholder',
    file: 'lib/client.js',
    find: 'placeholder:d?"tr_session=…":"{{"+B+"}}"',
    replace: 'placeholder:q?B:d?"tr_session=…":"{{"+B+"}}"',
  },
  {
    id: 'client/preset',
    file: 'lib/client.js',
    find: 'k=(y="custom")=>{if(!(d.length>=8)){if(y==="workbuddy2api"){',
    replace: 'k=(y="custom")=>{if(!(d.length>=8)){if(y==="tencent-tokenplan"){m([...d,{adapter:"tencent-tokenplan",enabled:!1,label:"腾讯 Token Plan 个人版",labelEn:"Tencent Token Plan (Personal)",dashboardUrl:"https://console.cloud.tencent.com/tokenhub/tokenplan/common",display:"both",unit:"CREDITS",refreshMinutes:15,request:{url:"",method:"GET",headers:{}},extract:{},allowedHosts:[]}]);return}if(y==="workbuddy2api"){',
  },
  {
    id: 'client/add-button',
    file: 'lib/client.js',
    find: 'n("button",{className:"cm-btn small",onClick:()=>k("workbuddy2api"),disabled:d.length>=8},a("workBuddyBalanceAdd"))',
    replace: 'n("button",{className:"cm-btn small",onClick:()=>k("workbuddy2api"),disabled:d.length>=8},a("workBuddyBalanceAdd")),n("button",{className:"cm-btn small",onClick:()=>k("tencent-tokenplan"),disabled:d.length>=8},H(t.config)==="en"?"+ Tencent Token Plan (Personal)":"+ 腾讯 Token Plan 个人版")',
  },
]

/** package.json 的结构化改动（不用正则，避免破坏 JSON）。 */
export const PACKAGE_NETWORK_HOST = 'https://tokenhub.tencentcloudapi.com'
export const PACKAGE_DOC_ENTRY = 'docs/tencent-token-plan.md'

/** 打完后应能通过 node --check 的文件。 */
export const SYNTAX_CHECK_FILES = [
  'lib/tencent-token-plan.js',
  'lib/custom-balance.js',
  'lib/store.js',
  'lib/typert.host.js',
  'lib/client.js',
  'lib/ledger-writer-worker.js',
]
