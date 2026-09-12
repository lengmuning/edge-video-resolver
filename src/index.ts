import { errorResponse, json, preflight } from './lib/http';
import { resolveUrl } from './platforms';
import { ApiError } from './platforms/types';

export interface Env {
  /** 静态资源绑定。因 run_worker_first 仅作用于 /api/*，通常用不到。 */
  ASSETS: Fetcher;
}

/**
 * 解析视频链接，返回媒体信息。
 *
 * 本服务**只做解析**，不中转视频字节 —— 视频由调用方直连平台 CDN。
 * 这既是性能设计，也是合规设计：Cloudflare 全程只承载几 KB 的 JSON。
 */
async function handleResolve(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('url');

  if (!raw) {
    throw new ApiError(400, 'missing_url', '缺少 url 参数', '用法：/api/resolve?url=<帖子链接>');
  }

  const result = await resolveUrl(raw);

  // ok 放在顶层，便于快捷指令用 videos.0.url 这样的短路径取值
  return json({ ok: true, ...result });
}

/**
 * 直接下载入口 —— 为快捷指令设计的单步跳转。
 *
 * 对 X：302 跳到视频直链。该 CDN 免 header 且 CORS 开放，
 *        快捷指令的「获取 URL 内容」会自动跟随跳转直接拿到视频。
 *
 * 对 TikTok：返回 409 而非静默失败 —— 其 CDN 要求 Referer 头，
 *        而 302 跳转无法携带自定义头，只能由调用方显式请求。
 */
async function handleDirect(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const raw = params.get('url');

  if (!raw) {
    throw new ApiError(400, 'missing_url', '缺少 url 参数', '用法：/api/direct?url=<帖子链接>');
  }

  // 用 Number() 而非 parseInt()：parseInt('1.9') 会静默截断成 1，
  // 让非法输入被当成合法值接受；Number('1.9') 得到 1.9，被下面的整数检查挡下。
  const indexRaw = params.get('i');
  const index = indexRaw === null || indexRaw === '' ? 0 : Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) {
    throw new ApiError(400, 'invalid_index', 'i 参数必须是非负整数', 'i=0 表示最高画质。');
  }

  const result = await resolveUrl(raw);
  const variant = result.videos[index];

  if (!variant) {
    throw new ApiError(
      404,
      'variant_not_found',
      `该帖子没有第 ${index} 个视频档位`,
      `可用档位：0 到 ${Math.max(0, result.videos.length - 1)}。`,
    );
  }

  // 需要附加请求头才能下载的平台（目前是 TikTok），
  // 302 跳转无法携带自定义头，因此明确报错并给出可操作指引。
  if (Object.keys(variant.downloadHeaders).length > 0) {
    const headerList = Object.entries(variant.downloadHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    return json(
      {
        ok: false,
        error: {
          code: 'headers_required',
          message: `${result.platform} 的视频直链需要附加请求头，无法用跳转下载`,
          hint:
            '请改用 /api/resolve 拿到 videos[].url，并在请求时手动添加以下请求头：\n' +
            headerList,
        },
        // 把这些信息结构化返回，快捷指令无需自行拼接
        video: {
          url: variant.url,
          headers: variant.downloadHeaders,
          label: variant.label,
        },
      },
      409,
    );
  }

  // 302 而非 301：直链带签名且会过期，不能被永久缓存。
  return Response.redirect(variant.url, 302);
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight();

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(
        {
          ok: false,
          error: { code: 'method_not_allowed', message: '只支持 GET 请求' },
        },
        405,
      );
    }

    try {
      switch (pathname) {
        case '/api/resolve':
          return await handleResolve(request);

        case '/api/direct':
          return await handleDirect(request);

        case '/api/health':
          return json({
            ok: true,
            status: 'healthy',
            platforms: ['twitter', 'instagram', 'tiktok'],
          });

        default:
          return json(
            {
              ok: false,
              error: {
                code: 'not_found',
                message: `未知接口: ${pathname}`,
                hint: '可用接口：/api/resolve、/api/direct、/api/health',
              },
            },
            404,
          );
      }
    } catch (err) {
      return errorResponse(err);
    }
  },
};
