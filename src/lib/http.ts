import { ApiError } from '../platforms/types';

/**
 * 本站是纯解析服务，所有响应都是 JSON，且允许任意来源调用
 * （快捷指令、第三方页面、curl 都需要）。因此统一开放 CORS。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      // 只缓存成功响应。
      //
      // 错误响应若带 max-age，浏览器与下游缓存会把一次上游瞬时报错
      // 钉住整整一分钟 —— 用户重试拿到的仍是同一个错误，看起来像服务挂了。
      //
      // 成功响应也只给 60 秒：CDN 直链带签名且有时效性，缓存太久的
      // 直链会失效。
      'cache-control': status < 400 ? 'public, max-age=60' : 'no-store',
    },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    // 带 cause 说明是上游异常被包装过的，日志里保留完整链路便于排查。
    // cause 只进日志，不返回给用户。
    if (err.cause) {
      console.error(`[${err.code}] ${err.message}`, err.cause);
    }
    return json(
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
        },
      },
      err.status,
    );
  }

  // 非预期错误：不把内部细节暴露给用户，但日志里留全量信息便于排查。
  console.error('未处理异常:', err);
  return json(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: '服务内部错误',
        hint: '请稍后重试。若持续出现，请检查链接是否有效。',
      },
    },
    500,
  );
}

/**
 * 带上限的文本读取，避免异常大响应打爆内存。
 *
 * 上限比较的是 **UTF-16 码元数**（`String.length`），不是字节数 ——
 * 对纯 ASCII 页面两者相等，含多字节字符时码元数会小于字节数。
 * 这里只用作「明显异常」的护栏，不作为精确的流量控制。
 */
export async function readTextCapped(res: Response, maxChars = 4_000_000): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxChars) {
    throw new ApiError(502, 'response_too_large', '目标返回内容过大');
  }

  const text = await res.text();
  if (text.length > maxChars) {
    throw new ApiError(502, 'response_too_large', '目标返回内容过大');
  }
  return text;
}
