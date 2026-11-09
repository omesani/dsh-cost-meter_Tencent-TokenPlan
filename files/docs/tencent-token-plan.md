# 腾讯 Token Plan 个人版额度

此适配器查询通用个人版套餐，以 Credits 显示余额。它复用 cost-meter 自带的余额进度条，不需要中继服务。

## 配置

现有 `~/.dsh/tencent-tokenplan.env` 可直接使用；自定义 `DSH_HOME` 时使用该目录下的同名文件：

```dotenv
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
# TENCENT_TOKENPLAN_MONTHLY_CREDITS=1980
```

使用 AKID 开头的云 API 密钥，不能使用 sk-tp- 推理 Key。env 文件优先，其次是进程环境和原有 DSH 凭据库；密钥对及临时 Token 必须同源。env 每次查询重读。页面凭据框的「未配置」不代表 env 无效。

## 显示

费用 → 额度：添加并启用「腾讯 Token Plan 个人版」，选择侧栏显示。

费用 → 显示：打开「余额进度条」，关闭「仅文字」。剩余积分通常由 `TotalCredits - TotalUsed` 得到；显示总额默认为 1980，已用与比例据此计算。缺字段会明确报错。

## 升级后

重新运行补丁安装器，重启 DSH 宿主并刷新网页，再点击腾讯条目的「刷新」。若条目丢失了专用适配器标记，用腾讯预设重建；env 密钥无需重填。

完整部署、可选配置与回退说明见补丁仓库 README。安装、自检通过不代表运行中的后端和页面已经加载新版代码。
