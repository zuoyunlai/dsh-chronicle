# 品牌资产

| 文件 | 用途 |
|---|---|
| `../../icon.svg` | **插件图标**（矢量，随 npm 包发布，`exports["./icon"]`） |
| `banner-dark.png` | README / npm 页头图，深色主题（1280×480 @2x） |
| `banner-light.png` | README / npm 页头图，浅色主题（1280×480 @2x） |
| `icon-512.png` | 插件市场 / 商店列表用位图（512×512，透明背景） |
| `banner-dark.html` / `banner-light.html` | 头图的排版源文件 |

## 重新生成

头图是用浏览器渲染 HTML 再截图得到的 —— **不要用 AI 生图**，那会把「起居注」三个字写歪。

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,480 --screenshot=banner-dark.png \
  "file:///<绝对路径>/docs/brand/banner-dark.html"
```

## 图标的硬约束：16px 必须活着

侧栏标签可能只有 16px。64 单位 viewBox 渲染到 16px 时 **1 单位 = 0.25px**，
所以任何小于 **6 单位（1.5px）** 的元素都会糊掉。

当前实现满足：

| 元素 | 尺寸 | 16px 下 |
|---|---|---|
| 卷轴书脊 | 8 单位 | 2.00px ✅ |
| 逐日条目（只留一条） | 8 单位高 | 2.00px ✅ |
| 朱印 | 13 单位 | 3.25px ✅ |

改动图标时先算这笔账。曾经用过「3 条 2.6px 细线 + 五角星」，16px 下三层全糊、
只剩一个红点 —— 五角星在 16px 就是一个像素点，方块还能看出是红的。

底色 `#2E3138` 是刻意的：比侧栏深色底 `#1B1D21` 亮一档，否则图标边缘和背景分不开。

## 为什么不把 PNG 放进 npm 包

`package.json` 的 `files` 只显式列了 `docs/PLAN.md`，`docs/brand/` 不进包。
README 里用的是 GitHub raw 绝对地址，150 kB 的图不必让每个装插件的人下载一遍。
