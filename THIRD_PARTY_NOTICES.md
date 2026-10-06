# Third-party notices · 第三方说明

The MIT license in `LICENSE` covers AuthTOTP's own source code only. The items below keep their own terms.
`LICENSE` 里的 MIT 许可只覆盖 AuthTOTP 自己的源代码，下面这些各自沿用原有条款。

## Font · 字体

`src/assets/fonts/atkinson-regular.woff`, `src/assets/fonts/atkinson-bold.woff` — **Atkinson Hyperlegible**, Version 1.002.

> © 2020 Braille Institute of America, Inc., a 501(c)(3) Charitable Organization.
> Braille Institute of America, Inc. provides Atkinson Hyperlegible for use, without derivatives or alteration, to the public free of charge for all non-commercial and commercial work. No attribution required.
> https://www.BrailleInstitute.org/

The files are shipped unmodified. Do not subset, convert or otherwise alter them.
字体文件按原样分发，请勿子集化、转换格式或做其它修改。

## XTian character images · XTian 形象图片

`src/brand/xtian/*.webp` — by XTian (https://blog.xtianowner.com/), licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**: https://creativecommons.org/licenses/by/4.0/

You may use, modify and share them, including commercially, as long as you credit "XTian". Using them does not imply that XTian endorses you or your deployment.
可以自由使用、修改和分享，包括商用，只需注明出自「XTian」；使用不代表 XTian 为你或你的部署背书。

They are AuthTOTP's default brand. In this app the footer line `by XTian` (linked to https://blog.xtianowner.com/) is that credit: keep it while the images are shown. To use your own character or none, see `AGENTS.md` §7; the choice goes in `src/brand/local/index.js`, which updates never overwrite.
它们是 AuthTOTP 的默认形象。页脚那行链接到博客的「by XTian」就是署名：只要页面上还显示这些形象，就请保留它。想换成自己的形象或不放形象，见 `AGENTS.md` 第 7 节；选择写在 `src/brand/local/index.js`，升级不会覆盖。
它们是 AuthTOTP 的默认品牌形象。想换成你自己的形象，替换图片并修改 `src/brand/index.js`（见 `AGENTS.md`「换成你自己的形象」）。

## Frontend packages · 前端依赖（`package.json` dependencies）

| Package | License |
|---|---|
| react, react-dom | MIT |
| motion | MIT |
| ogl | Unlicense |
| lucide-react | ISC |
| jsqr | Apache-2.0 |
| qrcode | MIT |
| clsx, tailwind-merge | MIT |
| gsap | GSAP Standard "no charge" license — https://gsap.com/standard-license |

## Backend packages · 后端依赖（`backend/requirements.txt`）

| Package | License |
|---|---|
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| pyotp | MIT |
| argon2-cffi | MIT |
| httpx | BSD-3-Clause |
| pytest | MIT |
