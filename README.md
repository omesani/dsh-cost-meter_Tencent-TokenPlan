# 腾讯 Token Plan 个人版 · dsh-cost-meter 补丁

在 dsh-cost-meter 的侧栏和设置页显示腾讯 Token Plan 个人版的剩余 Credits、已用 Credits 与进度条。直接使用现有 env 密钥，无需中继服务。

Node.js ≥20；已验证 dsh-cost-meter **1.9.58、1.9.60**。其他版本按实际代码预检，不能保证所有后续版本自动兼容。

## 部署

在本仓库目录运行，默认目标是 DSH 的 `web` 配置：

```bash
node install.mjs --dry-run
node install.mjs
```

安装成功只表示代码已写入。**重启 DSH 宿主，再刷新网页**；仅刷新网页可能仍使用旧的后端代码。

首次使用，在 **设置 → 费用 → 额度** 添加「腾讯 Token Plan 个人版」，启用并选择在侧栏显示。到 **费用 → 显示** 打开「余额进度条」，关闭「仅文字」。进度条是 cost-meter 自带组件，补丁只提供积分数据。

最后检查：

```bash
node check.mjs --live
```

它检查磁盘补丁、账本开关，并用现有 env / 进程密钥发起一次真实只读查询。然后在网页的腾讯条目点击「刷新」，确认侧栏数值和进度条。

**代码安装成功、接口查询成功、网页显示正常是三个不同的验收结果。** `check.mjs` 不会替你重启宿主或操作网页。

## cost-meter 升级后

1. 更新本补丁源码；Git 版本可运行 `git pull --ff-only`，ZIP 版本替换为新的修订源码目录。
2. 在补丁目录重新运行 `node install.mjs`。若预检失败，插件文件保持原样；不要绕过错误继续使用。
3. 重启 DSH 宿主并刷新网页。
4. 运行 `node check.mjs --live`，再在网页确认结果。

升级通常会覆盖插件文件，也可能把不认识的 `adapter` 配置清掉。若旧腾讯条目变成普通自定义请求或提示 URL 为空，用「腾讯 Token Plan 个人版」预设重建该条目，再删除停用的旧条目；**不需要重填 env 密钥**。

脚本只修改插件代码，**不修改 env、账本、模型配置，也不自动重启 DSH**。

## 密钥与积分

默认读取 `~/.dsh/tencent-tokenplan.env`；设置了 `DSH_HOME` 时改读其目录下的同名文件。已有文件直接保留。

```dotenv
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

首次创建文件可参考 `examples/tencent-tokenplan.env.example`，将权限设为 `600`；已有文件不要覆盖。

使用腾讯云 **云 API 密钥**，SecretId 应以 `AKID` 开头，`sk-tp-` 推理 Key 无法查询套餐额度。是否有查询权限应以实际请求结果为准，不能根据旧注释推断。

凭据优先级：**env 文件 → 进程环境 → 原有 DSH 凭据库**。只使用同一来源的完整密钥对，临时 Token 也与密钥同源。每次查询重新读取 env，修改文件后点击刷新即可。

| 可选配置 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENT_TOKENPLAN_MONTHLY_CREDITS` | `1980` | 显示总积分，必须大于零 |
| `TENCENTCLOUD_REGION` | `ap-guangzhou` | 查询地域 |
| `TENCENT_TOKENPLAN_PRODUCT_TYPE` | `personal` | Hy 个人版可用 `personal-hunyuan` |
| `TENCENT_TOKENPLAN_CREDIT_PATH` | 空 | 特殊响应的剩余积分点分路径 |
| `TENCENTCLOUD_TOKEN` | 空 | 临时密钥的会话 Token |
| `TENCENT_TOKENPLAN_ENV_FILE` | 上述默认文件 | 自定义文件路径，必须在宿主进程环境中指定 |

除文件路径外，可选配置可写入 env 文件；同名进程环境配置优先。env 支持普通赋值、引号、`export` 和行尾注释，不执行 shell 命令或变量展开。

当前个人版响应的计算：

```text
剩余积分 = TotalCredits - TotalUsed
显示总额 = 1980（或显式配置）
显示已用 = max(0, 显示总额 - 剩余积分)
剩余比例 = 剩余积分 / 显示总额
```

也接受明确的剩余积分字段。缺失或无效数据会报错，不会假装成零余额或满额。真实积分不会被截断到配置的显示上限；进度条的宽度由原组件限制。

本项目只查询个人版套餐，固定调用 `DescribeTokenPlanPersonalPackage`。不再使用旧的企业版 Action / TeamId 配置。

## 命令

| 命令 | 用途 |
| --- | --- |
| `node install.mjs --dry-run` | 只预检，不写入 |
| `node install.mjs` | 预检、备份并安装；重复执行零重复改动 |
| `node check.mjs` | 只检查磁盘代码与本地配置，不发网络请求 |
| `node check.mjs --live` | 额外验证真实腾讯接口，不输出密钥 |
| `node verify.mjs` | 用模拟响应做集成自检，不能代替真实查询 |
| `node uninstall.mjs --list` | 列出安装备份 |
| `node uninstall.mjs --backup <目录>` | 回退指定的一次安装 |

部署、检查、自检和回退都支持 `--profile desktop` 或 `--plugin <插件目录>`；默认 `--profile web`。也可用 `DSH_COST_METER_DIR` 指定插件目录。

备份位于 `$DSH_HOME/tencent-tokenplan-backups/`。回退会核对插件版本、当前文件及备份内容，避免覆盖升级或手工修改。**回退最近一次小更新，不等于卸载之前所有补丁。** 要完全恢复官方代码，重新安装对应版本的 dsh-cost-meter，再重启 DSH。新版回退脚本不自动处理缺少内容校验记录的旧备份。

## 常见问题

| 现象 | 下一步 |
| --- | --- |
| 预检提示某个锚点不匹配 | 保留插件版本号与失败项，按[维护说明](docs/maintenance.md)更新对应补丁；目标文件未改动 |
| 安装写入被系统拒绝 | 使用有权写入 DSH 插件目录的终端或批准该次必要写入，再重试 |
| 网页仍拒绝 `tencent-tokenplan` / 要求填写 URL | 先确认补丁完整，再重启 DSH；升级丢失标记时重建腾讯条目 |
| 查询正常但没有条 | 打开「余额进度条」，关闭「仅文字」，确认条目在侧栏显示 |
| `SecretIdNotFound` | 检查 SecretId 是否有效，不要使用推理 Key |
| `SignatureFailure` | 核对密钥配对与本机时间 |
| 鉴权或权限错误 | 按真实错误码检查密钥有效性及套餐查询权限 |
| 页面凭据输入框显示「未配置」 | 该状态只反映凭据库；env 凭据以实际刷新结果为准 |

接口使用 [TC3 签名](https://cloud.tencent.com/document/api/1823/132284)，只访问固定的 `tokenhub.tencentcloudapi.com`，禁止跟随重定向。SecretKey 只参与本地签名。标准个人版 1980 积分依据[套餐概览](https://cloud.tencent.com/document/product/1823/130060)。

MIT，保留原项目版权。
