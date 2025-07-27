import { h, Session } from 'koishi'
import { Config } from './index' // 假设 index.ts 在父目录

/**
 * 构建回复消息元素
 * @param session 会话对象
 * @param content 回复内容
 * @param targetUserId 目标用户ID
 * @param config 配置对象
 * @returns 消息元素数组
 */
export const buildReplyElements = (session: Session, content: string, targetUserId?: string, config?: Config) => {
  const elements = []
  if (config?.quote && session.messageId) elements.push(h('quote', { id: session.messageId }))
  if (targetUserId) {
    elements.push(h('at', { id: targetUserId }), h('text', { content: ' ' }))
  } else if (config?.mention) {
    elements.push(h('at', { id: session.userId }), h('text', { content: ' ' }))
  }
  elements.push(h('text', { content }))
  return elements
}

/**
 * 检查用户是否在白名单中
 * @param userId 用户ID
 * @param config 配置对象
 * @returns 是否在白名单中
 */
export const isUserWhitelisted = (userId: string, config: Config): boolean => config.whitelist?.includes(userId) ?? false

/**
 * 关键词配置接口
 */
interface KeywordConfig {
  /** 正则表达式 */
  regex: string
  /** 回复内容 */
  reply: string
}

/**
 * 检查关键词并发送回复
 * @param content 消息内容
 * @param keywords 关键词配置数组
 * @param session 会话对象
 * @param config 配置对象
 * @returns 是否匹配到关键词
 */
export async function checkKeywords(content: string, keywords: KeywordConfig[], session: Session, config: Config): Promise<boolean> {
  for (const kw of keywords) {
    if (kw.regex && new RegExp(kw.regex, 'i').test(content)) {
      await session.send(buildReplyElements(session, kw.reply, undefined, config))
      return true
    }
  }
  return false
}

/**
 * 处理OCR图片识别
 * @param imageElement 图片元素
 * @param session 会话对象
 * @returns OCR识别结果文本或null
 */
export async function handleOCR(imageElement: any, session: Session): Promise<string | null> {
  try {
    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    return null
  } catch (error) {
    return null
  }
}
