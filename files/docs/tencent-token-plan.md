# 腾讯 Token Plan 个人版额度（原生接入）

在「设置 → 费用 → 额度 → 自定义 Provider 余额」里点击 **+ 腾讯 Token Plan 个人版**，
填入腾讯云 API 的 SecretId / SecretKey 并启用，即可在侧栏和设置页看到剩余积分、
已用积分与进度条百分比。

这是插件原生 adapter（`adapter: "tencent-tokenplan"`），由插件自己发起只读的
腾讯云管控面请求，**不需要**额外运行 `tokenhub-relay.cjs` 之类的中继进程。

## 接口与字段口径

| 项 | 值 |
| --- | --- |
| 域名 | `https://tokenhub.tencentcloudapi.com/` |
| 服务 / 版本 | `tokenhub` / `2026-03-22` |
| 个人版 Action | `DescribeTokenPlanPersonalPackage`，请求体 `{"ProductType":"personal"}`（Hy 版为 `personal-hunyuan`）|
| 企业版对照 | `DescribeTokenPlan`（[文档 132270](https://cloud.tencent.com/document/product/1823/132270)），需要 `TeamId`，本卡片默认不用 |
| 鉴权 | TC3-HMAC-SHA256 签名（[签名方法 v3](https://cloud.tencent.com/document/api/1823/132284)），SecretId/SecretKey |
| Region | 默认 `ap-guangzhou`（可用 `TENCENTCLOUD_REGION` 覆盖）|

官方文档：

- [查询 Token Plan 套餐详情（企业版）](https://cloud.tencent.com/document/product/1823/132270)
- [查询 Token Plan 套餐列表](https://cloud.tencent.com/document/product/1823/132269)
- [公共参数 / 地域列表 / service=tokenhub](https://cloud.tencent.com/document/api/1823/132283)
- [签名方法 v3](https://cloud.tencent.com/document/api/1823/132284)
- [个人版套餐概览（1980 积分）](https://cloud.tencent.com/document/product/1823/130060)
- [个人版积分抵扣规则](https://cloud.tencent.com/document/product/1823/133811)
- [积分抵扣机制调整公告](https://cloud.tencent.com/announce/detail/2432)

### 只回传 credit，比例自行计算

接口不提供「百分比 / 完整比例」，需要自行计算。实测（2026-11-07，通用 Standard 档）
`DescribeTokenPlanPersonalPackage` 返回的是**扁平结构**，没有单独的 `credit` 字段，
而是给出总量与已用量：

```json
{
  "Response": {
    "ProductType": "personal",
    "PackageStatus": "ACTIVE",
    "TotalCredits": "1980",
    "CycleCredits": "1980",
    "TotalUsed": "555.99877936",
    "StartTime": "2026-11-04 15:09:03",
    "ExpireTime": "2026-12-04 15:09:02"
  }
}
```

因此本 adapter 先求出剩余 `credit`，再按用户确认的固定月积分总量计算完整比例：

```
credit    = TotalCredits - TotalUsed   # = 1424.00122064（或直接读单个 credit 字段）
maxBudget = 1980                      # 月积分总量
spend     = 1980 - credit             # = 555.99877936，与上游 TotalUsed 一致
remaining = credit
```

`dsh-cost-meter` 的自定义余额框架再用 `remaining / maxBudget` 渲染进度条和百分比
（本例 71.9% 剩余 / 28.1% 已用）。字段缺失、非数值、负值都会明确报错，
不会伪装成「余额 0」。

`1980` 是**通用 Token Plan（原 Token Plan）Standard / 基础套餐**每订阅月的积分
（¥99/月，见[套餐概览](https://cloud.tencent.com/document/product/1823/130060)）。
若你是 Lite / Pro / Max 或 Hy 系列，请设置 `TENCENT_TOKENPLAN_MONTHLY_CREDITS` 为对应档位：

| 系列 | Lite | Standard | Pro | Max |
| --- | --- | --- | --- | --- |
| 通用 Token Plan | 780 | **1980** | 5980 | 11980 |
| Hy Token Plan | 560 | 1560 | 4760 | 9360 |

### credit 字段解析顺序

1. `TENCENT_TOKENPLAN_CREDIT_PATH`（点分路径，例如 `Response.Credit`）指定时优先使用。
2. 常见的 `Response.Credit` / `Response.CreditBalance` / `credit` 等字段路径。
3. 响应里任意名为 `credit*` 的数值字段（有限递归，优先「remain / available」语义）。
4. 兼容官方 CLI 口径的 `TotalCredits` / `CycleCredits` 减 `TotalUsed`（**当前个人版接口实测走这一条**）。

递归扫描会排除 `TotalCredits` / `CycleCredits` / `UsedCredits` 这类「分母或已用量」
字段，避免把 1980 误当成剩余积分。字段缺失、非数值、负值都会明确报错，
不会伪装成「余额 0」。多周期套餐的 `TotalUsed` 口径官方未说明，
如发现与实际不符，用 `TENCENT_TOKENPLAN_CREDIT_PATH` 指定字段或改为单值接口。

## 启用步骤

1. **重启 DSH 宿主**：本次改动新增了宿主侧模块，运行中的宿主进程仍加载旧代码；
   重启后刷新浏览器页面。
2. 打开 **设置 → 费用 → 额度 → 自定义 Provider 余额**，点击 **+ 腾讯 Token Plan 个人版**。
   会生成一条默认关闭的卡片（单位 `CREDITS`、15 分钟刷新、控制台跳转链接）。
3. 在卡片的凭据输入框里填：
   - `TENCENTCLOUD_SECRET_ID`：云 API SecretId
   - `TENCENTCLOUD_SECRET_KEY`：云 API SecretKey
   - `TENCENT_TOKENPLAN_TEAM_ID`：留空即可（个人版不需要；仅切到企业版接口时用）

   凭据写入 DSH 凭据库，不落进账本、不下发明文到浏览器。
4. 打开卡片的「启用」开关，点「刷新」即可看到额度。

### `request.url` 保持空白

固定端点 adapter（`aliyun` / `tokenrhythm` / `tencent-tokenplan`）在
`queryCustomBalance` 里早于 `request.url` 分支返回，请求地址由 adapter 自己决定，
因此设置页对这类条目**不显示** URL 输入框，`request.url` 留空。

对应的校验也已放宽：`validateCustomBalanceEntry` 只在**非固定端点 adapter** 且
`enabled === true` 时要求 `request.url` 非空。普通「自定义余额」条目仍然必须填 URL。
早期版本对这类 adapter 一律要求非空 URL，启用时会报
「配置更新被拒绝：customBalance.request.url 必须是非空字符串」——升级到含本修复的
版本后不再出现。

> 密钥必须是**主账号**或已获 TokenHub 管控面读取权限的 CAM 密钥，不是 `sk-tp-`
> 推理 API Key。子账号缺少权限时会返回 `AuthFailure.UnauthorizedOperation`，
> 此时卡片会提示改用主账号密钥。

## 凭据的其它提供方式

按来源**成对**解析：DSH 凭据库（GUI 输入框）→ 进程环境变量 → 本地 env 文件
`~/.dsh/tencent-tokenplan.env`（可用 `TENCENT_TOKENPLAN_ENV_FILE` 改路径）。
**第一个同时提供 SecretId 与 SecretKey 的来源胜出**，绝不把 A 来源的 SecretId 和
B 来源的 SecretKey 拼成一把。这一点很重要：逐字段取优先级会把「凭据库里的
SecretId」和「env 文件里的 SecretKey」混搭成一把不存在的密钥，上游只回
`AuthFailure.SecretIdNotFound`，极难定位。

格式：

```dotenv
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

也支持把 `SecretId:SecretKey` 合并填进第一个输入框。
用临时密钥时可设置 `TENCENTCLOUD_TOKEN`。

### 常见鉴权错误怎么读

| 上游错误码 | 真正原因 | 怎么办 |
| --- | --- | --- |
| `AuthFailure.SecretIdNotFound` | SecretId 填成了 `sk-` 推理 Key，或 SecretId/SecretKey 来自不同密钥对 | 填 `AKID` 开头的云 API 密钥 |
| `AuthFailure.SignatureFailure` | 两个值不是同一把密钥，或本机时间偏差 > 5 分钟 | 核对密钥对、校准时间 |
| `AuthFailure.UnauthorizedOperation` | 密钥本身有效，但该账号/子账号没有 TokenHub 管控面权限 | 主账号授权后重试 |

插件会在发请求前先做形态自检：SecretId 不以 `AKID` 开头时直接报「SecretId 形态不对」
并指出**当前生效来源**，不会浪费一次上游调用，也不会误报成权限问题。

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENT_TOKENPLAN_MONTHLY_CREDITS` | `1980` | 月积分总量（分母） |
| `TENCENT_TOKENPLAN_CREDIT_PATH` | 空 | 指定 credit 字段的点分路径 |
| `TENCENT_TOKENPLAN_PRODUCT_TYPE` | `personal` | `personal-hunyuan` 切到 Hy 系列 |
| `TENCENT_TOKENPLAN_ACTION` | `DescribeTokenPlanPersonalPackage` | 设为 `DescribeTokenPlan` 走企业版接口（需配 `TENCENT_TOKENPLAN_TEAM_ID`） |
| `TENCENT_TOKENPLAN_TEAM_ID` | 空 | 企业版 TeamId |
| `TENCENTCLOUD_REGION` | `ap-guangzhou` | 请求地域 |
| `TENCENT_TOKENPLAN_ENV_FILE` | `~/.dsh/tencent-tokenplan.env` | 本地密钥文件 |

## 安全说明

- 只请求 `https://tokenhub.tencentcloudapi.com/`，`redirect: 'manual'` 禁止跟随重定向，
  避免凭据被带到其它主机。
- SecretKey 只用于本地 HMAC 派生，不进入请求头；SecretId 只出现在 `Authorization`
  的 `Credential` 中。响应中的账户身份、RequestId 等字段不下发浏览器。
- 每次网络重试重新生成时间戳与签名；请求体固定为只读的套餐查询。

## 与旧 relay 方案的关系

本目录曾尝试用独立 `tokenhub-relay.cjs`（本机 8791 端口）+ 自定义余额的
`extract.expression` 表达式接入；那需要常驻一个外部进程，并且当时的子账号密钥
没有 TokenHub 管控面权限。原生 adapter 不需要中继；旧 relay 可保留作查看
`/raw` 原始响应、排查字段变化的手段。

## English summary

A native custom-balance adapter (`tencent-tokenplan`) signs TC3 requests to
`tokenhub.tencentcloudapi.com` with your cloud API SecretId/SecretKey and reads
the remaining `credit`. As the endpoint exposes no total or percentage, the
plugin computes `spend = 1980 - credit` and uses `maxBudget = 1980` (the
Standard tier of the general Token Plan) to render the progress bar. Override
the monthly total with `TENCENT_TOKENPLAN_MONTHLY_CREDITS` for other tiers.
Restart the DSH host once after installing this change.
