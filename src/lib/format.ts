/** 各平台共用的展示格式化。 */

/** 码率转人类可读文本。未知（0）返回空串，便于用 filter(Boolean) 拼接。 */
export function formatBitrate(bitrate: number): string {
  if (!bitrate) return '';
  return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
}
