# vivo X100 Pro 本机专属定制 GKD 订阅

本项目为专为 vivo X100 Pro (V2301A) 量身定制的高性能、极简 GKD 订阅规则。

基于真实安装的 500+ 应用列表，结合开源优质规则池及本地逆向提取，精简剔除 1900+ 无关应用规则，体积较原版缩减逾 55%，保障超低内存占用与秒级跳过。

## 订阅地址 (复制任一链接至 GKD 客户端添加)

- **国内推荐 (jsDelivr CDN)**:
  ```text
  https://fastly.jsdelivr.net/gh/wang111928/gkd-subscription@main/dist/gkd.json5
  ```
- **备用加速源**:
  ```text
  https://jsd.admincdn.com/gh/wang111928/gkd-subscription@main/dist/gkd.json5
  ```
- **GitHub Raw 原源**:
  ```text
  https://raw.githubusercontent.com/wang111928/gkd-subscription/main/dist/gkd.json5
  ```

## 订阅信息

- **ID**: `88888`
- **版本**: `v1`
- **覆盖应用**: 79 款已装核心应用，506 个规则组，828 条规则
- **性能优化**: 全量开启 `quickFind: true`，防后台隐藏节点误触 (`visibleToUser: true`)，金融支付受保护黑名单全量保留。

## 本地更新与构建

在电脑端保持手机 USB/ADB 连接，执行：
```bash
node scripts/build.js
```
将自动获取最新安装包列表、重新编译规则并同步推送到手机。
