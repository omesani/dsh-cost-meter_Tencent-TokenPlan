# dsh-cost-meter · 腾讯 Token Plan 个人版额度

给 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 增加一个**原生**额度来源：
插件用云 API 的 SecretId/SecretKey 做 TC3-HMAC-SHA256 签名，直连
`https://tokenhub.tencentcloudapi.com/` 查询「通用 Token Plan 个人版」剩余积分，
在侧栏与设置页显示**剩余积分 / 已用积分 / 进度条百分比**。

不需要额外中继进程。

## 支持版本

| 组件 | 版本 |
| --- | --- |
| dsh-cost-meter | **1.9.58**（基线，补丁锚点按此校验） |
| DeepSeek Harness | 0.2.2-rc.1 |
| Node.js | >= 20 |

验证日期 2026-11-07。非基线版本也会尝试，锚点不匹配时明确报错，不会半应用。

## 特性

- **接口只给用量，比例自算**：`remaining = credit`、`spend = 1980 - credit`、`maxBudget = 1980`。
- **月总量可改**：1980 对应通用 **Standard**；Lite 780 / Pro 5980 / Max 11980，
  Hy 系列 560 / 1560 / 4760 / 9360，用 `TENCENT_TOKENPLAN_MONTHLY_CREDITS` 覆盖。
- **凭据成对解析**：SecretId 与 SecretKey 必须同源，绝不跨来源拼成假密钥。
- **形态自检**：SecretId 不以 `AKID` 开头（如误填 `sk-` 推理 Key）时，发请求前就报错并指出生效来源。
- **错误码分明**：`SecretIdNotFound` / `SignatureFailure` / `UnauthorizedOperation` 各自提示。

## 安装

```bash
git clone https://github.com/omesani/dsh-cost-meter_Tencent-TokenPlan.git
cd dsh-cost-meter_Tencent-TokenPlan
node install.mjs      # 自动定位插件并应用（幂等）
node verify.mjs       # 自检，全部使用假密钥
```

```bash
node install.mjs --dry-run             # 预览
node install.mjs --plugin <插件目录>    # 手动指定
node install.mjs --force               # 非基线版本也尝试
```

改动前会备份到 `~/.dsh/tencent-tokenplan-backups/<时间戳>/`。

## 配置密钥

**云 API 密钥**（SecretId 以 `AKID` 开头，在 <https://console.cloud.tencent.com/capi> 获取），
**不是** `sk-tp-` 推理 Key；需主账号或已授予 TokenHub 管控面读取权限的 CAM 子账号。
SecretId 与 SecretKey 必须成对。

任选一种来源（优先级：DSH 凭据库 → 环境变量 → 本地文件）：

```bash
cp examples/tencent-tokenplan.env.example ~/.dsh/tencent-tokenplan.env
chmod 600 ~/.dsh/tencent-tokenplan.env
# 填入真实值
```

```dotenv
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

也可以在设置页卡片的凭据输入框里填（写入 DSH 凭据库，不下发明文）。

## 启用

1. **重启 DSH 宿主**并刷新页面（宿主侧代码启动时加载）。
2. **设置 → 费用 → 额度 → 自定义 Provider 余额 →** 点 **+ 腾讯 Token Plan 个人版**。
3. 打开「启用」→ 点「刷新」。

卡片默认：单位 `CREDITS`、15 分钟刷新、跳转链接指向
<https://console.cloud.tencent.com/tokenhub/tokenplan/common>。

## 插件或 DSH 升级后

```bash
git pull
node install.mjs      # 把补丁重新打到新版本
node verify.mjs
```

升级会覆盖 `node_modules`，**每次升级插件后都要重跑 `install.mjs`**。
已应用的条目自动跳过；压缩产物变化导致锚点位移时会列出具体失败项。

## 卸载

```bash
node uninstall.mjs --list     # 查看备份
node uninstall.mjs            # 还原最近一次
```

新增的 `lib/tencent-token-plan.js` 与 `docs/tencent-token-plan.md` 不会被自动删除。

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENT_TOKENPLAN_MONTHLY_CREDITS` | `1980` | 月积分总量（分母） |
| `TENCENT_TOKENPLAN_CREDIT_PATH` | 空 | credit 字段点分路径 |
| `TENCENT_TOKENPLAN_PRODUCT_TYPE` | `personal` | `personal-hunyuan` 切 Hy 系列 |
| `TENCENT_TOKENPLAN_ACTION` | `DescribeTokenPlanPersonalPackage` | 改 `DescribeTokenPlan` 走企业版（需 TeamId） |
| `TENCENT_TOKENPLAN_TEAM_ID` | 空 | 企业版套餐 ID |
| `TENCENTCLOUD_REGION` | `ap-guangzhou` | 请求地域 |
| `TENCENT_TOKENPLAN_ENV_FILE` | `~/.dsh/tencent-tokenplan.env` | 密钥文件路径 |
| `DSH_COST_METER_DIR` | 自动探测 | 插件目录 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `AuthFailure.SecretIdNotFound` | SecretId 填成 `sk-` 推理 Key，或两值不同源 | 填 `AKID` 开头的云 API 密钥 |
| `AuthFailure.SignatureFailure` | 密钥不配对，或时间偏差 > 5 分钟 | 核对密钥对、校准时间 |
| `AuthFailure.UnauthorizedOperation` | 密钥有效但无 TokenHub 管控面权限 | 主账号授权 |
| `未读取到有效的 credit` | 响应结构变化 | 用 `TENCENT_TOKENPLAN_CREDIT_PATH` 指定 |
| 启用报 `request.url 必须是非空字符串` | 旧版校验未豁免固定端点 adapter | 重跑 `install.mjs` 后重启 |

## 安全

- 仓库不含任何真实密钥；文档与示例中的凭据一律以 `***` 表示。
- SecretKey 只参与本地 HMAC 派生，**不出现在任何请求头**；SecretId 仅在
  `Authorization` 的 `Credential` 中。
- 只请求 `tokenhub.tencentcloudapi.com`，禁止跟随重定向；响应中的账户身份与
  RequestId 不下发浏览器。
- `verify.mjs` 全程假密钥、无真实网络请求。

## 接口依据

- [DescribeTokenPlan（企业版）](https://cloud.tencent.com/document/product/1823/132270) ·
  [DescribeTokenPlanList](https://cloud.tencent.com/document/product/1823/132269)
- [公共参数 service=tokenhub](https://cloud.tencent.com/document/api/1823/132283) ·
  [签名方法 v3](https://cloud.tencent.com/document/api/1823/132284)
- [个人版套餐概览（Standard 1980 积分）](https://cloud.tencent.com/document/product/1823/130060) ·
  [积分抵扣规则](https://cloud.tencent.com/document/product/1823/133811)

个人版实际调用 `DescribeTokenPlanPersonalPackage`（同域名/同 Version/同签名，无需 TeamId）。

## 许可

MIT。本项目是给 MIT 许可的 dsh-cost-meter 做的最小改动补丁，原始版权归其作者。
