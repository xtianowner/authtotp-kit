<!-- purpose: AuthTOTP 默认品牌包（XTian 形象）的说明：有哪些图、用在哪、怎么换成你自己的形象 -->

- 创建时间: 2026-10-05 18:30:00
- 更新时间: 2026-10-06 17:28:56
- 时区: Asia/Shanghai

# 默认品牌包 · XTian

AuthTOTP 展示层用到的角色形象图（暗色棚拍、透明底、青绿轮廓光），作者 XTian，按 CC BY 4.0 授权：可以自由使用、修改、商用，只需注明出自 XTian。在本应用里，页脚那行链接到博客的「by XTian」就是署名，只要页面上还显示这些形象，就请保留它。详见仓库根目录的 `THIRD_PARTY_NOTICES.md`。

| 文件 | 用在哪 | 画面 |
|---|---|---|
| `fig-authtotp-dark-b.webp` | 公开工具首页第二屏 | 举着盾牌和钥匙 |
| `fig-totp-door-dark.webp` | 保险库登录页（光门开启） | 双手推开圆形保险库门 |
| `fig-totp-sleep-dark.webp` | 404 | 靠着小保险柜打瞌睡 |

页面只通过 `src/brand/index.js` 引用这些图。想换形象、不放形象或改署名，都不要改这个文件，而是写 `src/brand/local/index.js`：这个目录被 git 忽略，升级拉代码时不会被覆盖。里面定义了哪一项就替换哪一项：

1. 自己的形象：准备三张同样用途的图，要求是透明底 webp、高约 900px、单张最好不超过 150KB，暗底上要有轮廓光（黑色衣服或头发放在暗底上会「消失」）。把图放进 `src/brand/local/`，然后在 `index.js` 里导出 `homeFigure`、`loginFigure`、`notFoundFigure`，每项写成 `{ src, width, height }`，404 那张另加 `bubble: null`（鼻涕泡动画只适用于原图）。
2. 不放形象：把这三项导出为 `null`，页面照常显示，只是没有手办。
3. 署名：导出 `attribution`，形如 `{ href, label: { zh, en } }`；导出 `null` 则不显示页脚。只要页面上还显示 XTian 的形象，就保留默认署名。

完整步骤与示例见仓库根目录 `AGENTS.md` 第 7 节。
