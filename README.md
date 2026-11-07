# dsh-cost-meter · 腾讯 Token Plan 个人版额度

给 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 加一个**原生**额度来源：
插件自己用腾讯云 API 的 SecretId/SecretKey 做 TC3-HMAC-SHA256 签名，直连
`https://tokenhub.tencentcloudapi.com/` 查询「通用 Token Plan 个人版」剩余积分，
在侧栏和设置页显示**剩余积分 / 已用积分 / 进度条百分比**。

不需要额外运行中继进程（早期 `tokenhub-relay.cjs` 方案已不再需要）。

## 支持版本

| 组件 | 版本 |
| --- | --- |
| dsh-cost-meter | **1.9.58**（基线，补丁锚点按此版本校验） |
| DeepSeek Harness | 0.2.2-rc.1 |
| Node.js | >= 20 |

验证日期：2026-11-07。插件版本不同也会尝试应用，锚点不匹配时会明确报错而不是半应用。

## 特性

- **接口只给 credit，比例自行计算**：`remaining = credit`、`spend = 1980 - credit`、
  `maxBudget = 1980`，插件据此渲染进度条与百分比。
- **月积分总量可改**：1980 对应通用 Token Plan **Standard**；Lite 780 / Pro 5980 /
  Max 11980，Hy 系列 560 / 1560 / 4760 / 9360，用 `TENCENT_TOKENPLAN_MONTHLY_CREDITS` 覆盖。
- **凭据成对解析**：SecretId 与 SecretKey 必须来自同一来源，绝不跨来源拼成假密钥。
- **发请求前做形态自检**：SecretId 不以 `AKID` 开头（例如误填 `sk-` 推理 Key）会直接给出
  可操作提示，并指出当前生效来源。
- **错误码精确**：`SecretIdNotFound` / `SignatureFailure` / `UnauthorizedOperation` 分别提示，
  不再一律归为「权限问题」。

## 安装

```bash
git clone https://github.com/omesani/dsh-cost-meter_Tencent-TokenPlan.git
cd dsh-cost-meter_Tencent-TokenPlan

node install.mjs            # 自动定位插件并应用（幂等，可重复执行）
node verify.mjs             # 自检：签名/解析/凭据/配置校验，全部使用假密钥
```

常用参数：

```bash
node install.mjs --dry-run                  # 只预览，不写文件
node install.mjs --plugin <插件目录>         # 手动指定
node install.mjs --force                    # 非基线版本也尝试
```

安装前会把被改文件备份到 `~/.dsh/tencent-tokenplan-backups/<时间戳>/`（不在仓库内）。

## 配置密钥

任选其一，**SecretId 与 SecretKey 必须成对**，且是**云 API 密钥**（`AKID` 开头，
在 <https://console.cloud.tencent.com/capi> 获取），**不是** `sk-tp-` 推理 API Key。

### 方式 A：本地 env 文件（推荐，跨设备各存一份）

```bash
cp examples/tencent-tokenplan.env.example ~/.dsh/tencent-tokenplan.env
chmod 600 ~/.dsh/tencent-tokenplan.env
# 编辑该文件，填入真实值
```

```dotenv
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

### 方式 B：设置页卡片输入框

值写入 DSH 凭据库，不落进账本、不下发明文到浏览器。

### 方式 C：进程环境变量

`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`。

> 凭据库字段若填了 `sk-` 推理 Key，会被形态自检拦下并提示；成对解析也会跳过这种
> 「只配一半」的来源，自动回退到下一个完整来源。

## 启用

1. **重启 DSH 宿主**并刷新页面（宿主侧代码在启动时加载）。
2. **设置 → 费用 → 额度 → 自定义 Provider 余额 →** 点 **「+ 腾讯 Token Plan 个人版」**。
3. 打开卡片的「启用」开关，点「刷新」。

卡片默认：单位 `CREDITS`、15 分钟刷新、跳转链接指向
<https://console.cloud.tencent.com/tokenhub/tokenplan/common>。

## dsh / 插件升级后

```bash
cd dsh-cost-meter_Tencent-TokenPlan
git pull
node install.mjs      # 重新把补丁打到新版本上
node verify.mjs
```

- 已应用的条目自动跳过（幂等），只有新版本新增/变化的部分需要重打。
- 若插件压缩产物变化导致锚点位移，安装器会列出**具体哪条补丁失败**，不会静默半应用。
- 升级会覆盖 `node_modules`，所以**每次升级插件后都要重跑一次 `install.mjs`**。

## 卸载

```bash
node uninstall.mjs --list     # 查看备份
node uninstall.mjs            # 还原最近一次备份
```

新增的 `lib/tencent-token-plan.js` 与 `docs/tencent-token-plan.md` 不会被自动删除，
需要时手动删掉。

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENT_TOKENPLAN_MONTHLY_CREDITS` | `1980` | 月积分总量（分母） |
| `TENCENT_TOKENPLAN_CREDIT_PATH` | 空 | 指定 credit 字段点分路径 |
| `TENCENT_TOKENPLAN_PRODUCT_TYPE` | `personal` | `personal-hunyuan` 切 Hy 系列 |
| `TENCENT_TOKENPLAN_ACTION` | `DescribeTokenPlanPersonalPackage` | 设为 `DescribeTokenPlan` 走企业版（需 TeamId） |
| `TENCENT_TOKENPLAN_TEAM_ID` | 空 | 企业版套餐 ID |
| `TENCENTCLOUD_REGION` | `ap-guangzhou` | 请求地域 |
| `TENCENT_TOKENPLAN_ENV_FILE` | `~/.dsh/tencent-tokenplan.env` | 本地密钥文件路径 |
| `DSH_COST_METER_DIR` | 自动探测 | 插件目录 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `AuthFailure.SecretIdNotFound` | SecretId 填成了 `sk-` 推理 Key，或两个值来自不同密钥对 | 填 `AKID` 开头的云 API 密钥 |
| `AuthFailure.SignatureFailure` | 密钥不配对，或本机时间偏差 > 5 分钟 | 核对密钥对、校准时间 |
| `AuthFailure.UnauthorizedOperation` | 密钥有效但账号/子账号没有 TokenHub 管控面权限 | 主账号授权后重试 |
| `未读取到有效的 credit` | 响应结构变化 | 用 `TENCENT_TOKENPLAN_CREDIT_PATH` 指定字段 |
| 启用时报 `request.url 必须是非空字符串` | 旧版校验未豁免固定端点 adapter | 运行 `node install.mjs` 打全补丁后重启 |

## 安全

- 本仓库**不含任何真实密钥**；文档与示例中的凭据一律以 `***` 表示。
- SecretKey 只参与本地 HMAC 派生，**不出现在任何请求头**；SecretId 仅出现在
  `Authorization` 的 `Credential` 中。
- 只请求 `tokenhub.tencentcloudapi.com`，`redirect: 'manual'` 禁止跟随重定向。
- 响应中的账户身份、RequestId 等字段不下发浏览器。
- `verify.mjs` 全程使用假密钥且不发起真实网络请求。

## 接口依据

- [DescribeTokenPlan（企业版）](https://cloud.tencent.com/document/product/1823/132270)
- [DescribeTokenPlanList](https://cloud.tencent.com/document/product/1823/132269)
- [公共参数 / service=tokenhub](https://cloud.tencent.com/document/api/1823/132283)
- [签名方法 v3](https://cloud.tencent.com/document/api/1823/132284)
- [个人版套餐概览（Standard 1980 积分）](https://cloud.tencent.com/document/product/1823/130060)
- [个人版积分抵扣规则](https://cloud.tencent.com/document/product/1823/133811)

个人版实际调用 `DescribeTokenPlanPersonalPackage`（同域名/同 Version/同签名，无需 TeamId）。

## 许可

MIT。本项目是在 MIT 许可的 dsh-cost-meter 上做的最小改动补丁，原始版权归其作者所有。
