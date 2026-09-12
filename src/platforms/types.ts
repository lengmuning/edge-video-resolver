/**
 * 各平台共用的数据结构与接口。
 *
 * 新增平台只需实现 PlatformResolver 并注册到 ./index.ts，
 * 路由层与前端都不需要改动。
 */

export type PlatformId = 'twitter' | 'tiktok' | 'instagram';

/** 一个可下载的视频档位（同一视频可能有多个码率） */
export interface VideoVariant {
  url: string;

  /** 原始清晰度标识，如 "1080x1350" 或 "adapt_lowest_1080_1" */
  quality: string;

  /** 平均码率（bps）。未知为 0。用于排序与展示。 */
  bitrate: number;

  /** 面向用户的展示标签，如 "1080p · 10.4 Mbps" */
  label: string;

  contentType: string;

  /**
   * 下载该地址时必须额外携带的请求头。
   *
   * X 为空对象 —— 直链可零 header 下载。
   * TikTok 需要 Referer —— 其 CDN 会校验来源。
   *
   * 快捷指令据此自适应配置请求头，无需在用户侧硬编码。
   */
  downloadHeaders: Record<string, string>;

  /**
   * 浏览器能否直接下载该地址。
   *
   * 取决于 CDN 的 CORS 策略：X 的 video.twimg.com 回显任意 Origin，
   * 浏览器可直连；TikTok 的 CDN 锁定为 tiktok.com，浏览器无法跨域取。
   */
  browserDownloadable: boolean;
}

export interface MediaAuthor {
  name: string;
  handle: string;
  avatar?: string;
  url?: string;
}

export interface MediaResult {
  platform: PlatformId;
  /** 平台内的资源 ID */
  id: string;
  /** 用户提交的原始链接 */
  sourceUrl: string;

  text: string;
  createdAt?: string;
  durationMs?: number;
  thumbnail?: string;

  author: MediaAuthor;

  /** 按码率降序排列，[0] 为最高画质 */
  videos: VideoVariant[];

  /** 帖子中的图片（若有） */
  images: string[];

  /**
   * 平台级提示，前端会原样展示。
   * 例如 TikTok 的「网页端无法直接下载，请使用快捷指令」。
   */
  notice?: string;
}

export interface ResolveContext {
  /** 从 URL 中解析出的平台内 ID */
  id: string;
  /** 规范化后的链接 */
  url: URL;
  /** 用户原始输入的链接（可能含追踪参数） */
  originalUrl: string;
}

export interface PlatformResolver {
  id: PlatformId;
  /** 平台展示名 */
  label: string;

  /**
   * 判断链接是否属于本平台，并提取资源 ID。
   * 不匹配返回 null。
   */
  match(url: URL): string | null;

  /** 解析出媒体信息。失败时抛出 ApiError。 */
  resolve(ctx: ResolveContext): Promise<MediaResult>;
}

/**
 * 业务错误。会被路由层统一转成结构化 JSON 响应，
 * 而不是抛 500 让用户看到堆栈。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 给用户的可操作建议 */
    readonly hint?: string,
    /** 原始异常。用于日志排查，不会返回给用户。 */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}
