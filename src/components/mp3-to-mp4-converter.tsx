'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

// ─── Custom Progress Bar ───────────────────────────────
function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-white/10 ${className ?? ''}`}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#d4880a] to-[#e8a023] transition-all duration-300 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function ThinProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#d4880a] to-[#e8a023] transition-all duration-300 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

// ─── Types ─────────────────────────────────────────────
interface AudioFileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: 'pending' | 'converting' | 'done' | 'error';
  progress: number;
  stage?: string;
  outputUrl?: string;
  outputSize?: number;
  error?: string;
  coverFile?: File | null;
  coverPreview?: string;
}

// ─── Helpers ───────────────────────────────────────────
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function generateDefaultCover(title: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(0.5, '#16213e');
  gradient.addColorStop(1, '#0f3460');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1280, 720);

  // Decorative circles
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#e8a023';
  ctx.beginPath();
  ctx.arc(640, 310, 200, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(640, 310, 140, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Music note
  ctx.fillStyle = '#e8a023';
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u266A', 640, 310);

  // Title
  ctx.fillStyle = '#e8e8ed';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const displayName = title.replace(/\.mp3$/i, '');
  const maxWidth = 1000;
  let fontSize = 28;
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  while (ctx.measureText(displayName).width > maxWidth && fontSize > 14) {
    fontSize -= 2;
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  }
  ctx.fillText(displayName, 640, 430);

  // Subtitle
  ctx.fillStyle = '#6b6b80';
  ctx.font = '18px system-ui, sans-serif';
  ctx.fillText('MP3 \u2192 MP4', 640, 470);
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#4a4a5a';
  ctx.fillText('\u5927\u5bb6\u5ead\u4e13\u7528', 640, 495);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      'image/jpeg',
      0.92
    );
  });
}

// ─── Main Component ────────────────────────────────────
export function Mp3ToMp4Converter() {
  const [audioFiles, setAudioFiles] = useState<AudioFileItem[]>([]);
  const [coverImage, setCoverImage] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string>('');
  const [isConverting, setIsConverting] = useState(false);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [ffmpegLoadError, setFfmpegLoadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [globalProgress, setGlobalProgress] = useState(0);

  // Dynamic concurrency: based on CPU cores & memory
  const [poolSize, setPoolSize] = useState(2);
  const [cpuCores, setCpuCores] = useState<number | null>(null);
  const ffmpegPoolRef = useRef<FFmpeg[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Detect hardware on mount
  useEffect(() => {
    const cores = navigator.hardwareConcurrency || 4;
    setCpuCores(cores);
    // Heuristic: 1 core per FFmpeg instance, leave 2 for browser/OS
    // Min 1, Max 8 (each WASM instance ~25MB, 8 = ~200MB, manageable)
    const optimal = Math.max(1, Math.min(8, Math.floor((cores - 2) / 1)));
    setPoolSize(optimal);
  }, []);

  // ─── FFmpeg Pool Loading ────────────────────────────
  const loadFFmpeg = useCallback(async () => {
    if (ffmpegPoolRef.current.length > 0) return;
    setFfmpegLoading(true);
    try {
      // CDN sources with fallbacks (China-friendly + global)
      const cdnSources = [
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
        'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
      ];
      
      let coreURL = '';
      let wasmURL = '';
      let lastError: unknown = null;
      
      // Try each CDN until one works
      for (const baseURL of cdnSources) {
        try {
          [coreURL, wasmURL] = await Promise.all([
            toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          ]);
          break; // Success, stop trying
        } catch (e) {
          lastError = e;
          console.warn(`CDN ${baseURL} failed, trying next...`, e);
        }
      }
      
      // Final fallback: direct URL (no toBlobURL, avoids fetch issues)
      if (!coreURL || !wasmURL) {
        const fallbackBase = cdnSources[cdnSources.length - 1];
        console.warn('toBlobURL failed for all CDNs, falling back to direct URLs');
        coreURL = `${fallbackBase}/ffmpeg-core.js`;
        wasmURL = `${fallbackBase}/ffmpeg-core.wasm`;
      }
      
      // Load poolSize instances
      const size = ffmpegPoolRef.current.length || poolSize;
      const instances = await Promise.all(
        Array.from({ length: size }, async () => {
          const ffmpeg = new FFmpeg();
          await ffmpeg.load({ coreURL, wasmURL });
          return ffmpeg;
        })
      );
      ffmpegPoolRef.current = instances;
      setFfmpegLoaded(true);
    } catch (err) {
      console.error('FFmpeg load failed:', err);
      setFfmpegLoadError(err instanceof Error ? err.message : '引擎加载失败');
    } finally {
      setFfmpegLoading(false);
    }
  }, [poolSize]);

  // Auto-load FFmpeg on mount
  useEffect(() => {
    loadFFmpeg();
  }, [loadFFmpeg]);

  // ─── File Handling ─────────────────────────────────
  const addFiles = useCallback((files: FileList | File[]) => {
    const newFiles: AudioFileItem[] = Array.from(files)
      .filter((f) => f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3'))
      .map((f) => ({
        id: generateId(),
        file: f,
        name: f.name,
        size: f.size,
        status: 'pending' as const,
        progress: 0,
      }));

    if (newFiles.length > 0) {
      setAudioFiles((prev) => [...prev, ...newFiles]);
    }
  }, []);

  const removeFile = useCallback(
    (id: string) => {
      setAudioFiles((prev) => {
        const item = prev.find((f) => f.id === id);
        if (item?.outputUrl) URL.revokeObjectURL(item.outputUrl);
        if (item?.coverPreview) URL.revokeObjectURL(item.coverPreview);
        return prev.filter((f) => f.id !== id);
      });
    },
    []
  );

  const clearAll = useCallback(() => {
    audioFiles.forEach((f) => {
      if (f.outputUrl) URL.revokeObjectURL(f.outputUrl);
      if (f.coverPreview) URL.revokeObjectURL(f.coverPreview);
    });
    setAudioFiles([]);
  }, [audioFiles]);

  // ─── Per-file Cover Image ──────────────────────────
  const setFileCover = useCallback((id: string, file: File) => {
    if (!file.type.startsWith('image/')) return;
    const preview = URL.createObjectURL(file);
    setAudioFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        if (f.coverPreview) URL.revokeObjectURL(f.coverPreview);
        return { ...f, coverFile: file, coverPreview: preview };
      })
    );
  }, []);

  const removeFileCover = useCallback((id: string) => {
    setAudioFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        if (f.coverPreview) URL.revokeObjectURL(f.coverPreview);
        return { ...f, coverFile: null, coverPreview: undefined };
      })
    );
  }, []);

  // ─── Cover Image ──────────────────────────────────
  const handleCoverChange = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    setCoverImage(file);
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    const url = URL.createObjectURL(file);
    setCoverPreview(url);
  }, [coverPreview]);

  const removeCover = useCallback(() => {
    setCoverImage(null);
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverPreview('');
  }, [coverPreview]);

  // ─── Drag & Drop ─────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  // ─── Conversion (Parallel Pool) ──────────────────
  const convertAll = useCallback(async () => {
    if (ffmpegPoolRef.current.length === 0) {
      await loadFFmpeg();
      if (ffmpegPoolRef.current.length === 0) return;
    }

    const pending = audioFiles.filter((f) => f.status === 'pending' || f.status === 'error');
    if (pending.length === 0) return;

    setIsConverting(true);
    setGlobalProgress(0);

    const pool = ffmpegPoolRef.current;
    const total = pending.length;
    let completedCount = 0;

    // Convert a single file using a specific FFmpeg instance
    const convertOne = async (item: AudioFileItem, ffmpeg: FFmpeg, poolIdx: number) => {
      // Use pool index to avoid filename collisions in virtual FS
      const inputAudioName = `input_p${poolIdx}.mp3`;
      const coverName = `cover_p${poolIdx}.jpg`;
      const outputName = `output_p${poolIdx}.mp4`;

      setAudioFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: 'converting' as const, progress: 0, stage: '正在准备...', error: undefined } : f))
      );

      let audioDurationSec = 0;
      const logHandler = ({ message }: { message: string }) => {
        const timeMatch = message.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (timeMatch && audioDurationSec > 0) {
          const hours = parseFloat(timeMatch[1]);
          const minutes = parseFloat(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          const progress = Math.max(0, Math.min(99, Math.round((currentTime / audioDurationSec) * 100)));
          setAudioFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, progress } : f))
          );
        }
      };
      ffmpeg.on('log', logHandler);

      try {
        // Write audio
        setAudioFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, stage: '正在读取音频...' } : f))
        );
        await ffmpeg.writeFile(inputAudioName, await fetchFile(item.file));

        // Get audio duration
        setAudioFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, stage: '正在分析音频...' } : f))
        );
        const arrayBuffer = await item.file.arrayBuffer();
        const audioContext = new AudioContext();
        try {
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          audioDurationSec = audioBuffer.duration;
        } catch {
          audioDurationSec = item.size / 16000;
        } finally {
          await audioContext.close();
        }

        // Write cover
        setAudioFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, stage: '正在加载封面...' } : f))
        );
        let coverBlob: Blob;
        let coverExt: string;
        const effectiveCover = item.coverFile ?? coverImage;
        if (effectiveCover) {
          coverBlob = effectiveCover;
          coverExt = effectiveCover.name.split('.').pop()?.toLowerCase() || 'jpg';
        } else {
          coverBlob = await generateDefaultCover(item.name);
          coverExt = 'jpg';
        }
        const actualCoverName = coverExt !== 'jpg' ? `cover_p${poolIdx}.${coverExt}` : coverName;
        await ffmpeg.writeFile(actualCoverName, await fetchFile(coverBlob));

        // Encode
        setAudioFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, progress: 15, stage: '正在编码...' } : f))
        );

        await ffmpeg.exec([
          '-loop', '1',
          '-framerate', '1',
          '-i', actualCoverName,
          '-i', inputAudioName,
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1:color=black',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '30',
          '-tune', 'stillimage',
          '-pix_fmt', 'yuv420p',
          '-r', '1',
          '-c:a', 'copy',
          '-shortest',
          '-movflags', '+faststart',
          outputName,
        ]);

        // Read output
        const data = await ffmpeg.readFile(outputName);
        const outputBytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data);
        const blob = new Blob([outputBytes], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);

        // Clean up virtual FS
        await ffmpeg.deleteFile(inputAudioName);
        await ffmpeg.deleteFile(actualCoverName);
        await ffmpeg.deleteFile(outputName);

        setAudioFiles((prev) =>
          prev.map((f) =>
            f.id === item.id
              ? { ...f, status: 'done' as const, progress: 100, stage: '转换完成', outputUrl: url, outputSize: outputBytes.length }
              : f
          )
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : '转换失败';
        setAudioFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, status: 'error' as const, progress: 0, error: errorMsg } : f))
        );
      } finally {
        ffmpeg.off('log', logHandler);
        completedCount++;
        setGlobalProgress(Math.round((completedCount / total) * 100));
      }
    };

    // Dispatch files across pool using a simple queue
    let nextIdx = 0;
    const getNext = (): AudioFileItem | undefined => {
      if (nextIdx < pending.length) return pending[nextIdx++];
      return undefined;
    };

    // Each pool worker pulls from the queue
    const workers = pool.map(async (ffmpeg, poolIdx) => {
      let item: AudioFileItem | undefined;
      while ((item = getNext()) !== undefined) {
        await convertOne(item, ffmpeg, poolIdx);
      }
    });

    await Promise.all(workers);
    setIsConverting(false);
  }, [audioFiles, coverImage, loadFFmpeg]);

  // ─── Download ─────────────────────────────────────
  const downloadFile = useCallback((item: AudioFileItem) => {
    if (!item.outputUrl) return;
    const a = document.createElement('a');
    a.href = item.outputUrl;
    a.download = item.name.replace(/\.mp3$/i, '.mp4');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  const downloadAll = useCallback(async () => {
    const doneFiles = audioFiles.filter((f) => f.status === 'done' && f.outputUrl);
    if (doneFiles.length === 0) return;

    if (doneFiles.length === 1) {
      downloadFile(doneFiles[0]);
      return;
    }

    // Create ZIP for multiple files
    const zip = new JSZip();
    for (const item of doneFiles) {
      if (!item.outputUrl) continue;
      try {
        const response = await fetch(item.outputUrl);
        const blob = await response.blob();
        zip.file(item.name.replace(/\.mp3$/i, '.mp4'), blob);
      } catch {
        // Skip failed downloads
      }
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mp4-videos.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [audioFiles, downloadFile]);

  // ─── Computed Values ──────────────────────────────
  const pendingCount = audioFiles.filter((f) => f.status === 'pending' || f.status === 'error').length;
  const doneCount = audioFiles.filter((f) => f.status === 'done').length;
  const canConvert = !isConverting && pendingCount > 0 && ffmpegLoaded;
  const canDownload = doneCount > 0;

  // ─── Render ───────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#e8e8ed]">
      {/* Header */}
      <header className="border-b border-white/5 px-6 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#e8a023] to-[#d4880a] text-lg font-bold text-black">
              ♪
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">大家庭专用MP3 → MP4 转换器</h1>
              <p className="text-sm text-[#6b6b80]">将音频文件转换为带封面的视频文件，全部在浏览器端完成</p>
            </div>
          </div>
          {/* Engine status */}
          <div className="mt-3 flex items-center gap-2">
            {ffmpegLoading && (
              <Badge variant="outline" className="border-[#e8a023]/30 text-[#e8a023]">
                <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-[#e8a023]" />
                引擎加载中...
              </Badge>
            )}
            {ffmpegLoaded && (
              <Badge variant="outline" className="border-[#22c55e]/30 text-[#22c55e]">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#22c55e]" />
                引擎就绪
              </Badge>
            )}
            {ffmpegLoaded && (
              <Badge variant="outline" className="border-[#6b6b80]/30 text-[#6b6b80]">
                {cpuCores ?? '?'} 核心 · {poolSize} 路并发 · ~{poolSize * 25}MB
              </Badge>
            )}
            {ffmpegLoadError && (
              <>
                <Badge variant="outline" className="border-[#ef4444]/30 text-[#ef4444]">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#ef4444]" />
                  引擎加载失败
                </Badge>
                <button
                  type="button"
                  onClick={() => { setFfmpegLoadError(null); loadFFmpeg(); }}
                  className="text-xs text-[#e8a023] underline underline-offset-2 hover:text-[#e8a023]/80"
                >
                  重试
                </button>
              </>
            )}
            {!ffmpegLoading && !ffmpegLoaded && !ffmpegLoadError && (
              <Badge variant="outline" className="border-[#6b6b80]/30 text-[#6b6b80]">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#6b6b80]" />
                引擎未加载
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col px-6 py-8" style={{ minHeight: 'calc(100vh - 80px)' }}>
        {/* Upload Section */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* MP3 Upload Zone */}
          <Card
            className={`group relative cursor-pointer border-2 border-dashed transition-all duration-300 ${
              isDragging
                ? 'border-[#e8a023] bg-[#e8a023]/5'
                : 'border-white/10 bg-[#14141f] hover:border-white/20 hover:bg-[#14141f]/80'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex flex-col items-center justify-center gap-4 p-8">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8a023]/10 text-[#e8a023] transition-transform duration-300 group-hover:scale-110">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div className="text-center">
                <p className="font-medium">拖拽 MP3 文件到此处</p>
                <p className="mt-1 text-sm text-[#6b6b80]">或点击选择文件，支持批量上传</p>
              </div>
              {audioFiles.length > 0 && (
                <Badge variant="secondary" className="bg-[#e8a023]/10 text-[#e8a023]">
                  已选择 {audioFiles.length} 个文件
                </Badge>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,audio/mpeg"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </Card>

          {/* Default Cover Image */}
          <Card
            className="group relative cursor-pointer border-2 border-dashed border-white/10 bg-[#14141f] transition-all duration-300 hover:border-white/20 hover:bg-[#14141f]/80"
            onClick={() => coverInputRef.current?.click()}
          >
            <div className="flex flex-col items-center justify-center gap-4 p-8">
              {coverPreview ? (
                <div className="relative aspect-video w-full overflow-hidden rounded-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={coverPreview} alt="封面预览" className="h-full w-full object-cover" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeCover();
                    }}
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-red-500/80"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8a023]/10 text-[#e8a023] transition-transform duration-300 group-hover:scale-110">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="font-medium">{'设置默认封面'}</p>
                    <p className="mt-1 text-sm text-[#6b6b80]">{'未单独设置封面的文件将使用此封面'}</p>
                  </div>
                </>
              )}
            </div>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) handleCoverChange(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </Card>
        </div>

        {/* Global Progress */}
        {isConverting && (
          <div className="mt-6 rounded-xl border border-[#e8a023]/20 bg-[#14141f] p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-[#e8a023]">
                批量转换中 ({globalProgress}%)
              </span>
              <span className="text-[#6b6b80]">{globalProgress}%</span>
            </div>
            <ProgressBar value={globalProgress} />
          </div>
        )}

        {/* File List */}
        {audioFiles.length > 0 && (
          <div className="mt-8 flex min-h-0 flex-1 flex-col">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">文件列表</h2>
              <span className="text-sm text-[#6b6b80]">
                {doneCount} 已完成 / {audioFiles.length} 总计
              </span>
            </div>

            <ScrollArea className="flex-1 overflow-hidden">
              <div className="space-y-3">
                {audioFiles.map((item) => (
                  <Card
                    key={item.id}
                    className="border-white/5 bg-[#14141f] px-5 py-4 transition-all duration-300"
                  >
                    <div className="flex items-center gap-4">
                      {/* Cover Thumbnail */}
                      <div
                        className="relative flex h-12 w-12 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-white/5 transition-all hover:ring-2 hover:ring-[#e8a023]/50"
                        onClick={(e) => {
                          e.stopPropagation();
                          const input = document.getElementById(`cover-input-${item.id}`);
                          input?.click();
                        }}
                        title="点击更换封面"
                      >
                        {item.coverPreview ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={item.coverPreview} alt="" className="h-full w-full object-cover" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity hover:bg-black/40 hover:opacity-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </div>
                          </>
                        ) : coverPreview ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={coverPreview} alt="" className="h-full w-full object-cover opacity-60" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity hover:bg-black/40 hover:opacity-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </div>
                          </>
                        ) : (
                          <div className="flex flex-col items-center gap-0.5 text-[#6b6b80]">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                              <circle cx="8.5" cy="8.5" r="1.5" />
                              <polyline points="21 15 16 10 5 21" />
                            </svg>
                            <span className="text-[8px]">封面</span>
                          </div>
                        )}
                      </div>
                      <input
                        id={`cover-input-${item.id}`}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) setFileCover(item.id, e.target.files[0]);
                          e.target.value = '';
                        }}
                      />

                      {/* File Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{item.name}</p>
                          <span className="flex-shrink-0 text-xs text-[#6b6b80]">{formatSize(item.size)}</span>
                          {/* Cover source indicator */}
                          {item.status === 'pending' && (
                            <Badge variant="outline" className="border-[#6b6b80]/30 text-[10px] text-[#6b6b80]">
                              {item.coverFile ? '独立封面' : coverImage ? '默认封面' : '自动封面'}
                            </Badge>
                          )}
                          {item.status === 'converting' && (
                            <Badge variant="outline" className="border-[#e8a023]/30 text-[10px] text-[#e8a023]">
                              {item.stage ?? '处理中'} {item.progress}%
                            </Badge>
                          )}
                          {item.status === 'done' && (
                            <Badge variant="outline" className="border-[#22c55e]/30 text-[10px] text-[#22c55e]">
                              已完成
                            </Badge>
                          )}
                          {item.status === 'error' && (
                            <Badge variant="outline" className="border-[#ef4444]/30 text-[10px] text-[#ef4444]">
                              失败
                            </Badge>
                          )}
                        </div>
                        {item.status === 'converting' && (
                          <div className="mt-2">
                            <ThinProgressBar value={item.progress} />
                          </div>
                        )}
                        {item.status === 'done' && item.outputSize && (
                          <p className="mt-1 text-xs text-[#6b6b80]">
                            输出: {formatSize(item.outputSize)}
                          </p>
                        )}
                        {item.status === 'error' && item.error && (
                          <p className="mt-1 text-xs text-[#ef4444]">{item.error}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {item.status === 'done' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-[#e8a023]/30 text-[#e8a023] hover:bg-[#e8a023]/10 hover:text-[#e8a023]"
                            onClick={() => downloadFile(item)}
                          >
                            下载
                          </Button>
                        )}
                        {!isConverting && item.coverFile && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#6b6b80] hover:text-[#ef4444]"
                            onClick={() => removeFileCover(item.id)}
                          >
                            移除封面
                          </Button>
                        )}
                        {!isConverting && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#6b6b80] hover:text-[#ef4444]"
                            onClick={() => removeFile(item.id)}
                          >
                            删除
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Empty State */}
        {audioFiles.length === 0 && (
          <div className="mt-16 flex flex-col items-center gap-4 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[#14141f] text-[#6b6b80]">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <p className="text-[#6b6b80]">上传 MP3 文件开始转换</p>
          </div>
        )}

        {/* Action Bar */}
        {audioFiles.length > 0 && (
          <>
            <Separator className="my-6 bg-white/5" />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                disabled={!canConvert}
                onClick={convertAll}
                className="bg-gradient-to-r from-[#d4880a] to-[#e8a023] text-black font-semibold hover:from-[#c47a08] hover:to-[#d99520] disabled:opacity-50"
              >
                {isConverting ? (
                  <>
                    <span className="mr-2 inline-block animate-pulse">♪</span>
                    转换中...
                  </>
                ) : (
                  <>开始转换 ({pendingCount})</>
                )}
              </Button>

              {canDownload && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={downloadAll}
                  className="border-white/10 bg-transparent text-[#e8e8ed] hover:bg-white/5"
                >
                  下载全部 ({doneCount})
                </Button>
              )}

              <div className="flex-1" />

              {!isConverting && (
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={clearAll}
                  className="text-[#6b6b80] hover:text-[#ef4444]"
                >
                  清空列表
                </Button>
              )}
            </div>
          </>
        )}

        {/* Tips */}
        <div className="mt-12 rounded-xl border border-white/5 bg-[#14141f]/50 p-5">
          <h3 className="mb-3 text-sm font-medium text-[#6b6b80]">使用说明</h3>
          <ul className="space-y-1.5 text-xs text-[#6b6b80]/80">
            <li>• 所有转换在浏览器本地完成，文件不会上传到任何服务器</li>
            <li>• 首次使用需加载转换引擎（约 25MB），后续使用无需重复加载</li>
            <li>{'• 点击文件列表中的封面缩略图可为单个文件设置独立封面'}</li>
            <li>{'• 右侧上传的默认封面会应用到未单独设置封面的文件'}</li>
            <li>{'• 未设置任何封面时将自动生成带歌名的默认封面'}</li>
            <li>{'• 输出视频分辨率为 1280×720，音频零损失直接复制'}</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
