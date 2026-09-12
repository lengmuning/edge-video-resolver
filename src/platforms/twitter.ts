import { syndicationToken } from '../lib/twitter-token';
import { readTextCapped } from '../lib/http';
import { formatBitrate } from '../lib/format';
import {
  ApiError,
  type MediaResult,
  type PlatformResolver,
  type ResolveContext,
  type VideoVariant,
} from './types';

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';

/**
 * 该端点强制要求 User-Agent —— 不带会直接返回 400。
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** syndication 返回的第三方 JSON，只声明我们用到的字段 */
interface SyndicationVariant {
  bitrate?: number;
  content_type?: string;
  url: string;
}

interface SyndicationVideoInfo {
  duration_millis?: number;
  variants?: SyndicationVariant[];
}

interface SyndicationMedia {
  type?: string;
  media_url_https?: string;
  video_info?: SyndicationVideoInfo;
}

interface SyndicationTweet {
  __typename?: string;
  id_str?: string;
  text?: string;
  created_at?: string;
  mediaDetails?: SyndicationMedia[];
  /** 部分推文在顶层也放了一份视频信息。字段名是 src 而非 url。 */
  video?: { variants?: { src?: string; type?: string; bitrate?: number }[] };
  /**
   * 被引用的推文。视频常常只存在于这一层 —— 外层推文可能只有一句配文。
   * 实测：推文 1776144738971693245 顶层无任何视频字段，
   * 视频在 quoted_tweet.mediaDetails[0].video_info。
   */
  quoted_tweet?: SyndicationTweet;
  card?: unknown;
  user?: {
    name?: string;
    screen_name?: string;
    profile_image_url_https?: string;
  };
}

/**
 * 一条正则即可覆盖全部已知形式（实测验证）：
 *   /<user>/status/<id>
 *   /i/web/status/<id>
 *   /i/status/<id>
 * 因为三者都含有子串 "/status/<id>"，无需为后两种单独写规则。
 *
 * 下限取 1 位而非 10 位：早期推文（如 x.com/jack/status/20）的 ID 很短。
 */
const ID_PATTERN = /\/status\/(\d{1,25})/;

const SUPPORTED_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'mobile.x.com',
  'mobile.twitter.com',
]);

function extractTweetId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (!SUPPORTED_HOSTS.has(host)) return null;

  return url.pathname.match(ID_PATTERN)?.[1] ?? null;
}

/** 从直链路径里抠出分辨率，如 /1080x1350/ → "1080x1350" */
function resolutionFromUrl(videoUrl: string): string | null {
  const m = videoUrl.match(/\/(\d{2,5})x(\d{2,5})\//);
  return m ? `${m[1]}x${m[2]}` : null;
}

/**
 * 把 X 的变体列表归一化：只保留 MP4、按码率降序、按 URL 去重。
 *
 * X 会同时提供 HLS（.m3u8）和多个 MP4 档位；HLS 不适合直接下载，故剔除。
 */
function toVariants(
  raw: { url: string; bitrate?: number; contentType?: string }[],
): VideoVariant[] {
  const seen = new Set<string>();
  const out: VideoVariant[] = [];

  for (const item of raw) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);

    const bitrate = item.bitrate ?? 0;
    const resolution = resolutionFromUrl(item.url);
    const parts = [resolution, formatBitrate(bitrate)].filter(Boolean);

    out.push({
      url: item.url,
      quality: resolution ?? (bitrate ? `${Math.round(bitrate / 1000)}kbps` : '默认'),
      bitrate,
      label: parts.join(' · ') || '默认画质',
      contentType: item.contentType ?? 'video/mp4',
      // X 的 CDN 不需要任何附加头
      downloadHeaders: {},
      // video.twimg.com 的 CORS 回显任意 Origin，浏览器可直连
      browserDownloadable: true,
    });
  }

  return out.sort((a, b) => b.bitrate - a.bitrate);
}

/** 从 mediaDetails 中抽出 MP4 变体。外层推文与引用推文共用同一套逻辑。 */
function variantsFromMediaDetails(mediaDetails: SyndicationMedia[]): VideoVariant[] {
  return toVariants(
    mediaDetails
      .filter((m) => m.video_info?.variants?.length)
      .flatMap((m) =>
        (m.video_info?.variants ?? [])
          .filter((v) => v.content_type === 'video/mp4')
          .map((v) => ({ url: v.url, bitrate: v.bitrate, contentType: v.content_type })),
      ),
  );
}

async function fetchTweet(tweetId: string): Promise<SyndicationTweet> {
  const endpoint = `${SYNDICATION_ENDPOINT}?id=${tweetId}&token=${syndicationToken(tweetId)}&lang=en`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
  } catch (cause) {
    // 原始异常挂到 cause 上：响应里不暴露，但日志里能看到真实原因
    // （DNS 失败 / 连接超时 / TLS 错误等），否则线上只能看到一个笼统的 502。
    throw new ApiError(502, 'upstream_unreachable', '无法连接 X 服务', '请稍后重试。', { cause });
  }

  // ⚠️ X 对不存在的推文有两种不同的错误形态，实测：
  //    · ID 格式非法/超范围 → 400 + JSON {"error":"Bad request."}
  //    · ID 合法但推文不存在 → 404 + HTML 错误页（class="dog"）
  //    两者都应报「推文不存在」，而不是笼统的 502。
  if (res.status === 400 || res.status === 404) {
    throw new ApiError(404, 'tweet_unavailable', '该推文不存在或已被删除', '请确认链接是否正确。');
  }
  if (!res.ok) {
    throw new ApiError(502, 'upstream_error', `X 服务返回 ${res.status}`, '请稍后重试。');
  }

  // ⚠️ 出错时返回的是 HTML 而非 JSON，直接 .json() 会抛异常。必须先查 content-type。
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new ApiError(502, 'upstream_malformed', 'X 返回了非预期的内容', '请稍后重试。');
  }

  const text = await readTextCapped(res, 2_000_000);
  try {
    return JSON.parse(text) as SyndicationTweet;
  } catch {
    throw new ApiError(502, 'upstream_malformed', 'X 返回了无法解析的数据', '请稍后重试。');
  }
}

export const twitterResolver: PlatformResolver = {
  id: 'twitter',
  label: 'X',

  match: extractTweetId,

  async resolve(ctx: ResolveContext): Promise<MediaResult> {
    const tweet = await fetchTweet(ctx.id);

    // ⚠️ 实测坑：不存在的推文 ID 返回的是**合法 JSON（空 mediaDetails）**，
    //    而不是 HTTP 错误。所以必须在这里显式判断，不能依赖状态码。
    const isRealTweet = Boolean(tweet.__typename || tweet.user || tweet.text);
    if (!isRealTweet) {
      throw new ApiError(404, 'tweet_unavailable', '该推文不存在或已被删除', '请确认链接是否正确。');
    }

    const ownMedia = tweet.mediaDetails ?? [];
    const quoted = tweet.quoted_tweet;
    const quotedMedia = quoted?.mediaDetails ?? [];

    // 主路径：mediaDetails[].video_info.variants[]
    let videos = variantsFromMediaDetails(ownMedia);

    // 兜底路径：顶层 video.variants[]（注意字段名是 src 不是 url）
    // 实测并非所有推文都有这个字段，所以只能当兜底。
    if (videos.length === 0) {
      videos = toVariants(
        (tweet.video?.variants ?? [])
          .filter((v) => v.src && (!v.type || v.type === 'video/mp4'))
          .map((v) => ({ url: v.src as string, bitrate: v.bitrate, contentType: 'video/mp4' })),
      );
    }

    // 引用推文兜底：视频常常只存在于这一层，外层推文可能只有一句配文。
    // 实测推文 1776144738971693245 顶层无任何视频字段，
    // 视频在 quoted_tweet.mediaDetails[0].video_info。
    // 不处理这一层就会误报「该推文中没有视频」，而这条推文在信息流里是显示视频的。
    let videoFromQuoted = false;
    if (videos.length === 0) {
      videos = variantsFromMediaDetails(quotedMedia);
      videoFromQuoted = videos.length > 0;
    }

    // 缩略图与时长必须与视频取自同一层，否则会出现
    // 「外层推文的配图 + 引用推文的时长」这种错配。
    const media = videoFromQuoted ? quotedMedia : ownMedia;

    const durationMs = media.find((m) => m.video_info?.duration_millis)?.video_info
      ?.duration_millis;

    // 图片则始终优先取外层推文自己的 —— 即使视频来自引用层，
    // 外层推文自带的配图也不该被丢掉。外层没有配图时才回落到引用层。
    const ownPhotos = ownMedia
      .filter((m) => m.type === 'photo' && m.media_url_https)
      .map((m) => m.media_url_https as string);
    const quotedPhotos = quotedMedia
      .filter((m) => m.type === 'photo' && m.media_url_https)
      .map((m) => m.media_url_https as string);
    const images = ownPhotos.length > 0 ? ownPhotos : quotedPhotos;

    // 文案与作者始终取自外层推文（用户链接的就是它），
    // 但视频来自引用源时必须说明，否则用户会以为下载到了错误的内容。
    const quotedNotice = videoFromQuoted
      ? `视频来自该推文引用的帖${
          quoted?.user?.screen_name ? `（@${quoted.user.screen_name}）` : ''
        }。`
      : undefined;

    if (videos.length === 0) {
      // 有卡片但无媒体：多为广告/推广类视频，其视频数据藏在
      // card.binding_values.unified_card.string_value 里，结构不稳定故未支持。
      if (images.length === 0) {
        const isCard = Boolean(tweet.card);
        throw new ApiError(
          422,
          isCard ? 'card_video_unsupported' : 'no_video',
          isCard
            ? '该推文的视频嵌在卡片中，暂不支持解析'
            : '该推文中没有视频',
          isCard
            ? '这类通常是广告或推广内容。可尝试直接打开推文查看。'
            : '请确认链接指向一条包含视频的推文。',
        );
      }

      // 有图片无视频：把图片也返回，让前端能展示
      return {
        platform: 'twitter',
        id: ctx.id,
        sourceUrl: ctx.originalUrl,
        text: tweet.text ?? '',
        createdAt: tweet.created_at,
        thumbnail: images[0],
        author: {
          name: tweet.user?.name ?? '',
          handle: tweet.user?.screen_name ?? '',
          avatar: tweet.user?.profile_image_url_https,
          url: tweet.user?.screen_name
            ? `https://x.com/${tweet.user.screen_name}`
            : undefined,
        },
        videos: [],
        images,
        notice: '该推文只包含图片，没有视频。',
      };
    }

    const thumbnail =
      media.find((m) => m.video_info && m.media_url_https)?.media_url_https ??
      media[0]?.media_url_https;

    return {
      platform: 'twitter',
      id: ctx.id,
      sourceUrl: ctx.originalUrl,
      text: tweet.text ?? '',
      createdAt: tweet.created_at,
      durationMs,
      thumbnail,
      author: {
        name: tweet.user?.name ?? '',
        handle: tweet.user?.screen_name ?? '',
        avatar: tweet.user?.profile_image_url_https,
        url: tweet.user?.screen_name ? `https://x.com/${tweet.user.screen_name}` : undefined,
      },
      videos,
      images,
      ...(quotedNotice ? { notice: quotedNotice } : {}),
    };
  },
};
