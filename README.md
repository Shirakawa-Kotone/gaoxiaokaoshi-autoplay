# 学时助手

自动完成高校考试网课程学时:逐门课程真实播放至学时达标。

## 用法

```bash
npm install
GX_USER=学号 GX_PASS=密码 GX_TABS=8 node autoplay.mjs
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `GX_USER` / `GX_PASS` | 登录账号和密码(必填) |
| `GX_TABS` | 并发标签页数(默认 4) |
| `GX_DEVICES` / `GX_DEVICE_ID` | 多设备协同(设备总数 / 当前设备序号) |
| `GX_STATUS_PORT` | 状态页 HTTP 端口(不设则不开) |
| `SMOKE` | 设为 1 时只跑一小段冒烟测试 |

## 多进程并发(备用)

`./run-parallel.sh` 用多个进程并发播放。

## 其他

- 账号密码通过环境变量传入,不落盘。
- Web 管理平台以模板文件提供:复制 `server.mjs.template` 等文件并去掉 `.template` 后缀即为可运行版本(学号等敏感值统一为占位符 `XXXXXXXX`,使用时改成自己的)。
