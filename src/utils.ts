import { promises as fs } from 'fs'
import { parse } from 'path'
import { h, Session, Context } from 'koishi'
import { Config } from './index'

/**
 * 确保文件所在的目录存在。
 * @param filePath 文件的完整路径
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  await fs.mkdir(parse(filePath).dir, { recursive: true })
}

/**
 * 异步读取、解析并返回 JSON文件的内容。
 * @param filePath 文件的完整路径
 * @param defaultData 当文件不存在时，用于返回的默认数据
 * @returns 解析后的数据或默认数据
 */
export async function loadJsonFile<T>(filePath: string, defaultData: T): Promise<T> {
  try {
    await fs.access(filePath)
    const fileContent = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(fileContent) as T
  } catch (error) {
    if (error.code === 'ENOENT') {
      return defaultData
    } else {
      console.error(`加载 JSON 文件失败: ${filePath}`, error)
      return defaultData
    }
  }
}

/**
 * 将数据序列化为 JSON 并异步写入文件，自动创建不存在的目录。
 * @param filePath 文件的完整路径
 * @param data 要写入的数据
 */
export async function saveJsonFile(filePath: string, data: any): Promise<void> {
  try {
    await ensureDirectoryExists(filePath)
    await fs.writeFile(filePath, JSON.stringify(data, null, 2))
  } catch (error) {
    console.error(`保存 JSON 文件失败: ${filePath}`, error)
  }
}

/**
 * 检查文件是否存在
 * @param filePath 文件的完整路径
 * @returns 文件是否存在
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 删除指定的文件
 * @param filePath 文件的完整路径
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`无法删除文件 ${filePath}:`, error)
    }
  }
}

/**
 * 从 URL 下载文件并保存到本地
 * @param ctx Koishi 上下文
 * @param url 文件下载地址
 * @param filePath 保存到的完整路径
 */
export async function downloadFile(ctx: Context, url: string, filePath: string): Promise<void> {
  try {
    await ensureDirectoryExists(filePath)
    const response = await ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    await fs.writeFile(filePath, Buffer.from(response))
  } catch (error) {
    ctx.logger.warn(`文件下载失败: ${filePath} from ${url}`, error)
    throw error
  }
}

/**
 * 构建回复消息元素
 */
export const buildReplyElements = (session: Session, content: string, targetUserId?: string, config?: Config) => {
  const elements = []
  if (config?.quote && session.messageId) elements.push(h('quote', { id: session.messageId }))
  if (targetUserId) {
    elements.push(h('at', { id: targetUserId }), h('text', { content: ' ' }))
  } else if (config?.mention) {
    elements.push(h('at', { id: session.userId }), h('text', { content: ' ' }))
  }
  elements.push(h.text(content))
  return elements
}

/**
 * 检查用户是否在白名单中
 */
export const isUserWhitelisted = (userId: string, config: Config): boolean => config.whitelist?.includes(userId) ?? false

interface KeywordConfig {
  text: string
  reply: string
  regex?: string
}

/**
 * 检查关键词并发送回复
 */
export async function checkKeywords(content: string, keywords: KeywordConfig[], session: Session, config: Config): Promise<boolean> {
  for (const kw of keywords) {
    let matched = false
    // 优先匹配正则表达式
    if (kw.regex) {
      if (new RegExp(kw.regex, 'i').test(content)) {
        matched = true
      }
    } else {
      // 其次匹配纯文本
      if (content.includes(kw.text)) {
        matched = true
      }
    }

    if (matched) {
      const replyContent = h.parse(kw.reply)
      const elements = buildReplyElements(session, '', undefined, config)
      // Remove the empty text element placeholder before adding the real content
      elements.pop()
      elements.push(...replyContent)
      await session.send(elements)
      return true
    }
  }
  return false
}

/**
 * 处理OCR图片识别
 */
export async function handleOCR(imageElement: any, session: Session): Promise<string | null> {
  try {
    // 确保有 ocrImage 方法
    if (typeof session.bot.internal?.ocrImage !== 'function') return null

    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) {
      return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    }
    return null
  } catch (error) {
    session.platform && session.bot.ctx.logger.warn(`OCR 调用失败: ${error}`)
    return null
  }
}

/**
 * 从命令参数中解析目标用户 ID
 * @param target 可能包含@某人或纯用户ID的字符串
 * @returns 解析出的用户 ID 或 null
 */
export function getTargetUserId(target: string): string | null {
  if (!target) return null
  const atElement = h.select(h.parse(target), 'at')[0]
  if (atElement?.attrs?.id) {
    return atElement.attrs.id
  }
  const match = target.match(/@?(\d+)/)
  if (match) {
    return match[1]
  }
  return null
}
