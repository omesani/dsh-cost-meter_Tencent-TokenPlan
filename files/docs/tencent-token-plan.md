# 腾讯 Token Plan 个人版额度（原生 adapter）

在「设置 → 费用 → 额度 → 自定义 Provider 余额」点击 **+ 腾讯 Token Plan 个人版**并启用，
侧栏与设置页即可显示剩余积分、已用积分和进度条百分比。

这是插件原生 adapter（`adapter: "tencent-tokenplan"`）：插件自己签名并直连腾讯云管控面，
**不需要**外部中继进程。

## 接口与字段

| 项 | 值 |
| --- | --- |
| 域名 | `https://tokenhub.tencentcloudapi.com/` |
| 服务 / 版本 | `tokenhub` / `2026-03-22` |
| 个人版 Action | `DescribeTokenPlanPersonalPackage`，体 `{"ProductType":"personal"}`（Hy 系列 `personal-hunyuan`） |
| 企业版对照 | `DescribeTokenPlan`（[132270](https://cloud.tencent.com/document/product/1823/132270)），需 `TeamId` |
| 鉴权 | TC3-HMAC-SHA256（[签名 v3](https://cloud.tencent.com/document/api/1823/132284)），SecretId/SecretKey |
| 地域 | 默认 `ap-guangzhou`，可用 `TENCENTCLOUD_REGION` 覆盖 |

## 比例自行计算

接口只给用量，不给百分比。实测（2026-11-07，通用 Standard）返回扁平结构：

```json
{ "Response": { "PackageStatus": "ACTIVE", "TotalCredits": "1980",
                "CycleCredits": "1980", "TotalUsed": "555.99877936",
                "StartTime": "2026-11-04 15:09:03", "ExpireTime": "2026-12-04 15:09:02" } }
```

因此先求剩余 credit，再按固定月总量算完整比例：

```
credit    = TotalCredits - TotalUsed     # 或直接读单个 credit 字段
maxBudget = 1980                         # 月积分总量
spend     = maxBudget - credit
remaining = credit
```

框架按 `remaining / maxBudget` 渲染进度条（上例 71.9% 剩余 / 28.1% 已用）。

`1980` 是**通用 Token Plan Standard** 每订阅月积分（¥99/月，
见[套餐概览](https://cloud.tencent.com/document/product/1823/130060)）。其它档位用
`TENCENT_TOKENPLAN_MONTHLY_CREDITS` 覆盖：

| 系列 | Lite | Standard | Pro | Max |
| --- | --- | --- | --- | --- |
| 通用 | 780 | **1980** | 5980 | 11980 |
| Hy | 560 | 1560 | 4760 | 9360 |

## credit 解析顺序

1. `TENCENT_TOKENPLAN_CREDIT_PATH`（点分路径，如 `Response.Credit`）。
2. 常见路径：`Response.Credit` / `Response.CreditBalance` / `credit` 等。
3. 有界递归：任意名为 `credit*` 的数值字段，排除 `Total*` / `Cycle*` / `*Used` 等分母与已用量。
4. `TotalCredits` / `CycleCredits` 减 `TotalUsed`（**当前个人版接口走这一条**）。

字段缺失、非数值、负值都明确报错，不会伪装成「余额 0」。

## 启用

1. 重启 DSH 宿主并刷新页面（宿主侧模块在启动时加载）。
2. **设置 → 费用 → 额度 → 自定义 Provider 余额 →** 点 **+ 腾讯 Token Plan 个人版**。
3. 填凭据（见下）→ 打开「启用」→ 点「刷新」。

### `request.url` 留空

固定端点 adapter（`aliyun` / `tokenrhythm` / `tencent-tokenplan`）在 `queryCustomBalance`
里早于 `request.url` 分支返回，地址由 adapter 决定，设置页也不显示 URL 输入框。
校验只在**非固定端点 adapter** 且 `enabled === true` 时要求 URL 非空；
普通「自定义余额」条目仍必须填 URL。

## 凭据

必须是**云 API 密钥**（SecretId 以 `AKID` 开头，在
<https://console.cloud.tencent.com/capi> 获取），**不是** `sk-tp-` 推理 Key。
需要主账号，或已授予 TokenHub 管控面读取权限的 CAM 子账号。

按来源**成对**解析：DSH 凭据库 → 进程环境变量 → 本地 env 文件，
**第一个同时提供 SecretId 与 SecretKey 的来源胜出**，绝不跨来源混搭。

```dotenv
# ~/.dsh/tencent-tokenplan.env（权限 600）
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

也支持把 `SecretId:SecretKey` 合并填在 SecretId 槽位。临时密钥可设 `TENCENTCLOUD_TOKEN`。

### 鉴权错误对照

| 上游错误码 | 真正原因 | 处理 |
| --- | --- | --- |
| `AuthFailure.SecretIdNotFound` | SecretId 填成了 `sk-` 推理 Key，或两个值来自不同密钥对 | 填 `AKID` 开头的云 API 密钥 |
| `AuthFailure.SignatureFailure` | 密钥不配对，或本机时间偏差 > 5 分钟 | 核对密钥对、校准时间 |
| `AuthFailure.UnauthorizedOperation` | 密钥有效但账号无 TokenHub 管控面权限 | 主账号授权 |

发请求前会先做形态自检：SecretId 不以 `AKID` 开头时直接报错并指出**当前生效来源**，
不浪费上游调用，也不会误报成权限问题。

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENT_TOKENPLAN_MONTHLY_CREDITS` | `1980` | 月积分总量（分母） |
| `TENCENT_TOKENPLAN_CREDIT_PATH` | 空 | credit 字段点分路径 |
| `TENCENT_TOKENPLAN_PRODUCT_TYPE` | `personal` | `personal-hunyuan` 切 Hy 系列 |
| `TENCENT_TOKENPLAN_ACTION` | `DescribeTokenPlanPersonalPackage` | 改 `DescribeTokenPlan` 走企业版（需 TeamId） |
| `TENCENT_TOKENPLAN_TEAM_ID` | 空 | 企业版套餐 ID |
| `TENCENTCLOUD_REGION` | `ap-guangzhou` | 请求地域 |
| `TENCENT_TOKENPLAN_ENV_FILE` | `~/.dsh/tencent-tokenplan.env` | 本地密钥文件 |

## 安全

- 只请求 `tokenhub.tencentcloudapi.com`，`redirect: 'manual'` 禁跟随重定向。
- SecretKey 仅参与本地 HMAC 派生，**不出现在任何请求头**；SecretId 仅出现在
  `Authorization` 的 `Credential`。
- 响应中的账户身份、RequestId 等字段不下发浏览器；每次重试重新生成时间戳与签名。
