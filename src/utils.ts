import { promises as fs } from 'fs'
import { parse } from 'path'
import { h, Session, Context } from 'koishi'
import { Config } from './index'

/**
 * @function ensureDirectoryExists
 * @description 确保文件所在的目录存在。如果目录不存在，则递归创建。
 * @param filePath 文件的完整路径。
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  await fs.mkdir(parse(filePath).dir, { recursive: true })
}

/**
 * @function loadJsonFile
 * @description 异步读取并解析一个 JSON 文件。如果文件不存在或解析失败，返回默认数据。
 * @param filePath 文件的完整路径。
 * @param defaultData 当文件不存在或发生错误时返回的默认数据。
 * @returns 解析后的数据或默认数据。
 */
export async function loadJsonFile<T>(filePath: string, defaultData: T): Promise<T> {
  try {
    await fs.access(filePath) // 检查文件是否存在
    const fileContent = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(fileContent) as T
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 文件不存在是正常情况，直接返回默认值
      return defaultData
    } else {
      // 其他错误（如JSON格式错误）则打印错误并返回默认值
      console.error(`加载 JSON 文件失败: ${filePath}`, error)
      return defaultData
    }
  }
}

/**
 * @function saveJsonFile
 * @description 将数据序列化为格式化的 JSON 字符串并异步写入文件。会自动创建不存在的目录。
 * @param filePath 文件的完整路径。
 * @param data 要写入的数据。
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
 * @function fileExists
 * @description 异步检查文件是否存在。
 * @param filePath 文件的完整路径。
 * @returns 如果文件存在，返回 true，否则返回 false。
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
 * @function deleteFile
 * @description 异步删除指定的文件。如果文件不存在，则静默处理。
 * @param filePath 文件的完整路径。
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    // 仅在发生非“文件不存在”的错误时打印日志
    if (error.code !== 'ENOENT') {
      console.error(`无法删除文件 ${filePath}:`, error)
    }
  }
}

/**
 * @function downloadFile
 * @description 从给定的 URL 下载文件并保存到本地指定路径。
 * @param ctx Koishi 上下文，用于发起 HTTP 请求。
 * @param url 文件下载地址。
 * @param filePath 保存到的完整本地路径。
 */
export async function downloadFile(ctx: Context, url: string, filePath: string): Promise<void> {
  try {
    await ensureDirectoryExists(filePath)
    const response = await ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    await fs.writeFile(filePath, Buffer.from(response))
  } catch (error) {
    ctx.logger.warn(`文件下载失败: ${filePath} (来源: ${url})`, error)
    throw error // 抛出错误，以便调用方可以进行处理（如回滚操作）
  }
}

/**
 * @function buildReplyElements
 * @description 根据配置构建统一格式的回复消息元素数组。
 * @param session 当前会话。
 * @param content 要发送的文本内容。
 * @param targetUserId 可选，要@的目标用户ID。
 * @param config 插件配置。
 * @returns 包含消息元素的数组。
 */
export const buildReplyElements = (session: Session, content: string, targetUserId?: string, config?: Config) => {
  const elements = []
  // 根据配置决定是否引用原消息
  if (config?.quote && session.messageId) elements.push(h('quote', { id: session.messageId }))

  if (targetUserId) {
    // 如果指定了目标用户，则@该用户
    elements.push(h('at', { id: targetUserId }), h('text', { content: ' ' }))
  } else if (config?.mention) {
    // 否则，根据配置决定是否@消息发送者
    elements.push(h('at', { id: session.userId }), h('text', { content: ' ' }))
  }
  elements.push(h.text(content))
  return elements
}

/**
 * @function isUserWhitelisted
 * @description 检查用户 ID 是否在白名单中。
 * @param userId 要检查的用户 ID。
 * @param config 插件配置。
 * @returns 如果用户在白名单中，返回 true，否则返回 false。
 */
export const isUserWhitelisted = (userId: string, config: Config): boolean => config.whitelist?.includes(userId) ?? false

// 定义关键词配置的接口，与 KeywordReplyService 内部一致
interface KeywordConfig {
  text: string
  reply: string
  regex?: string
}

/**
 * @function checkKeywords
 * @description 检查消息内容是否匹配关键词列表，并在匹配成功时发送回复。
 * @param content 要检查的文本内容（可以是消息文本或OCR结果）。
 * @param keywords 关键词配置数组。
 * @param session 当前会话。
 * @param config 插件配置。
 * @returns 如果成功匹配并发送了回复，返回 true，否则返回 false。
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
      // 其次匹配纯文本包含
      if (content.includes(kw.text)) {
        matched = true
      }
    }

    if (matched) {
      const replyContent = h.parse(kw.reply)
      const elements = buildReplyElements(session, '', undefined, config)
      elements.pop() // 移除 buildReplyElements 产生的空文本占位符
      elements.push(...replyContent) // 添加真正的回复内容
      await session.send(elements)
      return true // 匹配并发送后立即返回，不再检查其他关键词
    }
  }
  return false
}

/**
 * @function handleOCR
 * @description 调用机器人的 OCR 功能识别图片中的文字。
 * @param imageElement 消息中的图片元素。
 * @param session 当前会话。
 * @returns 识别出的文本字符串，如果失败或无结果则返回 null。
 */
export async function handleOCR(imageElement: any, session: Session): Promise<string | null> {
  try {
    // 检查机器人是否支持 OCR 功能
    if (typeof session.bot.internal?.ocrImage !== 'function') return null

    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) {
      // 将所有识别结果的文本拼接起来
      return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    }
    return null
  } catch (error) {
    session.platform && session.bot.ctx.logger.warn(`OCR 功能调用失败: ${error}`)
    return null
  }
}

/**
 * @function getTargetUserId
 * @description 从命令参数中解析出目标用户的 ID。支持 @某人 和纯数字 ID。
 * @param target 包含目标用户信息的字符串。
 * @returns 解析出的用户 ID 字符串，或 null。
 */
export function getTargetUserId(target: string): string | null {
  if (!target) return null
  // 尝试从 h 元素解析 @
  const atElement = h.select(h.parse(target), 'at')[0]
  if (atElement?.attrs?.id) {
    return atElement.attrs.id
  }
  // 尝试用正则表达式匹配数字 ID
  const match = target.match(/@?(\d+)/)
  if (match) {
    return match[1]
  }
  return null
}

/**
 * @function parseTarget
 * @description 解析目标字符串，返回 QQ 号或 null。支持 @某人 或直接提供 QQ 号。
 * @param target 包含目标用户信息的字符串。
 * @returns 解析出的用户 ID 字符串，或 null。
 */
export function parseTarget(target: string): string | null {
  if (!target) return null
  try {
    const at = h.select(h.parse(target), 'at')[0]?.attrs?.id
    if (at && !isNaN(Number(at))) return at
    const match = target.match(/(\d{5,11})/)?.[1]
    return match || null
  } catch {
    return null
  }
}

/**
 * @function parseDurationToSeconds
 * @description 解析时间字符串 (如 30, 10m, 2h, 1d) 并转换为秒。
 * @param durationStr 时间字符串。
 * @param defaultUnit 如果没有单位，默认使用什么单位。 'm' for minutes, 's' for seconds.
 * @returns 总秒数。
 */
export function parseDurationToSeconds(durationStr: string, defaultUnit: 'm' | 's' = 'm'): number {
  if (!durationStr) return 0
  // 如果是纯数字，按默认单位处理
  if (/^\d+$/.test(durationStr)) {
    const value = parseInt(durationStr, 10)
    return value * (defaultUnit === 'm' ? 60 : 1)
  }

  const regex = /(\d+)\s*(d|h|m|s)/gi
  let totalSeconds = 0
  let match

  while ((match = regex.exec(durationStr)) !== null) {
    const value = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    switch (unit) {
      case 'd':
        totalSeconds += value * 86400
        break
      case 'h':
        totalSeconds += value * 3600
        break
      case 'm':
        totalSeconds += value * 60
        break
      case 's':
        totalSeconds += value
        break
    }
  }

  return totalSeconds
}
