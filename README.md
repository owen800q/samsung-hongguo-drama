# 红果短剧 · 三星电视版

[hongguo-drama](https://github.com/jackotom/hongguo-drama) 桌面版的 Samsung Tizen 电视移植版。浏览、搜索、在线播放短剧，全程只用遥控器操作。

本项目是社区维护的开源移植版，**不是红果、西饭或河马的官方客户端，也未获平台背书**。不提供付费分集解锁，不保证所有剧集都能播放。

## 功能

- **发现**：红果（真人剧、漫剧、AI 剧、四类热播榜）、西饭、河马三个来源，题材筛选，滚动到底部自动加载下一页。
- **搜索**：默认同时搜索三个来源，结果标明来源；某个来源失败时仍显示其他来源的结果。直接输入红果剧集 ID 也能打开。
- **详情与选集**：简介、标签、续看按钮，每 50 集一组的选集网格。来源平台标记为需解锁的分集会显示锁标。
- **播放器**：续播进度、自动播放下一集、缓存下一集（当前集一开始播放就预先缓冲下一集，可在设置里关闭）、倍速、选集面板、累积快进（连按几次后统一跳转一次）、断线重连（网络中断或片源地址失效时自动重新获取一次片源并从原进度续播；「重试」按钮同样会重新获取片源；官网片源打不开时，5 分钟内该集优先改用 App 片源，官网作为最后备选）。
- **观看记录 / 我的追剧**：进度自动保存；追剧列表在来源更新集数时提示「更新 N 集」。
- **红果备用片源**：官网通常只公开前几集，其余分集走 App 接口。这类片源是 CENC 加密 MP4，应用在电视端用纯 JS 解密后播放，首次打开需要先缓冲整集，约 10 MB。主地址无效或下载失败（HTTP 错误、错误页面、下载不完整）时，自动改用同一集的备用地址，再不行降一档清晰度，最多尝试 3 个地址；下载超时不换地址。电视断网时提示检查网络，而不是「未提供播放地址」。官网地址只取页面中与当前分集对应的视频，不会误用页面里推荐剧集的地址。

桌面版的下载、合并导出、代理和更新检查不适用于电视，未移植。

## 遥控器

| 按键 | 浏览界面 | 播放界面 |
|-|-|-|
| 方向键 | 移动焦点 | 控制栏隐藏时：左右快退/快进，上键唤出控制栏，下键打开选集；控制栏显示时：移动焦点，焦点在进度条上时左右键拖动进度 |
| 确认 | 选择 | 播放 / 暂停 |
| 返回 | 后退；在首页时询问是否退出 | 先收起控制栏，再按一次退出播放 |
| 播放/暂停、播放、暂停、停止 | — | 对应操作 |
| 快进 / 快退 | — | 3 倍步长跳转 |
| 频道 ▲ / ▼、上一曲 / 下一曲 | — | 上一集 / 下一集 |
| 绿色键 / 黄色键 | — | 选集面板 / 倍速面板 |
| 红色键 | 删除选中的观看记录或取消追剧 | — |

快进步长（5/10/15/30 秒）、默认倍速、自动下一集、缓存下一集和默认来源可以在「设置」里调整。

## 开发

需要 Node.js 18 或更高版本。

```bash
npm install
npm run dev        # http://localhost:5180，桌面浏览器窗口调到 1920×1080
npm test           # 加解密单元测试 + 三个来源的在线接口测试
npm run build && npx vite preview --port 4173 &
CHROMIUM_PATH=<chromium 路径> npm run e2e   # 模拟 Tizen Web 模拟器的遥控器端到端测试
```

在桌面浏览器里，方向键、回车、Esc（返回）、空格（播放/暂停）、PageUp/PageDown（上一集/下一集）对应遥控器按键。浏览器会拦截跨域请求，所以开发服务器提供 `/__proxy` 转发，并带上 Tizen 电视的 User-Agent。电视端不需要转发：config.xml 里白名单内的域名不受跨域限制。

## 打包与安装

```bash
npm run package                          # 构建并生成 build/HongguoTV-unsigned.wgt
npm run package -- --profile <证书配置名>  # 已安装 Tizen CLI 时直接签名，生成 build/HongguoTV.wgt
```

电视只安装签过名的 widget：

1. 安装 [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)，并通过 Package Manager 安装 **Samsung TV Extensions**。
2. 在 Certificate Manager 里用三星证书创建证书配置，把电视的 DUID 加进分发者证书。
3. 电视进入开发者模式：「应用」页面依次按 `1 2 3 4 5`，打开 Developer mode，填写电脑的 IP，然后重启电视。
4. 把 `tizen` 加进 PATH，运行 `npm run package -- --profile <配置名>`。
5. 运行 `sdb connect <电视 IP>`，再运行 `tizen install -n build/HongguoTV.wgt -t <设备名>`。

也可以把 `build/widget/` 导入 Tizen Studio 的 Web 项目，在 IDE 里签名并运行。

### 自动更新

装好的电视会自己更新，不用再用 sdb 重装。Cloudflare Worker `hongguo.codeboxhk.com`（`wrangler.jsonc`，推送到 `main` 时由 Workers Builds 部署）在 `/tv-app/` 发布最新构建（`scripts/ota-update.mjs`）。应用启动后在后台下载新版，下次打开时生效。原理与回退机制见 [ota/README.md](ota/README.md)。

每次推送到 `main` 也会发布一个附带 widget 的 GitHub Release（`.github/workflows/release.yml`）。只有改了 `tizen/config.xml`、图标或加载器时才需要重装。仓库设置了 ota/README.md 列出的证书 Secrets 时，Release 里的 widget 会签好名。

**模拟器**：安装 `TV-SAMSUNG-Public-Emulator` 后运行 `scripts/emulator.sh <证书配置名>`，脚本会创建虚拟机、启动、构建签名并安装运行。三星电视模拟器和真机一样，只接受三星证书：在 Certificate Manager 里创建 Samsung → TV 证书配置，分发者证书选 Public，并把模拟器的 DUID 加进去（模拟器连接时用 `sdb -s <设备> shell 0 getduid` 查看）。普通 Tizen 证书会被拒绝，报错 `Invalid certificate chain`。macOS 上模拟器依赖 Intel HAXM（不支持 Hypervisor.framework），安装 HAXM 后需要重启一次。

`npm run e2e` 用 Chromium（1920×1080，模拟 `tizen.tvinputdevice`，关闭跨域限制，相当于 config.xml 白名单）加载构建产物，用遥控器键码走一遍：首页 → 详情 → 播放官网分集（快进、暂停/播放、绿色键选集、频道键换集）→ 返回 → 加密分集（让第一个 App 地址返回 404，确认改用下一个地址并完成解密）→ 返回首页 → 退出。开源 Chromium 不带 H.264/HEVC 解码器，所以官网分集用 ffmpeg 生成的 VP9 测试片代替，加密分集只检查到解密后交给播放器为止。

## 兼容性

- 目标是 2018 年及以后的三星电视（Tizen 4.0+，Chromium 56+）。打包产物是单个经典 IIFE 脚本，不用 ES module。Tizen 4.0 缺少的方法由 `src/lib/polyfills.js` 补齐，CSS 也避开了 flex `gap`、`aspect-ratio`、`:focus-within` 等 Chromium 56 不支持的写法。
- 加密分集里有 HEVC 片源，三星电视都能硬件解码。
- 页面设置了 `no-referrer`：视频 CDN 会拒绝带外部 Referer 的请求。
- Tizen 的播放器不能播放 `blob:` 地址的普通 MP4（只支持 MSE），所以解密后的分集会写入应用私有临时目录（`wgt-private-tmp`），用 `file://` 地址播放；为此 config.xml 申请了 filesystem 读写权限。桌面浏览器仍用 blob。

### 在 Tizen TV 模拟器中验证

在 Tizen Studio 6.1 的三星电视模拟器（Tizen 10.0，Chromium 130）上，用三星证书签名安装，通过 `ecp-cli keycode` 从模拟器的虚拟输入设备发送真实硬件按键，再用 Web Inspector（`sdb shell 0 debug`）读取应用状态：

- `tizen.tvinputdevice` 注册生效：确认、返回（10009）、暂停（19）、播放（415）、播放/暂停（10252）、快进/快退、红绿黄键、频道 ▲/▼（427/428）都送达应用。
- 浏览 → 详情 → 选集 → 播放全部用遥控器完成。网页片源 H.264 可以播放；App 片源加密 HEVC（1080×1920）下载并解密后，从本地临时文件播放。
- 暂停和播放切换正常，左右键快进快退，绿色键选集，黄色键倍速，频道键切换剧集并续播。从播放器返回详情时，焦点回到原来的分集。
- 逐级返回到首页弹出退出确认，选「退出」后应用进程退出。

模拟器测试发现并修复了三个只在真机环境出现的问题：包 ID 必须是 10 个字符；Tizen 播放器不能播放 blob 地址；焦点会落到被遮住的页面上。

### 在三星 TV Web Simulator 中验证

Tizen Studio 自带的三星电视模拟器（`tools/sec-tv-simulator`，提供 `tizen`/`webapis` 接口和电视 User-Agent）读取 `config.xml`，把应用安装成 `HgDrama001.HongguoTV`。应用从 `file://` 运行，走电视端的直连请求，不经过开发代理。通过 DevTools 协议测试：

- 真实方向键和确认键：浏览 → 海报 → 详情 → 播放。
- 网页片源 H.264（720×1280）可以播放。App 片源加密 HEVC（1080×1920）约 3 秒完成下载和解密，然后开始播放。
- 遥控器专用按键：播放/暂停（10252）、播放（415）、返回（10009）、绿色键选集、黄色键倍速、频道 ▲/▼ 切换剧集并续播。左右键累积快进。
- 逐级返回到首页，再按返回弹出退出确认。整个过程没有 JS 异常。

### 在 Chromium 56 中验证

用 Chromium 56 快照（与 Tizen 4.0 同一内核）通过 DevTools 协议发送真实按键，测试 `vite preview` 提供的生产包：

- 应用启动后没有 JS 错误。方向键、确认、返回、绿色键选集、退出确认都正常。
- 加密分集流程完整跑通：App 接口签名、带进度下载、纯 JS 解密（约 1 秒）、生成 blob 地址。
- Chromium 开源快照不含 H.264/AAC/HEVC 解码器，所以视频最终无法解码；这一步需要在电视或带专有编解码器的 Chrome 上验证。

复现方法：运行 `npm run build && npx vite preview --port 4180`，用 Chromium 56 快照（`chromium-browser-snapshots/Mac/433020`）加 `--remote-debugging-port` 打开 `http://localhost:4180/`。

## 已知限制

- 红果搜索只有一页结果（约 10 条），因为官网只在服务端渲染第一页。
- 备用片源依赖 App 接口签名，接口改版后可能失效，失效时会提示官网可播放的范围。
- 已在 Tizen TV 模拟器、三星 TV Web Simulator 和 Chromium 56 中验证，还没有在电视真机上运行过。首次打开加密分集需要先下载整集，速度取决于网络和电视 CPU（模拟器上约 20 秒）。

## 许可

GPL-3.0，与桌面版一致。`src/sources/app-source.js` 的签名算法来源见文件头。
