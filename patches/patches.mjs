// dsh-cost-meter 集成补丁；安装前校验全部锚点，重复安装跳过已应用项。
export const TESTED_PLUGIN_VERSIONS = ['1.9.58', '1.9.60']

/** 新增文件：直接从 files/ 复制到插件同名路径。 */
export const NEW_FILES = [
  ['files/lib/tencent-token-plan.js', 'lib/tencent-token-plan.js'],
  ['files/docs/tencent-token-plan.md', 'docs/tencent-token-plan.md'],
]

// find → replace；正则项另给 installed 检测，命中数量必须一致。
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
    id: 'store/self-resolving-url',
    file: 'lib/store.js',
    find: '(entry.enabled === true && request.url.length === 0)',
    replace: "(entry.enabled === true && request.url.length === 0 && !['aliyun', 'tokenrhythm', 'tencent-tokenplan'].includes(entry.adapter))",
    accept: ["const selfResolving = ['aliyun', 'tokenrhythm', 'tencent-tokenplan'].includes(entry.adapter)", '(entry.enabled === true && request.url.length === 0 && !selfResolving)'],
  },

  // ── typert.host.js：RPC 配置 schema（两处）────────────────────────────
  {
    id: 'typert/adapter-enum',
    file: 'lib/typert.host.js',
    find: "z.enum(['custom', 'aliyun', 'tokenrhythm']).optional()",
    replace: "z.enum(['custom', 'aliyun', 'tokenrhythm', 'tencent-tokenplan']).optional()",
    expect: 2,
  },

  // ── ledger-writer-worker.js：生成的 worker 内嵌副本 ────────────────────
  {
    id: 'worker/adapter-allowlist',
    file: 'lib/ledger-writer-worker.js',
    find: /\["aliyun","tokenrhythm"\]\.includes\(([\w$]+)\.adapter\)/g,
    replace: (_, entry) => `["aliyun","tokenrhythm","tencent-tokenplan"].includes(${entry}.adapter)`,
    installed: /\["aliyun","tokenrhythm","tencent-tokenplan"\]\.includes\([\w$]+\.adapter\)/g,
  },

  // ── client.js：设置页白名单、预设按钮、凭据输入框（压缩产物，锚点唯一）──
  {
    id: 'client/adapter-allowlist',
    file: 'lib/client.js',
    find: /\["aliyun","tokenrhythm"\]\.includes\(([\w$]+)\.adapter\)\?\{adapter:\1\.adapter\}:\{\}/g,
    replace: (_, entry) => `["aliyun","tokenrhythm","tencent-tokenplan"].includes(${entry}.adapter)?{adapter:${entry}.adapter}:{}`,
    installed: /\["aliyun","tokenrhythm","tencent-tokenplan"\]\.includes\(([\w$]+)\.adapter\)\?\{adapter:\1\.adapter\}:\{\}/g,
  },
  {
    id: 'client/self-resolving-flag',
    file: 'lib/client.js',
    find: 'u=s.adapter==="aliyun",d=s.adapter==="tokenrhythm",m=u||d,',
    replace: 'u=s.adapter==="aliyun",d=s.adapter==="tokenrhythm",q=s.adapter==="tencent-tokenplan",m=u||d||q,',
  },
  {
    id: 'client/credential-vars',
    file: 'lib/client.js',
    find: ':d?["TOKENRHYTHM_COOKIE"]:[...new Set(Object.values(s.request?.headers??{})',
    replace: ':d?["TOKENRHYTHM_COOKIE"]:q?["TENCENTCLOUD_SECRET_ID","TENCENTCLOUD_SECRET_KEY"]:[...new Set(Object.values(s.request?.headers??{})',
  },
  {
    id: 'client/config-note',
    file: 'lib/client.js',
    find: 'a(d?"tokenRhythmBalanceNote":u?"aliyunBalanceNote":"customBalanceConfigNote")',
    replace: 'q?(H(w)==="en"?"Reads cloud API credentials from ~/.dsh/tencent-tokenplan.env first; no need to enter them again. Remaining credits = total credits minus used credits. The progress bar uses a total of 1,980 credits by default.":"优先读取 ~/.dsh/tencent-tokenplan.env 中的云 API 密钥，无需重复填写。剩余积分 = 总积分 − 已用积分；进度条默认按总额 1980 积分计算。") :a(d?"tokenRhythmBalanceNote":u?"aliyunBalanceNote":"customBalanceConfigNote")',
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
