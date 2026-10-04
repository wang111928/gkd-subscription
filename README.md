# vivo X100 Pro 本机专属定制 GKD 订阅

本项目为专为 vivo X100 Pro (V2301A) 量身定制的高性能、极简 GKD 订阅规则。

基于真实安装的 500+ 应用列表，结合开源优质规则池及本地逆向提取，精简剔除 1900+ 无关应用规则，体积较原版缩减逾 55%，保障超低内存占用与秒级跳过。

## 订阅地址 (复制任一链接至 GKD 客户端添加)

- **国内推荐 (jsDelivr 官方主源，秒级刷新)**:
  ```text
  https://cdn.jsdelivr.net/gh/wang111928/gkd-subscription@main/dist/gkd.json5
  ```
- **固定 v9 版本直链 (永不产生缓存延迟)**:
  ```text
  https://cdn.jsdelivr.net/gh/wang111928/gkd-subscription@v9/dist/gkd.json5
  ```
- **GitHub Raw 直链**:
  ```text
  https://raw.githubusercontent.com/wang111928/gkd-subscription/main/dist/gkd.json5
  ```

## 订阅信息

- **ID**: `88888`
- **版本**: `v9` (快手广告 SDK 核心跳过 View ID 及主流遗漏 ID 全量并联入 FAST_ID_SELECTOR，彻底解决大学搜题酱等遭遇快手美团开屏广告秒跳问题)
- **覆盖应用**: 78 款已装核心应用，548 个规则组，918 条规则
- **性能优化**: 严格符合 GKD 官方 fastQuery 规范（精确 `vid` 聚集抢跑首层，[width<600 && height<400] 宽屏放宽），毫秒级优先级反转结构，纯文本兜底，全量防误触 (`visibleToUser: true`)，金融支付受保护黑名单全量保留。

## 本地更新与构建

在电脑端保持手机 USB/ADB 连接，执行：
```bash
node scripts/build.js
```
将自动获取最新安装包列表、重新编译规则并同步推送到手机。
