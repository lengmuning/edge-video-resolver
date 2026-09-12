/**
 * X syndication 端点要求一个 token 参数。
 *
 * 实测发现：该参数只做「非空」校验，传任何非空字符串都能拿到数据
 * （传 "a" 或全空格均返回 200）。本函数实现的是官方页面实际使用的算法，
 * 保留它是为了行为与真实客户端一致，减少被风控的概率。
 *
 * 注意空字符串会返回 `{}`，所以 token 绝不能为空。
 */
export function syndicationToken(tweetId: string): string {
  const token = ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '');

  // 极少数 ID 可能算出空串，兜一个非空值。
  return token || 'x';
}
