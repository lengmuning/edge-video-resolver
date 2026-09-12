import { readTextCapped } from '../lib/http';
import { formatBitrate } from '../lib/format';
import {
  ApiError,
  type MediaResult,
  type PlatformResolver,
  type ResolveContext,
  type VideoVariant,
} from './types';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * TikTok 的 CDN 会校验来源，直链必须带 Referer 才能下载。
 *
 * 这个头会随结果一起返回给调用方（见 downloadHeaders），
 * 快捷指令据此自动配置，无需在用户侧硬编码。
 */
const DOWNLOAD_HEADERS: Record<string, string> = {
  Referer: 'https://www.tiktok.com/',
};

/**
 * 纯短链域名：路径第一段就是短码，不含视频 ID，必须跟随跳转。
 *
 * ⚠️ `m.tiktok.com` 不在此列 —— 它是带完整路径的移动端域名
 * （形如 /@user/video/<id>），归到短链里会把 `@user` 误当成短码。
 */
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

/** 承载完整路径的域名，含移动端。 */
const FULL_PATH_HOSTS = new Set(['tiktok.com', 'm.tiktok.com']);

interface RehydrationVideo {
  duration?: number;
  cover?: string;
  originCover?: string;
  dynamicCover?: string;
  playAddr?: string;
  downloadAddr?: string;
  bitrateInfo?: {
    GearName?: string;
    Bitrate?: number;
    PlayAddr?: { UrlList?: string[] };
  }[];
}

interface RehydrationItem {
  id?: string;
  desc?: string;
  createTime?: number;
  author?: { uniqueId?: string; nickname?: string; avatarThumb?: string };
  video?: RehydrationVideo;
}

interface OEmbed {
  title?: string;
  author_name?: string;
  author_unique_id?: string;
  thumbnail_url?: string;
}

/**
 * 从链接中提取视频 ID。
 *
 * 短链不含 ID，这里加 `short:` 前缀标记，由 resolve() 跟随跳转后再解析。
 * 覆盖四种短链形态：vm.tiktok.com/<code>、vt.tiktok.com/<code>、
 * www.tiktok.com/t/<code>，以及移动端的 m.tiktok.com。
 */
function extractVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname;

  if (SHORT_LINK_HOSTS.has(host)) {
    const code = path.split('/').filter(Boolean)[0];
    return code ? `short:${code}` : null;
  }

  if (!FULL_PATH_HOSTS.has(host)) return null;

  // /@user/video/<id>
  const videoMatch = path.match(/\/video\/(\d{6,25})/);
  if (videoMatch?.[1]) return videoMatch[1];

  // /embed/<id> 或 /embed/v2/<id>
  const embedMatch = path.match(/\/embed\/(?:v2\/)?(\d{6,25})/);
  if (embedMatch?.[1]) return embedMatch[1];

  // /t/<code> —— 网页版「复制链接」产出的主力短链格式，使用频率很高。
  // 不识别它会让最常见的分享链接直接报「暂不支持这个平台」。
  const shareMatch = path.match(/^\/t\/([A-Za-z0-9]+)/);
  if (shareMatch?.[1]) return `short:${shareMatch[1]}`;

  return null;
}

/** GearName 如 "adapt_lowest_1080_1"，提炼出面向用户的清晰度标签 */
function gearToQuality(gear: string | undefined, bitrate: number): string {
  if (gear) {
    const p = gear.match(/(\d{3,4})/);
    if (p?.[1]) return `${p[1]}p`;
  }
  return bitrate ? `${Math.round(bitrate / 1000)}kbps` : '默认';
}

/**
 * 归一化 TikTok 的视频档位。
 *
 * 优先级：bitrateInfo（含多档码率与 GearName）> playAddr > downloadAddr。
 * 三条路径可能指向同一地址，故按 URL 去重。
 */
function collectVariants(video: RehydrationVideo): VideoVariant[] {
  const seen = new Set<string>();
  const out: VideoVariant[] = [];

  const push = (url: string | undefined, bitrate: number, quality: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);

    const parts = [quality, formatBitrate(bitrate)].filter(Boolean);
    out.push({
      url,
      quality,
      bitrate,
      label: parts.join(' · ') || '默认画质',
      contentType: 'video/mp4',
      downloadHeaders: { ...DOWNLOAD_HEADERS },
      // TikTok 的 CDN 把 CORS 锁定为 tiktok.com，浏览器无法跨域取；
      // 且 Referer 属于浏览器禁止脚本设置的请求头。仅快捷指令可用。
      browserDownloadable: false,
    });
  };

  for (const info of video.bitrateInfo ?? []) {
    const url = info.PlayAddr?.UrlList?.[0];
    const bitrate = info.Bitrate ?? 0;
    push(url, bitrate, gearToQuality(info.GearName, bitrate));
  }

  push(video.playAddr, 0, '默认画质');
  push(video.downloadAddr, 0, '原始文件');

  return out.sort((a, b) => b.bitrate - a.bitrate);
}

interface ItemFetchResult {
  item: RehydrationItem | null;
  /** TikTok 自带的业务状态码。0 或 undefined 表示成功。 */
  statusCode?: number;
  /** 机器可读的状态名，如 "status_self_see"。 */
  statusMsg?: string;
}

/**
 * 把 TikTok 的状态码转成用户能看懂的话。
 *
 * 只对能确认的码做友好映射，其余一律把平台原始状态透出来 ——
 * 把「私密」「已删除」「地区限制」「反爬」全塌缩成同一句
 * 「反爬限制」会让排查变得非常困难。
 */
function describeStatus(
  code: number | undefined,
  msg: string | undefined,
): { code: string; message: string; hint: string } {
  // 实测：私密视频返回 10204 / status_self_see
  if (code === 10204 || msg === 'status_self_see') {
    return {
      // 错误码要能区分具体原因 —— 客户端 switch 时不该去 parse 中文文案
      code: 'tiktok_private',
      message: '该视频已设为私密',
      hint: '只有作者本人可见，无法下载。',
    };
  }

  // 注意 0 要排除：statusCode: 0 表示成功，若此时 itemStruct 仍缺失，
  // 把 0 透出来会显示成「平台返回状态：0」，反而误导。
  const raw = [code, msg]
    .filter((v) => (typeof v === 'number' ? v !== 0 : Boolean(v)))
    .join(' / ');

  return {
    code: 'tiktok_unavailable',
    message: 'TikTok 未返回视频数据',
    hint:
      (raw ? `平台返回状态：${raw}。` : '') +
      '常见原因：视频已删除、设为私密、地区限制，或触发了反爬。' +
      '若怀疑是反爬，请改用快捷指令重试。',
  };
}

/** 抓取视频页并取出 __UNIVERSAL_DATA_FOR_REHYDRATION__ 中的 itemStruct */
async function fetchItem(canonicalUrl: string): Promise<ItemFetchResult> {
  let res: Response;
  try {
    res = await fetch(canonicalUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (cause) {
    throw new ApiError(502, 'upstream_unreachable', '无法连接 TikTok', '请稍后重试。', {
      cause,
    });
  }

  if (!res.ok) {
    throw new ApiError(502, 'upstream_error', `TikTok 返回 ${res.status}`, '请稍后重试。');
  }

  const html = await readTextCapped(res, 6_000_000);

  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) return { item: null };

  try {
    const data = JSON.parse(match[1]) as {
      __DEFAULT_SCOPE__?: Record<string, unknown>;
    };
    const scope = data.__DEFAULT_SCOPE__ ?? {};
    const detail = scope['webapp.video-detail'] as
      | {
          statusCode?: number;
          statusMsg?: string;
          itemInfo?: { itemStruct?: RehydrationItem };
        }
      | undefined;

    return {
      item: detail?.itemInfo?.itemStruct ?? null,
      statusCode: detail?.statusCode,
      statusMsg: detail?.statusMsg,
    };
  } catch {
    // 页面结构变化时静默降级到 oEmbed，由调用方决定后续行为。
    return { item: null };
  }
}

/** 结构解析失败时的兜底：至少能拿到标题、作者与封面 */
async function fetchOEmbed(canonicalUrl: string): Promise<OEmbed | null> {
  try {
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return null;
    return (await res.json()) as OEmbed;
  } catch {
    return null;
  }
}

export const tiktokResolver: PlatformResolver = {
  id: 'tiktok',
  label: 'TikTok',

  match: extractVideoId,

  async resolve(ctx: ResolveContext): Promise<MediaResult> {
    let videoId = ctx.id;
    let canonicalUrl = `https://www.tiktok.com/@i/video/${videoId}`;

    // 短链（vm. / vt. / t/）：先跟随跳转拿到规范链接，再取视频 ID。
    //
    // 直接用用户给的原始 URL，而不是自己拼某个短链域名 ——
    // 三种短链形式的短码并不保证可以互换，用原始链接最稳妥。
    if (videoId.startsWith('short:')) {
      try {
        const res = await fetch(ctx.url.href, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
        });
        const resolvedId = new URL(res.url).pathname.match(/\/video\/(\d{6,25})/)?.[1];
        if (!resolvedId) {
          throw new ApiError(
            404,
            'short_link_unresolved',
            '无法从短链解析出视频',
            '短链可能已失效，请改用完整链接。',
          );
        }
        videoId = resolvedId;
        // 跳转后的 URL 里带真实用户名，直接复用，不要拼 `@i` 占位符。
        // （实测 oEmbed 能容忍 `@i`，但那是在依赖未文档化的容错行为；
        //   占位符一旦不被接受，降级提示里的作者名对短链就会永久失效。）
        canonicalUrl = `https://www.tiktok.com${new URL(res.url).pathname}`;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(502, 'short_link_failed', '短链解析失败', '请改用完整链接重试。', {
          cause: err,
        });
      }
    } else {
      // 保留用户名让链接更自然，同时保证路径正确
      canonicalUrl = `https://www.tiktok.com${ctx.url.pathname}`;
    }

    const { item, statusCode, statusMsg } = await fetchItem(canonicalUrl);

    if (!item) {
      const { code, message, hint } = describeStatus(statusCode, statusMsg);

      // 附上 oEmbed 能拿到的信息，让用户能确认链接指向的内容是否正确 ——
      // 否则「解析失败」时用户无从判断是链接错了还是服务坏了。
      const oembed = await fetchOEmbed(canonicalUrl);
      const found = oembed
        ? `已识别到${oembed.title ? `《${oembed.title}》` : '该视频'}` +
          `${oembed.author_name ? ` — ${oembed.author_name}` : ''}。`
        : '';

      throw new ApiError(422, code, message, found + hint);
    }

    const video = item.video ?? {};
    const variants = collectVariants(video);

    if (variants.length === 0) {
      throw new ApiError(
        422,
        'no_video',
        '该 TikTok 链接中没有可下载的视频',
        '请确认链接指向一个视频。',
      );
    }

    return {
      platform: 'tiktok',
      id: videoId,
      sourceUrl: ctx.originalUrl,
      text: item.desc ?? '',
      createdAt: item.createTime
        ? new Date(item.createTime * 1000).toISOString()
        : undefined,
      durationMs: video.duration ? video.duration * 1000 : undefined,
      thumbnail: video.cover ?? video.originCover ?? video.dynamicCover,
      author: {
        name: item.author?.nickname ?? '',
        handle: item.author?.uniqueId ?? '',
        avatar: item.author?.avatarThumb,
        url: item.author?.uniqueId
          ? `https://www.tiktok.com/@${item.author.uniqueId}`
          : undefined,
      },
      videos: variants,
      images: [],
      // 这是个平台硬限制，明确告知用户，避免以为服务坏了。
      notice:
        'TikTok 的视频 CDN 限制浏览器跨域下载，网页端只能解析信息。' +
        '请使用 iPhone 快捷指令下载 —— 它会自动携带所需的请求头。',
    };
  },
};
