# Android APK

原生 WebView 壳加载线上 PWA，支持系统返回键、Cookie 会话、应用内 H5 路由和外部浏览器跳转。

## 构建

```bash
APP_URL=https://trip.example.com/ ./android/build-apk.sh
```

不传 `APP_URL` 时优先读取项目 `.env` 的 `DOMAIN`；没有域名时使用脚本内的当前演示地址。

产物：

```text
dist/goapp-v2.1.0.apk
dist/goapp-v2.1.0.apk.sha256
```

首次构建会在 `.android-keys/` 生成独立签名密钥。该目录已被 Git 忽略；不要删除，否则后续 APK 无法覆盖安装旧版本，只能先卸载。

## 要求

- Android 6.0（API 23）及以上
- 安装和运行时需要网络
- 后端必须在线；APK 不内置数据库或 API
