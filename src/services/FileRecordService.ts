import { promises as fs } from 'fs'
import { join } from 'path'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { isUserWhitelisted } from '../utils'

// --- Interfaces ---
interface FileUploadInfo {
  fileName: string
  fileSendTime: string
  channelId: string
}

interface MessageRecord {
  content: string
  userId: string
}

// --- Constants ---
const FILE_RECORD_GROUPS = ['666546887', '978054335', '958853931'] as const
const RECORDING_DURATION = 24 * 60 * 60 * 1000 // 24 hours
const WHITELIST_REPLY_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const UPLOADER_MESSAGE_WINDOW = 5 * 60 * 1000 // 5 minutes
const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png']

// --- File Manager (Self-contained helper class) ---
class FileManager {
  private dataPath: string

  constructor(dataPath: string = './data/mcl-grouptool') {
    this.dataPath = dataPath
    this.ensureDataDirectory()
  }

  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.access(this.dataPath)
    } catch {
      await fs.mkdir(this.dataPath, { recursive: true })
    }
  }

  async getUniqueFileName(baseName: string, ext: string): Promise<string> {
    let name = baseName
    let count = 1
    let fileName = `${name}${ext}`
    // eslint-disable-next-line no-await-in-loop
    while (await this.fileExists(fileName)) {
      fileName = `${name}(${count})${ext}`
      count++
    }
    return fileName
  }

  async fileExists(fileName: string): Promise<boolean> {
    try {
      await fs.access(join(this.dataPath, fileName))
      return true
    } catch {
      return false
    }
  }

  async readFileRecord(fileName: string): Promise<{ upload: FileUploadInfo, messages: MessageRecord[] } | null> {
    try {
      const recordPath = join(this.dataPath, `${fileName}.json`)
      const data = await fs.readFile(recordPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async saveFileRecordUnique(fileName: string, upload: FileUploadInfo, messages: MessageRecord[] = []): Promise<string> {
    const ext = '.json'
    const base = fileName.replace(/\.json$/i, '')
    const uniqueName = await this.getUniqueFileName(base, ext)
    const recordPath = join(this.dataPath, uniqueName)
    const record = { upload, messages }
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), 'utf-8')
    return uniqueName.replace(/\.json$/i, '')
  }

  async addMessageToRecord(fileName: string, message: MessageRecord): Promise<void> {
    const existing = await this.readFileRecord(fileName)
    if (existing) {
      existing.messages.push(message)
      const recordPath = join(this.dataPath, `${fileName}.json`)
      await fs.writeFile(recordPath, JSON.stringify(existing, null, 2), 'utf-8')
    }
  }

  getFilePath(fileName: string): string {
    return join(this.dataPath, fileName)
  }
}

// --- Main Service Class ---
export class FileRecordService {
  private fileManager: FileManager
  private activeRecordings = new Map<string, {
    fileName: string
    uploaderUserId: string
    channelId: string
    startTime: number
    lastWhitelistReplyTime?: number
    timeout?: NodeJS.Timeout
    whitelistTimeout?: NodeJS.Timeout
  }>()

  private channelActiveFiles = new Map<string, Set<string>>()
  private whitelistMessageCache = new Map<string, {
    message: MessageRecord
    timestamp: number
    relatedFiles: string[]
  }>()

  private recentUploaderMessages = new Map<string, number>()

  constructor(private ctx: Context, private config: Config) {
    this.fileManager = new FileManager('./data/mcl-grouptool')
    setInterval(() => {
      this.cleanupExpiredCache()
      this.cleanupExpiredUploaderMessages()
    }, 60 * 1000)
  }

  /**
   * Handles incoming file elements to decide if they should be recorded.
   * This is the primary entry point for file processing.
   */
  public async handleFile(fileElement: any, session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return

    try {
      const fileName = fileElement.attrs.file || `file_${Date.now()}`
      const fileUrl = fileElement.attrs.src
      const fileSize = parseInt(fileElement.attrs['file-size'] || '0', 10)

      if (fileSize > 16 * 1024 * 1024) return
      if (!this.hasAllowedExtension(fileName)) return

      const ext = fileName.substring(fileName.lastIndexOf('.'))
      const base = fileName.substring(0, fileName.lastIndexOf('.'))

      for (const [oldFileName, recording] of this.activeRecordings) {
        if (recording.uploaderUserId === session.userId && recording.channelId === session.channelId) {
          if (recording.timeout) clearTimeout(recording.timeout)
          if (recording.whitelistTimeout) clearTimeout(recording.whitelistTimeout)
          this.activeRecordings.delete(oldFileName)
          this.recentUploaderMessages.delete(oldFileName)
          const channelFiles = this.channelActiveFiles.get(session.channelId)
          if (channelFiles) {
            channelFiles.delete(oldFileName)
            if (channelFiles.size === 0) {
              this.channelActiveFiles.delete(session.channelId)
            }
          }
        }
      }

      const uniqueFileName = await this.fileManager.getUniqueFileName(base, ext)
      const downloadResult = await this.downloadFile(fileUrl, uniqueFileName)
      if (!downloadResult) return

      const uploadInfo: FileUploadInfo = {
        fileName: uniqueFileName,
        fileSendTime: new Date().toISOString(),
        channelId: session.channelId,
      }
      const recordName = await this.fileManager.saveFileRecordUnique(base, uploadInfo)

      if (!this.channelActiveFiles.has(session.channelId)) {
        this.channelActiveFiles.set(session.channelId, new Set())
      }
      this.channelActiveFiles.get(session.channelId)!.add(recordName)

      const timeout = setTimeout(() => this.endRecordingSession(recordName, session.channelId), RECORDING_DURATION)

      this.activeRecordings.set(recordName, {
        fileName: recordName,
        uploaderUserId: session.userId,
        channelId: session.channelId,
        startTime: Date.now(),
        timeout,
      })
    } catch (error) {
      this.ctx.logger.warn('File download and recording initiation failed:', error)
    }
  }

  /**
   * Handles incoming messages to decide if they should be appended to an active recording.
   * This is the primary entry point for message processing.
   */
  public async handleMessage(session: Session): Promise<void> {
    const channelFiles = this.getActiveFilesInChannel(session.channelId)
    if (channelFiles.length === 0) return

    const isWhitelisted = isUserWhitelisted(session.userId, this.config)
    const repliedUserId = this.getRepliedUserId(session)

    const uploaderFiles = channelFiles.filter(fileName => this.activeRecordings.get(fileName)?.uploaderUserId === session.userId)

    if (uploaderFiles.length > 0) {
      // Logic for messages from the file uploader
      await this.processUploaderMessage(session, uploaderFiles, repliedUserId)
      return
    }

    if (isWhitelisted) {
      // Logic for messages from a whitelisted user
      await this.processWhitelistMessage(session, channelFiles, repliedUserId)
    }
  }

  // --- Private Methods for Core Logic ---

  private async processUploaderMessage(session: Session, uploaderFiles: string[], repliedUserId: string | null) {
    const atElements = session.elements?.filter(el => el.type === 'at') || []
    const atNonWhitelist = atElements.some(atEl => {
      const id = atEl.attrs?.id
      return id && !isUserWhitelisted(id, this.config)
    })

    if (repliedUserId && !isUserWhitelisted(repliedUserId, this.config)) {
      return // Do not record if uploader replies to or @s a non-whitelisted user
    }
    if (atNonWhitelist) return

    for (const fileName of uploaderFiles) {
      const recording = this.activeRecordings.get(fileName)
      if (!recording) continue

      this.recentUploaderMessages.set(fileName, Date.now())
      // eslint-disable-next-line no-await-in-loop
      await this.associateUnlinkedCacheMessages(fileName, session.channelId)

      try {
        // eslint-disable-next-line no-await-in-loop
        if (session.content) await this.recordText(fileName, session.content, session.userId)
        // eslint-disable-next-line no-await-in-loop
        if (Array.isArray(session.elements)) await this.recordImages(fileName, session.elements, session.userId)
      } catch (error) {
        this.ctx.logger.warn(`Failed to record uploader message to ${fileName}:`, error)
      }

      // eslint-disable-next-line no-await-in-loop
      await this.flushCachedMessagesForFile(fileName)
      if (recording.whitelistTimeout) {
        clearTimeout(recording.whitelistTimeout)
        recording.whitelistTimeout = undefined
      }
    }
  }

  private async processWhitelistMessage(session: Session, channelFiles: string[], repliedUserId: string | null) {
    const mentionedFiles: string[] = []
    for (const fileName of channelFiles) {
      const recording = this.activeRecordings.get(fileName)
      if (!recording) continue

      const atUploader = session.elements?.some(el => el.type === 'at' && el.attrs?.id === recording.uploaderUserId)
      const replyUploader = repliedUserId === recording.uploaderUserId

      if (atUploader || replyUploader) {
        mentionedFiles.push(fileName)
      }
    }

    if (mentionedFiles.length > 0) {
      // Case 1: Whitelist user directly @s or replies to uploader
      for (const fileName of mentionedFiles) {
        // eslint-disable-next-line no-await-in-loop
        await this.recordWhitelistDirectReply(session, fileName)
      }
      return
    }

    // Case 2: General whitelist message, cache it for potential later association
    const messageKey = this.getMessageKey(session)
    const activeFiles = this.getActiveFilesInChannel(session.channelId)
    if (activeFiles.length > 0) {
      const messageRecord: MessageRecord = { content: session.content || '', userId: session.userId }
      const recentActiveFiles = activeFiles.filter(fileName => this.isFileUploaderRecentlyActive(fileName))

      this.whitelistMessageCache.set(messageKey, {
        message: messageRecord,
        timestamp: Date.now(),
        relatedFiles: recentActiveFiles, // Associate if uploader was recent, otherwise relatedFiles is empty
      })
    }
  }

  private async recordWhitelistDirectReply(session: Session, fileName: string) {
    const recording = this.activeRecordings.get(fileName)
    if (!recording) return

    try {
      await this.recordText(fileName, session.content, session.userId)
      recording.lastWhitelistReplyTime = Date.now()

      if (recording.whitelistTimeout) clearTimeout(recording.whitelistTimeout)
      recording.whitelistTimeout = setTimeout(() => {
        this.endRecordingSession(fileName, session.channelId)
      }, WHITELIST_REPLY_TIMEOUT)
    } catch (error) {
      this.ctx.logger.warn(`Failed to record whitelist reply to ${fileName}:`, error)
    }
  }

  // --- Private Helper Methods ---

  private async recordText(fileName: string, content: string, userId: string): Promise<void> {
    if (!content?.trim()) return
    const messageRecord: MessageRecord = { content, userId }
    await this.fileManager.addMessageToRecord(fileName, messageRecord)
  }

  private async recordImages(fileName: string, elements: h[], userId: string): Promise<void> {
    for (const el of elements) {
      if (this.isAllowedImageElement(el)) {
        const imgUrl = el.attrs?.src
        const imgFileName = el.attrs?.file || `img_${Date.now()}.jpg`
        const ext = imgFileName.substring(imgFileName.lastIndexOf('.'))
        const base = imgFileName.substring(0, imgFileName.lastIndexOf('.'))

        // eslint-disable-next-line no-await-in-loop
        const uniqueImgFileName = await this.fileManager.getUniqueFileName(base, ext)
        // eslint-disable-next-line no-await-in-loop
        const downloadResult = await this.downloadFile(imgUrl, uniqueImgFileName)

        if (downloadResult) {
          const imgRecord: MessageRecord = { content: `[图片] ${uniqueImgFileName}`, userId }
          // eslint-disable-next-line no-await-in-loop
          await this.fileManager.addMessageToRecord(fileName, imgRecord)
        }
      }
    }
  }

  private endRecordingSession(recordName: string, channelId: string) {
    const recording = this.activeRecordings.get(recordName)
    if (recording) {
      if (recording.timeout) clearTimeout(recording.timeout)
      if (recording.whitelistTimeout) clearTimeout(recording.whitelistTimeout)
      this.activeRecordings.delete(recordName)
    }

    this.recentUploaderMessages.delete(recordName)

    const channelFiles = this.channelActiveFiles.get(channelId)
    if (channelFiles) {
      channelFiles.delete(recordName)
      if (channelFiles.size === 0) {
        this.channelActiveFiles.delete(channelId)
      }
    }

    const keysToDelete: string[] = []
    for (const [key, cache] of this.whitelistMessageCache) {
      cache.relatedFiles = cache.relatedFiles.filter(f => f !== recordName)
      if (cache.relatedFiles.length === 0 && (Date.now() - cache.timestamp > UPLOADER_MESSAGE_WINDOW)) {
        keysToDelete.push(key)
      }
    }
    keysToDelete.forEach(key => this.whitelistMessageCache.delete(key))
  }

  private isFileRecordAllowed(channelId: string): boolean {
    const baseGroups = FILE_RECORD_GROUPS as readonly string[]
    const additionalGroups = this.config.additionalGroups || []
    return [...baseGroups, ...additionalGroups].includes(channelId)
  }

  private hasAllowedExtension(fileName: string): boolean {
    if (!fileName.includes('.')) return false
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))
    return ALLOWED_EXTENSIONS.includes(ext)
  }

  private isAllowedImageElement(el: any): boolean {
    if (el.type !== 'img' || !el.attrs?.file) return false
    const fileName = el.attrs.file
    if (!fileName.includes('.')) return false
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))
    return ALLOWED_IMAGE_EXTENSIONS.includes(ext)
  }

  private async downloadFile(url: string, fileName: string): Promise<{ path: string, size: number } | null> {
    try {
      const response = await this.ctx.http.get(url, { responseType: 'arraybuffer' })
      const downloadPath = this.fileManager.getFilePath(fileName)
      await fs.writeFile(downloadPath, Buffer.from(response))
      return { path: downloadPath, size: response.byteLength }
    } catch (error) {
      this.ctx.logger.warn(`File download failed: ${fileName}`, error)
      return null
    }
  }

  private getRepliedUserId(session: Session): string | null {
    const quoteElement = session.elements?.find(el => el.type === 'quote')
    return quoteElement?.attrs?.id || null
  }

  private getMessageKey(session: Session): string {
    return `${session.channelId}_${session.userId}_${session.messageId || Date.now()}`
  }

  private getActiveFilesInChannel(channelId: string): string[] {
    return Array.from(this.channelActiveFiles.get(channelId) || [])
  }

  private isFileUploaderRecentlyActive(fileName: string): boolean {
    const lastMessageTime = this.recentUploaderMessages.get(fileName)
    return lastMessageTime ? (Date.now() - lastMessageTime) <= UPLOADER_MESSAGE_WINDOW : false
  }

  private async flushCachedMessagesForFile(fileName: string): Promise<void> {
    const relevantMessages: Array<{ key: string, cache: any }> = []
    for (const [key, cache] of this.whitelistMessageCache) {
      if (cache.relatedFiles.includes(fileName)) {
        relevantMessages.push({ key, cache })
      }
    }

    relevantMessages.sort((a, b) => a.cache.timestamp - b.cache.timestamp)

    for (const { key, cache } of relevantMessages) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.fileManager.addMessageToRecord(fileName, cache.message)
        cache.relatedFiles = cache.relatedFiles.filter(f => f !== fileName)
        if (cache.relatedFiles.length === 0) {
          this.whitelistMessageCache.delete(key)
        }
      } catch (error) {
        this.ctx.logger.warn('Failed to flush cached message to record:', error)
      }
    }
  }

  private async associateUnlinkedCacheMessages(fileName: string, channelId: string): Promise<void> {
    const now = Date.now()
    for (const [key, cache] of this.whitelistMessageCache) {
      if (key.startsWith(`${channelId}_`) && cache.relatedFiles.length === 0 && (now - cache.timestamp <= UPLOADER_MESSAGE_WINDOW)) {
        cache.relatedFiles.push(fileName)
      }
    }
  }

  // --- Private Cleanup Methods ---

  private cleanupExpiredCache(): void {
    const now = Date.now()
    const expiredKeys: string[] = []
    for (const [key, cache] of this.whitelistMessageCache) {
      if (now - cache.timestamp > UPLOADER_MESSAGE_WINDOW && cache.relatedFiles.length === 0) {
        expiredKeys.push(key)
      }
    }
    expiredKeys.forEach(key => this.whitelistMessageCache.delete(key))
  }

  private cleanupExpiredUploaderMessages(): void {
    const now = Date.now()
    const expiredFiles: string[] = []
    for (const [fileName, timestamp] of this.recentUploaderMessages) {
      if (now - timestamp > UPLOADER_MESSAGE_WINDOW) {
        expiredFiles.push(fileName)
      }
    }
    expiredFiles.forEach(fileName => this.recentUploaderMessages.delete(fileName))
  }
}
