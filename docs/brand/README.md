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

`icon.svg` 相对原图只加了一层**内缩圆角底**，图形比例全部按用户的参考图实测：

| 参数 | 参考图实测 | icon.svg |
|---|---|---|
| 内边距（左右上下） | 15.4–15.6% | 15.3% |
| 单条宽 | 20.1% | 20.1% |
| 条间间隙 | 4.0% | 4.4% |
| 条形高 | 68.8% | 69.3% |
| 底板圆角 | 12.9% | 12.9%（rx=7.2/56） |

测量方法：对参考图逐行扫描底板与竹色的颜色跃变，取 bbox 与 run-length，不靠目测。

**曾经做错过一次**：第一版把内边距做成 5.4%、圆角做成 25%，竖条直接撞进圆角，
视觉上「标志撑出底板」。教训是这类几何问题必须量，不能估。

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
