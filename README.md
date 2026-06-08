# 大家庭专用 MP3 → MP4 转换器

浏览器端批量将 MP3 音频文件转换为带封面的 MP4 视频文件。所有转换在客户端完成，不上传任何文件到服务器，保护隐私安全。

## 功能特性

- **批量上传**：支持拖拽或点击批量选择 MP3 文件
- **独立封面**：每个音频文件可单独设置封面图片，也可设置全局默认封面
- **自动封面**：未上传封面时，自动生成带歌名的深色渐变封面（1280×720）
- **浏览器端转换**：基于 FFmpeg.wasm，所有处理在本地完成，零隐私泄露
- **智能并发**：自动检测 CPU 核心数，动态调整并发路数（最多 8 路）
- **实时进度**：全局进度 + 单文件进度 + 阶段提示
- **批量下载**：支持单个下载或批量打包 ZIP 下载
- **零音质损失**：音频流直接复制（`-c:a copy`），不重编码
- **极致压缩**：1fps 静态封面 + x264 P 帧压缩，输出 ≈ 原始 MP3 大小

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19 + TypeScript 5
- **UI**: shadcn/ui + Tailwind CSS 4
- **转换引擎**: @ffmpeg/ffmpeg 0.12 (WebAssembly)
- **打包下载**: JSZip

## 快速开始

### 环境要求

- Node.js 18+
- pnpm 8+

### 安装

```bash
git clone https://github.com/YOUR_USERNAME/mp3-to-mp4-converter.git
cd mp3-to-mp4-converter
pnpm install
```

### 开发

```bash
pnpm dev
```

打开 [http://localhost:5000](http://localhost:5000) 查看应用。

### 构建

```bash
pnpm build
```

### 生产运行

```bash
pnpm start
```

## 转换原理

采用单步法（1fps 静态封面），兼顾速度与体积：

```
ffmpeg -loop 1 -framerate 1 -i cover -i audio \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black" \
  -c:v libx264 -preset ultrafast -crf 30 -tune stillimage -pix_fmt yuv420p -r 1 \
  -c:a copy -shortest -movflags +faststart output.mp4
```

| 参数 | 说明 |
|------|------|
| `-framerate 1 -r 1` | 输入/输出均为 1fps，4 分钟歌曲仅 240 帧 |
| `-c:a copy` | 直接复制 MP3 音频流，零音质损失 |
| `-tune stillimage` | 优化静态图片编码，P 帧近乎零体积 |
| `-preset ultrafast` | 最快编码速度 |
| `-crf 30` | 静态图片高质量区间，体积最小化 |

**体积对比**：4 分钟歌曲，原始 MP3 32MB → 输出 MP4 约 32.05MB（视频轨道仅 ~50KB）

## 项目结构

```
├── src/
│   ├── app/
│   │   ├── layout.tsx           # 根布局（暗色主题）
│   │   ├── page.tsx             # 首页
│   │   ├── globals.css          # 全局样式
│   │   └── robots.ts            # SEO
│   ├── components/
│   │   ├── mp3-to-mp4-converter.tsx  # 核心转换器组件
│   │   └── ui/                  # shadcn/ui 组件库
│   ├── hooks/                   # 自定义 Hooks
│   └── lib/utils.ts             # 工具函数
├── next.config.ts               # Next.js 配置
├── package.json
└── tsconfig.json
```

## 浏览器兼容性

| 浏览器 | 支持情况 |
|--------|---------|
| Chrome 57+ | 完全支持 |
| Edge 79+ | 完全支持 |
| Firefox 52+ | 完全支持 |
| Safari 15+ | 基本支持 |

> 需要支持 WebAssembly 和 SharedArrayBuffer（单线程模式不需要 COOP/COEP）

## 性能参考

| 场景 | 4 核电脑 | 8 核电脑 | 16 核电脑 |
|------|---------|---------|----------|
| 并发路数 | 2 路 | 4 路 | 8 路 |
| 单文件转换 | ~10 秒 | ~8 秒 | ~6 秒 |
| 10 个文件批量 | ~50 秒 | ~25 秒 | ~15 秒 |

## License

MIT
