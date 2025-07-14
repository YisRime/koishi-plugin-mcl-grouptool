import { promises as fs } from 'fs'
import { join } from 'path'
import { h } from 'koishi'

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
 * 插件配置接口
 */
interface Config {
  /** 延迟发送提示 */
  preventDup?: boolean
  /** 回复时@用户 */
  mention?: boolean
  /** 回复时引用消息 */
  quote?: boolean
  /** 启用报错指引 */
  fileReply?: boolean
  /** 启用关键词回复 */
  keywordReply?: boolean
  /** 关键词回复配置 */
  keywords?: KeywordConfig[]
  /** OCR关键词配置 */
  ocrKeywords?: KeywordConfig[]
  /** 转发关键词配置 */
  fwdKeywords?: { regex: string }[]
  /** 启用消息转发 */
  enableForward?: boolean
  /** 转发目标群 */
  forwardTarget?: string
  /** 白名单用户 */
  whitelist?: string[]
  /** 启用图片识别 */
  ocrReply?: boolean
  /** 转发图片识别 */
  forwardOcr?: boolean
  /** 启用报告记录 */
  fileRecord?: boolean
  /** 额外记录群组 */
  additionalGroups?: string[]
}

/**
 * 文件上传信息
 */
interface FileUploadInfo {
  /** 文件名 */
  fileName: string
  /** 上传时间 */
  fileSendTime: string
  /** 频道ID */
  channelId: string
}

/**
 * 消息记录
 */
interface MessageRecord {
  /** 消息内容 */
  content: string
  /** 发送者用户ID */
  userId: string
}

/**
 * 启动器类型
 */
type LauncherName = 'hmcl' | 'pcl' | 'bakaxl'

/**
 * 启动器配置
 */
const LAUNCHER_CONFIGS = {
  hmcl: {
    groupId: '666546887',
    groups: ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'],
    pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i
  },
  pcl: {
    groupId: '978054335',
    groups: ['1028074835'],
    pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i
  },
  bakaxl: {
    groupId: '958853931',
    groups: ['480455628', '377521448'],
    pattern: /BakaXL-ErrorCan-\d{14}\.json$/i
  }
} as const

/** 支持文件记录的群组 */
const FILE_RECORD_GROUPS = ['666546887', '978054335', '958853931'] as const

/** 活跃的记录会话 */
const activeRecordings = new Map<string, {
  fileName: string
  uploaderUserId: string
  startTime: number
  lastWhitelistReplyTime?: number
  timeout?: NodeJS.Timeout
  whitelistTimeout?: NodeJS.Timeout
}>()

/** 白名单用户消息缓存 */
const whitelistMessageCache = new Map<string, {
  message: MessageRecord
  timestamp: number
  uploaderIds: string[]  // 可能相关的上传者ID列表
}>()

/** 最近上传者消息时间记录 */
const recentUploaderMessages = new Map<string, number>() // uploaderUserId -> timestamp

/** 记录持续时间（4小时）- 最大记录时间 */
const RECORDING_DURATION = 4 * 60 * 60 * 1000

/** 白名单用户回复后的无响应超时时间（15分钟） */
const WHITELIST_REPLY_TIMEOUT = 15 * 60 * 1000

/** 上传者发言前后的记录窗口时间（2分钟） */
const UPLOADER_MESSAGE_WINDOW = 2 * 60 * 1000

/** 允许的文件扩展名 */
const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']

/**
 * 构建回复消息元素
 * @param session 会话对象
 * @param content 回复内容
 * @param targetUserId 目标用户ID
 * @param config 配置对象
 * @returns 消息元素数组
 */
export const buildReplyElements = (session: any, content: string, targetUserId?: string, config?: Config) => {
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
export const isUserWhitelisted = (userId: string, config: Config) => config.whitelist?.includes(userId) ?? false

/**
 * 文件管理器类
 */
class FileManager {
  private dataPath: string

  /**
   * 构造函数
   * @param dataPath 数据存储路径
   */
  constructor(dataPath: string = './data/mcl-grouptool') {
    this.dataPath = dataPath
    this.ensureDataDirectory()
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.access(this.dataPath)
    } catch {
      await fs.mkdir(this.dataPath, { recursive: true })
    }
  }

  /**
   * 读取文件记录
   * @param fileName 文件名
   * @returns 文件记录或null
   */
  async readFileRecord(fileName: string): Promise<{ upload: FileUploadInfo; messages: MessageRecord[] } | null> {
    try {
      const recordPath = join(this.dataPath, `${fileName}.json`)
      const data = await fs.readFile(recordPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  /**
   * 保存文件记录
   * @param fileName 文件名
   * @param upload 上传信息
   * @param messages 消息记录数组
   */
  async saveFileRecord(fileName: string, upload: FileUploadInfo, messages: MessageRecord[] = []): Promise<void> {
    const recordPath = join(this.dataPath, `${fileName}.json`)
    const record = { upload, messages }
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), 'utf-8')
  }

  /**
   * 添加消息到记录
   * @param fileName 文件名
   * @param message 消息记录
   */
  async addMessageToRecord(fileName: string, message: MessageRecord): Promise<void> {
    const existing = await this.readFileRecord(fileName)
    if (existing) {
      existing.messages.push(message)
      await this.saveFileRecord(fileName, existing.upload, existing.messages)
    }
  }

  /**
   * 获取文件路径
   * @param fileName 文件名
   * @returns 完整文件路径
   */
  getFilePath(fileName: string): string {
    return join(this.dataPath, fileName)
  }
}

/** 文件管理器实例 */
const fileManager = new FileManager()

/**
 * 下载文件到本地
 * @param url 文件URL
 * @param fileName 文件名
 * @returns 下载结果或null
 */
async function downloadFile(url: string, fileName: string): Promise<{ path: string; size: number } | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const buffer = await response.arrayBuffer()
    const downloadPath = fileManager.getFilePath(fileName)
    await fs.writeFile(downloadPath, Buffer.from(buffer))
    return { path: downloadPath, size: buffer.byteLength }
  } catch (error) {
    console.error(`下载文件失败: ${fileName}`, error)
    return null
  }
}

/**
 * 检查文件扩展名是否被允许
 * @param fileName 文件名
 * @returns 是否允许
 */
function hasAllowedExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))
  return ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * 检查频道是否允许文件记录
 * @param channelId 频道ID
 * @param config 配置对象
 * @returns 是否允许
 */
function isFileRecordAllowed(channelId: string, config: Config): boolean {
  const baseGroups = FILE_RECORD_GROUPS as readonly string[]
  const additionalGroups = config.additionalGroups || []
  return [...baseGroups, ...additionalGroups].includes(channelId)
}

/**
 * 处理文件下载和记录
 * @param fileElement 文件元素
 * @param session 会话对象
 * @param config 配置对象
 */
export async function handleFileDownload(fileElement: any, session: any, config: Config): Promise<void> {
  if (!isFileRecordAllowed(session.channelId, config)) return

  try {
    const fileName = fileElement.attrs.file || `file_${Date.now()}`
    const fileUrl = fileElement.attrs.src
    const fileSize = parseInt(fileElement.attrs['file-size'] || '0')
    if (fileSize > 16 * 1024 * 1024) return
    if (!hasAllowedExtension(fileName)) return
    const downloadResult = await downloadFile(fileUrl, fileName)
    if (!downloadResult) return

    // 停止之前的记录
    const existingRecording = activeRecordings.get(session.channelId)
    if (existingRecording?.timeout) clearTimeout(existingRecording.timeout)
    if (existingRecording?.whitelistTimeout) clearTimeout(existingRecording.whitelistTimeout)

    // 清理之前上传者的相关缓存
    if (existingRecording) {
      recentUploaderMessages.delete(existingRecording.uploaderUserId)
      // 清理相关的缓存消息
      const keysToDelete: string[] = []
      for (const [key, cache] of whitelistMessageCache) {
        if (cache.uploaderIds.includes(existingRecording.uploaderUserId)) {
          keysToDelete.push(key)
        }
      }
      keysToDelete.forEach(key => whitelistMessageCache.delete(key))
    }

    // 创建文件记录
    const uploadInfo: FileUploadInfo = {
      fileName,
      fileSendTime: new Date().toISOString(),
      channelId: session.channelId
    }
    await fileManager.saveFileRecord(fileName, uploadInfo)

    // 开始记录对话
    const timeout = setTimeout(() => {
      activeRecordings.delete(session.channelId)
      // 清理相关数据
      recentUploaderMessages.delete(session.userId)
      const keysToDelete: string[] = []
      for (const [key, cache] of whitelistMessageCache) {
        if (cache.uploaderIds.includes(session.userId)) {
          keysToDelete.push(key)
        }
      }
      keysToDelete.forEach(key => whitelistMessageCache.delete(key))
    }, RECORDING_DURATION)

    activeRecordings.set(session.channelId, {
      fileName,
      uploaderUserId: session.userId,
      startTime: Date.now(),
      timeout
    })
  } catch (error) {
    console.error('文件下载失败:', error)
  }
}

/**
 * 检查消息是否@了文件上传者
 * @param session 会话对象
 * @param uploaderUserId 上传者用户ID
 * @returns 是否@了文件上传者
 */
function checkIfMentionsUploader(session: any, uploaderUserId: string): boolean {
  // 检查消息中是否有@元素
  const atElements = session.elements?.filter(el => el.type === 'at') || []
  if (atElements.length === 0) return false

  // 检查是否@了文件上传者
  return atElements.some(atEl => atEl.attrs?.id === uploaderUserId)
}

/**
 * 检查消息是否回复了某个用户的消息
 * @param session 会话对象
 * @returns 是否有回复
 */
function hasReply(session: any): boolean {
  const quoteElement = session.elements?.find(el => el.type === 'quote')
  return !!quoteElement
}

/**
 * 清理过期的缓存消息
 */
function cleanupExpiredCache(): void {
  const now = Date.now()
  const expiredKeys: string[] = []

  for (const [key, cache] of whitelistMessageCache) {
    // 缓存消息超过2分钟就过期
    if (now - cache.timestamp > UPLOADER_MESSAGE_WINDOW) {
      expiredKeys.push(key)
    }
  }

  expiredKeys.forEach(key => whitelistMessageCache.delete(key))
}

/**
 * 获取消息的唯一标识符
 * @param session 会话对象
 * @returns 消息唯一标识符
 */
function getMessageKey(session: any): string {
  return `${session.channelId}_${session.userId}_${session.messageId || Date.now()}`
}

/**
 * 获取频道内所有活跃的上传者ID
 * @param channelId 频道ID
 * @returns 上传者ID数组
 */
function getActiveUploadersInChannel(channelId: string): string[] {
  const uploaders: string[] = []
  for (const [channel, recording] of activeRecordings) {
    if (channel === channelId) {
      uploaders.push(recording.uploaderUserId)
    }
  }
  return uploaders
}

/**
 * 检查上传者是否在窗口时间内有消息
 * @param uploaderUserId 上传者用户ID
 * @returns 是否在窗口时间内
 */
function isUploaderRecentlyActive(uploaderUserId: string): boolean {
  const lastMessageTime = recentUploaderMessages.get(uploaderUserId)
  if (!lastMessageTime) return false

  const now = Date.now()
  return (now - lastMessageTime) <= UPLOADER_MESSAGE_WINDOW
}

/**
 * 将缓存的白名单消息添加到文件记录
 * @param uploaderUserId 上传者用户ID
 * @param channelId 频道ID
 */
async function flushCachedMessagesForUploader(uploaderUserId: string, channelId: string): Promise<void> {
  const recording = activeRecordings.get(channelId)
  if (!recording || recording.uploaderUserId !== uploaderUserId) return

  // 找到所有相关的缓存消息
  const relevantMessages: Array<{ key: string; cache: any }> = []

  for (const [key, cache] of whitelistMessageCache) {
    if (cache.uploaderIds.includes(uploaderUserId)) {
      relevantMessages.push({ key, cache })
    }
  }

  // 按时间戳排序
  relevantMessages.sort((a, b) => a.cache.timestamp - b.cache.timestamp)

  // 将消息添加到文件记录
  for (const { key, cache } of relevantMessages) {
    try {
      await fileManager.addMessageToRecord(recording.fileName, cache.message)
      whitelistMessageCache.delete(key) // 记录后从缓存中删除
    } catch (error) {
      console.error('添加缓存消息到记录失败:', error)
    }
  }
}

/**
 * 记录消息到文件
 * @param session 会话对象
 * @param config 配置对象
 */
export async function recordMessage(session: any, config: Config): Promise<void> {
  const recording = activeRecordings.get(session.channelId)
  if (!recording) return

  // 定期清理过期缓存
  cleanupExpiredCache()

  const isWhitelisted = isUserWhitelisted(session.userId, config)
  const isUploader = session.userId === recording.uploaderUserId
  const mentionsUploader = checkIfMentionsUploader(session, recording.uploaderUserId)
  const isReply = hasReply(session)

  // 如果是上传者的消息
  if (isUploader) {
    // 更新上传者最近消息时间
    recentUploaderMessages.set(recording.uploaderUserId, Date.now())

    // 立即记录上传者消息
    try {
      const messageRecord: MessageRecord = {
        content: session.content || '',
        userId: session.userId
      }
      await fileManager.addMessageToRecord(recording.fileName, messageRecord)
    } catch (error) {
      console.error('记录上传者消息失败:', error)
    }

    // 将相关的缓存白名单消息添加到记录
    await flushCachedMessagesForUploader(recording.uploaderUserId, session.channelId)

    // 上传者发言，重置白名单超时
    if (recording.whitelistTimeout) {
      clearTimeout(recording.whitelistTimeout)
      recording.whitelistTimeout = undefined
    }
    return
  }

  // 如果是白名单用户的消息
  if (isWhitelisted) {
    // 1. 白名单用户的回复与@上传者的消息 - 直接记录
    if (isReply || mentionsUploader) {
      try {
        const messageRecord: MessageRecord = {
          content: session.content || '',
          userId: session.userId
        }
        await fileManager.addMessageToRecord(recording.fileName, messageRecord)

        // 记录白名单用户回复时间，设置超时
        recording.lastWhitelistReplyTime = Date.now()
        if (recording.whitelistTimeout) clearTimeout(recording.whitelistTimeout)
        recording.whitelistTimeout = setTimeout(() => {
          activeRecordings.delete(session.channelId)
        }, WHITELIST_REPLY_TIMEOUT)
      } catch (error) {
        console.error('记录白名单回复消息失败:', error)
      }
      return
    }

    // 2. 白名单用户的其他消息 - 缓存处理
    const messageKey = getMessageKey(session)
    const activeUploaders = getActiveUploadersInChannel(session.channelId)

    if (activeUploaders.length > 0) {
      // 检查是否有上传者在2分钟内活跃
      const recentActiveUploaders = activeUploaders.filter(uploaderId =>
        isUploaderRecentlyActive(uploaderId)
      )

      if (recentActiveUploaders.length > 0) {
        // 如果有最近活跃的上传者，直接记录到第一个匹配的文件
        const targetUploader = recentActiveUploaders[0]
        const targetRecording = Array.from(activeRecordings.entries())
          .find(([channel, rec]) => channel === session.channelId && rec.uploaderUserId === targetUploader)?.[1]

        if (targetRecording) {
          try {
            const messageRecord: MessageRecord = {
              content: session.content || '',
              userId: session.userId
            }
            await fileManager.addMessageToRecord(targetRecording.fileName, messageRecord)
          } catch (error) {
            console.error('记录白名单消息失败:', error)
          }
        }
      } else {
        // 没有最近活跃的上传者，将消息加入缓存
        const messageRecord: MessageRecord = {
          content: session.content || '',
          userId: session.userId
        }

        whitelistMessageCache.set(messageKey, {
          message: messageRecord,
          timestamp: Date.now(),
          uploaderIds: activeUploaders // 记录所有可能相关的上传者
        })
      }
    }
  }
}

/**
 * 处理OCR图片识别
 * @param imageElement 图片元素
 * @param session 会话对象
 * @returns OCR识别结果文本或null
 */
export async function handleOCR(imageElement: any, session: any): Promise<string | null> {
  try {
    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    return null
  } catch (error) {
    return null
  }
}

/**
 * 检查关键词并发送回复
 * @param content 消息内容
 * @param keywords 关键词配置数组
 * @param session 会话对象
 * @param config 配置对象
 * @returns 是否匹配到关键词
 */
export async function checkKeywords(content: string, keywords: KeywordConfig[], session: any, config: Config): Promise<boolean> {
  for (const kw of keywords) {
    if (kw.regex && new RegExp(kw.regex, 'i').test(content)) {
      await session.send(buildReplyElements(session, kw.reply, undefined, config))
      return true
    }
  }
  return false
}

/**
 * 处理消息转发
 * @param session 会话对象
 * @param config 配置对象
 */
export async function handleForward(session: any, config: Config): Promise<void> {
  if (!config.enableForward || !config.forwardTarget) return
  const { elements, content } = session
  if (config.fwdKeywords?.length && content && !config.fwdKeywords.some(kw => kw.regex && new RegExp(kw.regex, 'i').test(content))) return
  const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`
  const imageElement = elements?.find(el => el.type === 'img')
  if (imageElement && config.forwardOcr) {
    const ocrText = await handleOCR(imageElement, session)
    if (ocrText) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${ocrText}`)
  }
  if (content) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${content}`)
}

/** 延迟发送消息的计时器映射 */
const pending = new Map<string, NodeJS.Timeout>()

/**
 * 处理启动器文件检测和回复
 * @param session 会话对象
 * @param launcher 当前群组的启动器类型
 * @param matched 文件匹配到的启动器类型
 * @param config 配置对象
 */
export async function handleLauncherFile(session: any, launcher: LauncherName, matched: LauncherName, config: Config): Promise<void> {
  const isCorrect = matched === launcher
  if (matched === 'bakaxl' && isCorrect) return
  const launcherConfig = LAUNCHER_CONFIGS[matched]
  const prefix = isCorrect ? '这里是' : '本群不解决其他启动器的报错问题，'
  const suffix = isCorrect ? '用户群，如果遇到' : '的'
  const msg = `${prefix} ${matched.toUpperCase()} ${suffix}游戏崩溃问题加这个群：${launcherConfig.groupId}`
  if (config.preventDup) {
    const timer = pending.get(session.channelId)
    if (timer) clearTimeout(timer)
    pending.set(session.channelId, setTimeout(async () => {
      await session.send(buildReplyElements(session, msg, undefined, config))
      pending.delete(session.channelId)
    }, 3000))
  } else {
    await session.send(buildReplyElements(session, msg, undefined, config))
  }
}

/**
 * 检查是否需要取消延迟发送
 * @param content 消息内容
 * @param channelId 频道ID
 */
export function checkCancelDelay(content: string, channelId: string): void {
  if (pending.has(channelId)) {
    const shouldCancel = Object.values(LAUNCHER_CONFIGS).some(cfg =>
      content.includes(cfg.groupId))
    if (shouldCancel) {
      const timer = pending.get(channelId)
      if (timer) {
        clearTimeout(timer)
        pending.delete(channelId)
      }
    }
  }
}

/**
 * 根据频道ID获取启动器类型
 * @param channelId 频道ID
 * @returns 启动器类型或null
 */
export function getLauncherByChannel(channelId: string): LauncherName | null {
  return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
    (cfg.groups as readonly string[]).includes(channelId))?.[0] as LauncherName || null
}

/**
 * 根据文件名检测启动器类型
 * @param fileName 文件名
 * @returns 启动器类型或null
 */
export function detectLauncherFromFile(fileName: string): LauncherName | null {
  return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
    cfg.pattern.test(fileName))?.[0] as LauncherName || null
}

// 定期清理过期缓存 - 每分钟执行一次
setInterval(() => {
  cleanupExpiredCache()

  // 清理过期的上传者消息时间记录
  const now = Date.now()
  const expiredUploaders: string[] = []

  for (const [uploaderId, timestamp] of recentUploaderMessages) {
    if (now - timestamp > UPLOADER_MESSAGE_WINDOW) {
      expiredUploaders.push(uploaderId)
    }
  }

  expiredUploaders.forEach(uploaderId => recentUploaderMessages.delete(uploaderId))
}, 60 * 1000)
