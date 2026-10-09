# dsh-desktop-transparency

让 **DSH Desktop 的窗口变透明**（透出桌面 / 后面的窗口，带 acrylic 毛玻璃），并且**四角圆润**。

Windows 限定。以 **DSH bundle（插件）** 形式安装，同时带一个可独立使用的 CLI。

```powershell
# 装插件（推荐）：Web 侧栏「插件」页安装本包，或
dsh plugin --profile desktop add dsh-desktop-transparency

# 也可以只用 CLI（不装插件）
node lib/cli.mjs status
node lib/cli.mjs apply
```

安装后**重启 DSH Desktop** 生效。

---

## 它到底做了什么（以及为什么必须这么做）

DSH Desktop 是一个 Electron 应用。窗口的透明、毛玻璃只能在**创建窗口那一刻**设定：

```js
new BrowserWindow({ transparent: true, backgroundColor: '#00000000', backgroundMaterial: 'acrylic' })
```

这个调用在 **Electron 主进程**里，而 **DSH 插件运行在桌面宿主进程**（`dsh-desktop-host`，由 `DeepSeek Harness.exe` 以 node 模式启动）。插件拿不到 `BrowserWindow` 构造函数——窗口一旦创建，`setBackgroundColor` 也无法再开启真正的窗口透明。

> **宿主进程不是"普通 Node 进程"**，这一点踩过一次坑：它继承 Electron 的 asar 感知 `fs`，在那种 `fs` 下 `resources\app.asar` **不是一个文件**，而是归档的虚拟根目录（`isFile() = false`、`size = 0`、`readFileSync` 直接 `ENOENT`）。所以宿主里读归档必须走 `original-fs`（见 `lib/fs-io.mjs`）。症状很隐蔽：宿主的 `status()` 会说"没找到安装"，而同一份代码在 CLI 里完全正常（CLI 是普通 node，`node:fs` 本来就是对的）。

所以本插件不改运行时，而是**改随应用发布的 `resources/app.asar` 里的 `lib/main.js`**，把上述选项补进去，并在主进程里注入一小段 CSS + DWM 圆角调用。改动在**下次启动**才生效。

| 层面 | 改了什么 |
|---|---|
| 窗口 | `transparent: true`、`backgroundColor: "#00000000"`、保留 `backgroundMaterial: "acrylic"`、标题栏 overlay 强制透明 |
| 页面（主进程 `insertCSS`） | 画布透明、会话区/侧栏内容/**dock 标签宿主**透明，侧栏保留 55%（深色）/72%（浅色）可读底 |
| 页面（去除遮挡） | 去掉会话列表底部"渐隐到纯黑"的提示条（半透明侧栏下它就是一条黑条）、去掉 composer 底部渐隐、去掉 dock 压暗层 |
| 窗口圆角 | 用包内自带的 FFI（koffi）调 `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE = 2)`，让 DWM 自己把窗口做圆角（抗锯齿、材质保留） |

> 为什么圆角交给 DWM 而不是 CSS 裁切：窗口带 acrylic 材质时，**材质会铺满整个矩形**（含四角）。把页面裁成圆角，角上露出的不是桌面而是"玻璃"，看起来仍然是方的。

---

## 安全设计

改应用归档是有风险的操作，所以每一步都是"要么确定，要么拒绝"：

- **先分类**：读归档，判断它是官方版、已打补丁版，还是未知版本。已经是补丁版时**绝不覆盖**（除非显式 `--force`，且此时会从最新的官方备份重建）。
- **先校验再写**：在内存里构建补丁后的归档，然后验证——除 `lib/main.js` 外**每个条目逐字节一致**、`integrity.hash`/`blocks[]` 与内容吻合、补丁后的 `lib/main.js` **能通过 ESM 语法解析**。任一条不过就拒绝写入。
- **锚点失配就停**：补丁用字符串替换，每处锚点必须**恰好命中 1 次**。DSH 升级若改动代码结构，锚点会失配 —— 此时**明确报错并保持原样**，不会写出半截补丁。
- **备份**：打补丁前把官方归档复制成 `<stateDir>\backups\app.asar.<时间戳>`（并写同名 `.sha256`）。`app.asar` 约 121 MB，所以备份也约 121 MB —— 这是唯一能忠实还原的来源。
- **没有备份也能回头**：如果这台机器上的补丁早于本工具存在（没有官方备份），`apply --force` 会**逆向撤回补丁**把官方归档重建出来并存为备份（`lib/archive.mjs` 的 `reconstructOfficial`，已用真实 121 MB 归档验证）。**逆向结果只有确认过是"官方版 + 不含补丁标记"才会被采用**，否则拒绝写入。
- **原子替换 + 自动回滚**：先写同目录临时文件，再 `rename` 覆盖；写完重新读回文件比对 SHA256，不一致就自动还原备份。
- **可恢复**：`restore` 会把官方归档放回去；即使打补丁后应用起不来，CLI 也能用（它不需要应用运行）。

## ⚠️ 必须先关闭 DSH Desktop

Windows **不允许替换正在运行的应用所持有的 `app.asar`**（实测 `EPERM: rename`）。所以：

```powershell
# 1. 完全退出 DSH Desktop（含托盘）
# 2. 打补丁
node lib/cli.mjs apply
# 3. 重新启动 DSH Desktop —— 透明效果才会出现
```

- 应用在跑时，`apply` / `restore` 会**提前拒绝**并告诉你去关掉它（不会白读 121 MB、也不会留下半个备份）。
- `--allow-running` 可以强行尝试，但它必然失败 —— 存在的意义只是少数情况下"运行中的进程其实是无关副本"。
- 插件在应用内启动时**无法**替你完成重打补丁（它自己就住在那个进程里，文件被锁着）。这时它会把该做的事记进 `boot` 记录，并提示你关掉应用后跑 CLI。


---

## 支持状态

| DSH Desktop | 官方 `app.asar` | 状态 |
|---|---|---|
| `0.2.0-rc.2` | 121,348,951 B | ✅ 实测通过（补丁后 121,355,145 B，sha256 `D79B6BA0…`） |
| 其它版本 | — | 自动探测锚点；命中则打补丁并**给出"未在验证列表内"警告**，失配则拒绝 |

DSH 更新会**覆盖 `app.asar`**（补丁消失），而且此时**必须手动恢复**：

```powershell
node lib/cli.mjs status     # 看 state 是不是 official
# 关闭 DSH Desktop
node lib/cli.mjs apply      # 重新打补丁（会自动先备份官方归档）
# 重新启动 DSH Desktop
```

插件在应用内启动时也会检测到这件事，但它**写不进去**（文件被自己锁着，见上文），所以它会把 `needs-manual-apply` 记进 `boot` 记录并提示你按上面做。

---

## CLI

```
dsh-desktop-transparency status   [--json] [--dsh-root DIR]
dsh-desktop-transparency apply    [--json] [--dsh-root DIR] [--force] [--allow-running]
dsh-desktop-transparency verify   [--json] [--dsh-root DIR]
dsh-desktop-transparency restore  [--json] [--dsh-root DIR] [--backup FILE] [--allow-running]
dsh-desktop-transparency backups  [--json] [--state-dir DIR]
dsh-desktop-transparency boot     [--json] [--state-dir DIR]
```

- 安装目录**自动探测**：显式 `--dsh-root` → 环境变量 `DSH_DESKTOP_ROOT` → 注册表卸载项 → **正在运行的 DSH 进程的 exe 路径** → 常见安装位置。探测不到就报错并提示手动指定。
- 状态目录默认 `%LOCALAPPDATA%\dsh-desktop-transparency`（备份、补丁副本与 `last-boot.json` 都在这里，和 DSH 安装目录分离，升级 DSH 不会动它）。
- `DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS=node` 只在诊断时用：强制用 `node:fs` 读归档，也就是**故意复现宿主里"看不见归档"的状态**（官方归档仍会被原样保留）。宿主里正常运行时用的是 `original-fs`，boot 记录会写明用的是哪一个。
- `boot` 打印插件上次启动时的决定（`%LOCALAPPDATA%\dsh-desktop-transparency\last-boot.json`）。插件跑在桌面宿主里，它的日志没人看得到，所以这件事只能这样查：
  - `action: applied` → 它成功重打了补丁，等重启生效；
  - `action: needs-manual-apply` → 归档是官方版但它写不进去（应用正锁着文件），照 `reason` 里那条命令做；
  - `action: refused` → 锚点失配或别的原因，`reason` 会点名是哪一处替换。
  - 记录里的 `host.archiveFs` 说明归档是通过哪个 fs 读的（应为 `original-fs`），`fsProbe.asarIsFile` 应为 `true`；这两个值不对，就是宿主进程的文件系统视图出了问题，而不是探测逻辑。

### 不想用了

```powershell
# 1) 关闭 DSH Desktop
# 2) 还原官方归档
node lib/cli.mjs restore
# 3) 卸载 bundle（Web 插件页移除，或）
dsh plugin --profile desktop remove dsh-desktop-transparency
# 4) 重新启动 DSH Desktop
```

> 只卸载插件**不会**自动还原归档 —— 插件已经不在运行，无法替你做这件事。先 `restore` 再卸载。
> 而且 `restore` 也需要应用处于关闭状态（见上文文件锁）。

---

## 已知限制

- **仅 Windows**。macOS 保持官方 vibrancy 方案，Linux 未测试。
- **必须重启 DSH Desktop** 才生效（`insertCSS` 只在窗口创建/加载时注入）。
- **acrylic 需要 Windows 11 22H2+**，且系统"透明效果"要开着
  （`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\EnableTransparency = 1`）。
- **圆角半径不可自定义**：DWM 的 ROUND 是 Windows 原生半径（约 8px）。想要更大半径只能回到 `SetWindowRgn`（有锯齿、要常驻进程）。
- **修改了随应用发布的文件**：DSH 官方更新会覆盖它（重新 apply 即可）；请自行确认你的使用场景允许这样做。
- **可读性**：正文区完全透明。壁纸很花时，侧栏比例可以在 `lib/patch-template.js` 里调（`72%` / `55%`）。

---

## 开发

```powershell
npm test                      # 全部单元测试（含合成 asar 往返校验）
npm run test:integration      # 额外用真实官方归档跑一遍（需要 DSH_OFFICIAL_ASAR）
```

`npm test` 里有一项会**真的启动一个宿主进程**（`DeepSeek Harness.exe` +
`ELECTRON_RUN_AS_NODE=1`，和 DSH 启动宿主的方式一致）来验证归档在那个进程里是不是可见的；
没装 DSH 的机器（CI）会跳过它。CI 跑的是 ubuntu + Node 22 上的同一套门禁，已在 Linux 上
实测通过（74 项测试：Windows 全过，Linux 70 过 / 4 跳过）。

仓库结构：

```
lib/fs-io.mjs           归档用哪个 fs：Electron 里用 original-fs，其它地方用 node:fs
lib/archive.mjs         asar 读写 + 补丁 + 往返/integrity/ESM 语法校验（纯函数，可单测）
lib/patch-rules.mjs     补丁规格：锚点、CSS 期望、模板一致性校验、顺序自洽诊断
lib/patch-template.js   注入到 main.js 的那段代码（从已验证归档原样导出，禁止手改）
lib/detect.mjs          安装目录探测
lib/operations.mjs      status / apply / verify / restore / backups / boot 生命周期
lib/index.js            DSH bundle 的 Host 半（启动检测 + boot 记录）
lib/cli.mjs             命令行
tools/                  维护脚本：导出模板、探测归档头部、校验选择器、外部重启 DSH
test/                   单元测试 + 合成 asar 生成器 + 真实页面类名快照 + 宿主进程探针
```

> `tools/restart-dsh-outside-session.ps1` 不是临时脚本：重启 DSH 会连带结束发起者（桌面宿主就是会话宿主），
> 所以重启必须由**计划任务在独立进程树里**做。删掉它会让重启静默失败（计划任务找不到脚本不报错）。

`lib/patch-template.js` 是**从已经跑起来的补丁归档里导出**的（`tools/extract-patch-template.mjs`），不是手抄的：它会被拼进 Electron 要执行的代码里，错一个字节应用就起不来。改 CSS 时请同步 `lib/patch-rules.mjs` 里的 `expectedCssRules` —— 两者不一致时 `assertTemplateMatchesRules()` 会直接失败。

---

## 许可

MIT。见 [LICENSE](LICENSE)。

本项目修改的是 DeepSeek Harness 桌面应用随包发布的文件；DeepSeek Harness 自身按其官方条款授权，本项目与 DeepSeek 无隶属关系。
