# 品牌资产

| 文件 | 用途 |
|---|---|
| `../../icon.svg` | **插件图标**（矢量，随 npm 包发布，`exports["./icon"]`） |
| `source-起居注.svg` | **图形原始文件**（用户提供，CorelDRAW 导出，未改动） |
| `banner-dark.png` | README / npm 页头图，深色主题（1280×480 @2x） |
| `banner-light.png` | README / npm 页头图，浅色主题（1280×480 @2x） |
| `icon-512.png` | 插件市场用位图（512×512，透明背景） |
| `banner-*.html` | 头图排版源文件 |

## 图形

三片竹简：竹色 `#B39B77` + 米色书列 `#F1E7D4`。原始文件见 `source-起居注.svg`。

`icon.svg` 相对原图只做两处**非破坏性**适配，图形语言未改：

1. **加内缩圆角底**（`x=4 y=4 w=56 rx=14`，`#2E3138`）
   已装插件（dsh-theme-palette / dsh-rightbar-quicknav）都是这个规格。
   裸图在浅色底上（`#B39B77` on `#F5F6F8`）对比度偏低，且图标边缘没有边界。

2. **竖片间隙 6.24% → 9.6%**
   原间隙 30.09/482 单位，在 16px 下只有 **1.0px**，三片会并成一块。
   现在 1.5px，分得开。代价是每片略瘦，三片的节奏不变。

其余按原图比例：书列宽 = 竖片宽的 37.6%；两条小横列在 73.8% 与 83.4% 处。

## 硬约束：16px 必须活着

64 单位 viewBox 渲染到 16px 时 **1 单位 = 0.25px**，小于 **6 单位（1.5px）** 的元素会糊。

| 元素 | 尺寸 | 16px 下 |
|---|---|---|
| 竖片宽 | 12.67 单位 | 3.17px ✅ |
| 竖片间隙 | 6.00 单位 | 1.50px ✅（原图是 1.00px ⚠） |
| 书列宽 | 4.76 单位 | 1.19px ⚠ 作为纹理可接受 |
| 小横列高 | 2.90 单位 | 0.73px ❌ 16px 下消失，24px+ 才出现 |

改图标前先算这笔账。

## 重新生成

头图是浏览器渲染 HTML 再截图，**不要用 AI 生图**（会把「起居注」三个字写歪）。

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,480 --screenshot=banner-dark.png \
  "file:///<绝对路径>/docs/brand/banner-dark.html"
```

## 为什么不把 PNG 放进 npm 包

`package.json` 的 `files` 只显式列了 `docs/PLAN.md`，`docs/brand/` 不进包。
README 用 GitHub raw 绝对地址，150 kB 的图不必让每个装插件的人下载一遍。
