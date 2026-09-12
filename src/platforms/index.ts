import { ApiError, type MediaResult, type PlatformResolver } from './types';
import { twitterResolver } from './twitter';
import { tiktokResolver } from './tiktok';
import { instagramResolver } from './instagram';

/**
 * 平台注册表。
 *
 * 顺序即匹配优先级 —— 各平台的域名互不重叠，因此顺序无实际影响。
 * 新增平台：实现 PlatformResolver，在这里加一项即可，
 * 路由层与前端都不需要改动。
 *
 * 注：Instagram 曾被短暂下架，原因是把一个「帖子不存在」的样本误判成
 *     「平台关闭了未登录访问」。复核后已恢复注册，详见 ./instagram.ts 顶部。
 */
export const RESOLVERS: readonly PlatformResolver[] = [
  twitterResolver,
  instagramResolver,
  tiktokResolver,
];

/**
 * 解析入口：识别链接属于哪个平台，并分派给对应的 resolver。
 */
export async function resolveUrl(rawUrl: string): Promise<MediaResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'invalid_url', '链接格式不正确', '请粘贴完整的 http(s) 链接。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_url', '只支持 http/https 链接');
  }

  for (const resolver of RESOLVERS) {
    const id = resolver.match(url);
    if (id === null) continue;

    return await resolver.resolve({ id, url, originalUrl: rawUrl });
  }

  const supported = RESOLVERS.map((r) => r.label).join('、');

  throw new ApiError(
    400,
    'unsupported_platform',
    '暂不支持这个平台',
    `目前支持：${supported}。请检查链接是否为对应平台的帖子地址。`,
  );
}
