/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Instagram 解析 —— 走公开 embed 端点，无需登录。
 *
 *  ── 本文件曾经被下架过一次，原因是误判，留档避免重蹈 ────────────────
 *
 *   当初的结论是「Instagram 已不再向未登录请求下发数据」，依据样本
 *   instagram.com/reel/Db8Du5szFla/。**该结论是错的。**
 *
 *   复核实测（2026-09-12，同一时刻同一端点）：
 *     真实帖子 DbUr6CPoB13  → curl UA 3/3 成功，271,292 B，video_url 存在，
 *                              并成功下载 4,775,385 B 合法 MP4
 *     当初的样本 Db8Du5szFla → 221,450 B，contextJSON:null，
 *                              **零帖子元数据**（无 og:title / og:image）
 *
 *   后者与「帖子不存在 / 已删除」的特征完全一致 —— 用编造的短码能得到
 *   一模一样的响应。问题出在样本本身，不在 Instagram。
 *
 *  ── 关键：embed 页面有三种状态，体积接近，必须靠 contextJSON 区分 ─────
 *     ① ~623 KB，无 contextJSON     → 反爬伪装页（限流时出现，会自行恢复）
 *     ② ~221 KB，contextJSON:null   → 帖子不存在 / 已删除 / 不可公开访问
 *     ③ 265–350 KB，contextJSON 有值 → 真实数据，含 video_url
 *
 *   把 ② 误读成「平台关闭了未登录访问」正是当初误判的根源 —— ②③ 体积
 *   接近，光看大小分不开。下方代码的判别顺序正对应这三种状态。
 *
 *  ── UA 选择（重要，别改回浏览器 UA）────────────────────────────────
 *
 *   实测 curl 等**非浏览器 UA 抗限流能力明显更强**：在浏览器 UA 正被
 *   返回 ① 伪装页的同一时刻，curl UA 仍能稳定拿到 ③。
 *
 *   当初用浏览器 UA 还需额外携带 `Sec-Fetch-Mode: navigate`（浏览器 UA
 *   不带该头会被判定为伪装而返回 ①），改用非浏览器 UA 后这个头不再需要，
 *   少一个需要维护的隐式契约。
 *
 *   其余已实测的上游行为：
 *     · 不带 UA                    → 302 跳登录
 *     · /reels/<code>/embed/...    → 404（只能用 /reel/ 或 /p/，实测均 200）
 *     · 三条替代路径都要求登录：
 *         ?__a=1&__d=dis → 404 ｜ api/v1/media/<id>/info/ → 302
 *         ｜ graphql/query → 401 require_login
 *     · contextJSON 是双重转义，正则匹配不到，必须两段式 JSON.parse
 * ═══════════════════════════════════════════════════════════════════════
 */

import { readTextCapped } from '../lib/http';
import {
  ApiError,
  type MediaResult,
  type PlatformResolver,
  type ResolveContext,
  type VideoVariant,
} from './types';

/**
 * 用非浏览器 UA，不要改成浏览器 UA。
 *
 * Instagram 会校验「UA 与 Sec-Fetch-* 头是否自洽」：浏览器 UA 却不带
 * `Sec-Fetch-Mode: navigate` 会被判定为伪装请求，直接返回 623KB 的假页面。
 * 非浏览器 UA 不受这条规则约束，且实测**抗限流能力更强** ——
 * 浏览器 UA 被限流返回伪装页时，它仍能稳定拿到真实数据。
 */
const UA = 'curl/8.7.1';

/**
 * 伪装页的体积下限。
 *
 * ⚠️ 注意这个阈值**只能用来识别「限流」**，不能用来判断有没有内容：
 *   ① ~623 KB，无 contextJSON     → 伪装页（限流），命中此阈值
 *   ② ~221 KB，contextJSON:null   → 帖子不存在 / 已删除
 *   ③ 265–350 KB，contextJSON 有值 → 真实数据
 *
 * ② 和 ③ 都在阈值以下，必须靠 contextJSON 到底是 null 还是有值来区分。
 */
const DECOY_MIN_BYTES = 500_000;

const SHORTCODE_PATTERN = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,20})/;

interface ShortcodeMedia {
  __typename?: string;
  is_video?: boolean;
  display_url?: string;
  video_url?: string | null;
  video_duration?: number;
  video_view_count?: number;
  dimensions?: { width?: number; height?: number };
  product_type?: string;
  owner?: { username?: string; full_name?: string; profile_pic_url?: string };
  edge_media_to_caption?: { edges?: { node?: { text?: string } }[] };
  edge_liked_by?: { count?: number };
  /** 多图帖（carousel）的子项 */
  edge_sidecar_to_children?: {
    edges?: {
      node?: {
        display_url?: string;
        is_video?: boolean;
        video_url?: string;
        dimensions?: { width?: number; height?: number };
      };
    }[];
  };
}

function extractShortcode(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'instagram.com') return null;

  const m = url.pathname.match(SHORTCODE_PATTERN);
  return m?.[1] ?? null;
}

/**
 * 从 contextJSON 中做两段式解码。
 *
 * 输入是双重转义的 JSON 字符串，先精确切出字符串字面量（正确处理 \" 与 \\），
 * 再用 JSON.parse 解两次。
 */
function decodeContextJson(html: string): ShortcodeMedia | null {
  const key = '"contextJSON":"';
  const at = html.indexOf(key);
  if (at === -1) return null;

  let i = at + key.length;
  let literal = '';
  while (i < html.length) {
    const c = html[i];
    if (c === '\\') {
      // 转义符可能是最后一个字符（页面被截断）。不加这层判断的话
      // `html[i + 1]` 是 undefined，会被拼成字面量 "undefined" 混进结果，
      // 让后面的 JSON.parse 报出与真实原因无关的错。
      const next = html[i + 1];
      if (next === undefined) return null;
      literal += c + next;
      i += 2;
      continue;
    }
    if (c === '"') break;
    literal += c;
    i++;
  }
  if (!literal || literal === 'null') return null;

  try {
    const inner = JSON.parse(`"${literal}"`); // 第一次：还原成 JSON 文本
    const parsed = JSON.parse(inner) as {
      gql_data?: { shortcode_media?: ShortcodeMedia };
    };
    return parsed.gql_data?.shortcode_media ?? null;
  } catch {
    return null;
  }
}

function buildVariant(media: ShortcodeMedia, width?: number, height?: number): VideoVariant[] {
  if (!media.video_url) return [];

  const dims = width && height ? `${width}x${height}` : undefined;
  const duration = media.video_duration ? `${Math.round(media.video_duration)}秒` : undefined;
  const label = [dims, duration].filter(Boolean).join(' · ') || '原始画质';

  return [
    {
      url: media.video_url,
      quality: dims ?? '原始画质',
      bitrate: 0, // embed 端点不提供码率信息
      label,
      contentType: 'video/mp4',
      // Instagram 的 CDN 不需要附加头
      downloadHeaders: {},
      // 实测 cdninstagram.com 返回 access-control-allow-origin: *
      browserDownloadable: true,
    },
  ];
}

export const instagramResolver: PlatformResolver = {
  id: 'instagram',
  label: 'Instagram',

  match: extractShortcode,

  async resolve(ctx: ResolveContext): Promise<MediaResult> {
    // 一律用 /p/<code>/embed/captioned/ —— 它对帖子和 Reel 都有效。
    // 实测 /reels/<code>/embed/captioned/ 返回 404，故不做区分。
    const endpoint = `https://www.instagram.com/p/${ctx.id}/embed/captioned/`;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        redirect: 'manual', // 登录跳转要显式捕获，而不是被静默跟随
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch {
      throw new ApiError(502, 'upstream_unreachable', '无法连接 Instagram', '请稍后重试。');
    }

    // 302/303 说明被判定为未登录访问
    if (res.status >= 300 && res.status < 400) {
      throw new ApiError(
        502,
        'instagram_login_redirect',
        'Instagram 要求登录后访问',
        '稍后重试；若持续出现，说明 embed 端点策略有变。',
      );
    }
    if (res.status === 404) {
      throw new ApiError(404, 'post_unavailable', '该帖子不存在或已被删除', '请确认链接是否正确。');
    }
    if (!res.ok) {
      throw new ApiError(502, 'upstream_error', `Instagram 返回 ${res.status}`, '请稍后重试。');
    }

    const html = await readTextCapped(res, 5_000_000);

    // 体积异常大 → 拿到了伪装页，明确报错而不是静默失败
    if (html.length > DECOY_MIN_BYTES) {
      throw new ApiError(
        502,
        'instagram_decoy_page',
        'Instagram 返回了防爬伪装页',
        '这通常意味着请求头不符合其预期。请反馈该问题。',
      );
    }

    const media = decodeContextJson(html);

    if (!media) {
      throw new ApiError(
        404,
        'post_unavailable',
        '该帖子不存在、已删除或不可公开访问',
        '请确认链接指向一个公开的帖子或 Reel。',
      );
    }

    const width = media.dimensions?.width;
    const height = media.dimensions?.height;
    const videos = buildVariant(media, width, height);

    // 图片帖与多图帖：收集全部图片
    const images: string[] = [];
    const children = media.edge_sidecar_to_children?.edges ?? [];
    if (children.length > 0) {
      for (const edge of children) {
        const node = edge?.node;
        if (!node) continue;
        if (node.is_video && node.video_url) {
          const dims =
            node.dimensions?.width && node.dimensions?.height
              ? `${node.dimensions.width}x${node.dimensions.height}`
              : undefined;
          videos.push({
            url: node.video_url,
            quality: dims ?? '原始画质',
            bitrate: 0,
            label: [dims, `第 ${videos.length + 1} 个视频`].filter(Boolean).join(' · '),
            contentType: 'video/mp4',
            downloadHeaders: {},
            browserDownloadable: true,
          });
        } else if (node.display_url) {
          images.push(node.display_url);
        }
      }
    } else if (!media.is_video && media.display_url) {
      images.push(media.display_url);
    }

    // is_video 为真却没有 video_url：Instagram 对部分帖子会保留视频标记
    // 但不下发地址（实测存在，且非限流所致）。这种情况要明确报错，
    // 否则用户会以为是自己链接错了。
    if (media.is_video && videos.length === 0) {
      throw new ApiError(
        422,
        'video_url_withheld',
        'Instagram 未提供该视频的下载地址',
        '该帖子被标记为视频，但 Instagram 没有下发直链。' +
          '这在部分帖子上是正常的，可尝试在应用内观看。',
      );
    }

    const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text ?? '';
    const username = media.owner?.username ?? '';

    return {
      platform: 'instagram',
      id: ctx.id,
      sourceUrl: ctx.originalUrl,
      text: caption,
      thumbnail: media.display_url,
      durationMs: media.video_duration ? Math.round(media.video_duration * 1000) : undefined,
      author: {
        // embed 响应里没有 full_name，回退到用户名避免显示空白
        name: media.owner?.full_name ?? username,
        handle: username,
        avatar: media.owner?.profile_pic_url,
        url: username ? `https://www.instagram.com/${username}/` : undefined,
      },
      videos,
      images,
      ...(videos.length === 0 && images.length > 0
        ? { notice: '该帖子只包含图片，没有视频。' }
        : {}),
    };
  },
};
