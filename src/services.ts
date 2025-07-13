import { promises as fs } from 'fs'
import { join } from 'path'
import { h } from 'koishi'

interface KeywordConfig {
  regex: string
  reply: string
}

interface Config {
  preventDup?: boolean
  mention?: boolean
  quote?: boolean
  fileReply?: boolean
  keywordReply?: boolean
  keywords?: KeywordConfig[]
  ocrKeywords?: KeywordConfig[]
  fwdKeywords?: { regex: string }[]
  enableForward?: boolean
  forwardTarget?: string
  whitelist?: string[]
  ocrReply?: boolean
  forwardOcr?: boolean
  fileRecord?: boolean
  additionalGroups?: string[]
}

interface FileReplyRecord {
  fileName: string
  replyContent: string
  fileSendTime: string
  replyTime: string
  replyUserId: string
  channelId: string
}

type LauncherName = 'hmcl' | 'pcl' | 'bakaxl'

const LAUNCHER_CONFIGS = {
  hmcl: {
    groupId: '666546887',
    groups: ['666546887', '633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'],
    pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i
  },
  pcl: {
    groupId: '978054335',
    groups: ['1028074835'],
    pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i
  },
  bakaxl: {
    groupId: '377521448',
    groups: ['480455628', '377521448'],
    pattern: /BakaXL-ErrorCan-\d{14}\.json$/i
  }
} as const

const FILE_RECORD_GROUPS = ['666546887', '978054335', '377521448'] as const

const messageCache = new Map<string, {
  timestamp: number
  messageId: string
  fileName?: string
  fileSendTime?: string
}>()
const CACHE_DURATION = 12 * 60 * 60 * 1000

const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']

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

export const isUserWhitelisted = (userId: string, config: Config) => config.whitelist?.includes(userId) ?? false

class FileManager {
  private dataPath: string
  private replyPath: string

  constructor(dataPath: string = './data/mcl-grouptool') {
    this.dataPath = dataPath
    this.replyPath = join(dataPath, 'mcl-grouptool-file-reply.json')
    this.ensureDataDirectory()
  }

  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.access(this.dataPath)
    } catch {
      await fs.mkdir(this.dataPath, { recursive: true })
    }
  }

  async readReplyRecords(): Promise<FileReplyRecord[]> {
    try {
      const data = await fs.readFile(this.replyPath, 'utf-8')
      return JSON.parse(data) || []
    } catch {
      return []
    }
  }

  async saveReplyRecord(record: FileReplyRecord): Promise<void> {
    const records = await this.readReplyRecords()
    records.push(record)
    await fs.writeFile(this.replyPath, JSON.stringify(records, null, 2), 'utf-8')
  }

  getFilePath(fileName: string): string {
    return join(this.dataPath, fileName)
  }
}

const fileManager = new FileManager()

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

function hasAllowedExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))
  return ALLOWED_EXTENSIONS.includes(ext)
}

function cleanExpiredCache(): void {
  const now = Date.now()
  for (const [key, value] of messageCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) messageCache.delete(key)
  }
}

function isFileRecordAllowed(channelId: string, config: Config): boolean {
  const baseGroups = FILE_RECORD_GROUPS as readonly string[]
  const additionalGroups = config.additionalGroups || []
  return [...baseGroups, ...additionalGroups].includes(channelId)
}

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
    messageCache.set(session.messageId, {
      timestamp: Date.now(),
      messageId: session.messageId,
      fileName,
      fileSendTime: new Date().toISOString()
    })
  } catch (error) {
    console.error('文件下载失败:', error)
  }
}

export async function handleReplyMessage(session: any, config: Config): Promise<void> {
  if (!session.quote?.id) return
  if (!isUserWhitelisted(session.userId, config)) return
  cleanExpiredCache()
  const cachedMessage = messageCache.get(session.quote.id)
  if (!cachedMessage || !cachedMessage.fileName) return
  try {
    const replyRecord: FileReplyRecord = {
      fileName: cachedMessage.fileName,
      replyContent: session.content || '',
      fileSendTime: cachedMessage.fileSendTime || '',
      replyTime: new Date().toISOString(),
      replyUserId: session.userId,
      channelId: session.channelId
    }
    await fileManager.saveReplyRecord(replyRecord)
  } catch (error) {
    console.error('保存回复消息失败:', error)
  }
}

export async function handleOCR(imageElement: any, session: any): Promise<string | null> {
  try {
    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    return null
  } catch (error) {
    return null
  }
}

export async function checkKeywords(content: string, keywords: KeywordConfig[], session: any, config: Config): Promise<boolean> {
  for (const kw of keywords) {
    if (kw.regex && new RegExp(kw.regex, 'i').test(content)) {
      await session.send(buildReplyElements(session, kw.reply, undefined, config))
      return true
    }
  }
  return false
}

export async function handleForward(session: any, config: Config): Promise<void> {
  if (!config.enableForward || !config.forwardTarget) return
  const { elements, content } = session
  if (config.fwdKeywords?.length && content && !config.fwdKeywords.some(kw =>
    kw.regex && new RegExp(kw.regex, 'i').test(content)
  )) return
  const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`
  const imageElement = elements?.find(el => el.type === 'img')
  if (imageElement && config.forwardOcr) {
    const ocrText = await handleOCR(imageElement, session)
    if (ocrText) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${ocrText}`)
  }
  if (content) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${content}`)
}

const pending = new Map<string, NodeJS.Timeout>()

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

export function getLauncherByChannel(channelId: string): LauncherName | null {
  return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
    (cfg.groups as readonly string[]).includes(channelId))?.[0] as LauncherName || null
}

export function detectLauncherFromFile(fileName: string): LauncherName | null {
  return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
    cfg.pattern.test(fileName))?.[0] as LauncherName || null
}
